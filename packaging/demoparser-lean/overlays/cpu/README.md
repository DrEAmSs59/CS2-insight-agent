# DemoTracer CPU 移植

真源是 DemoTracer `21f6a9b` 的 parser 与 csgoproto，包含 `e4cb735..21f6a9b` 两轮 CPU 优化及其依赖。Insight 旧皮肤/usercmd 行为不作为覆盖真源的依据。没有 GPU/CUDA 代码。

`demotracer-21f6a9b.patch` 按现有顺序应用在 upstream v0.41.4、lean patch、sticker overlay 和 entity-vector-length patch 之后；它会用 DemoTracer 实现替换旧皮肤实现。补丁包括 Rust 源码、生成的 protobuf、Cargo 锁文件及回归测试。元数据中的 SHA256 由构建脚本检查。

## 实际调用链

Tauri 开发启动优先使用 `.venv/Scripts/python.exe`，桌面包使用 `python/python.exe`。二者通过 `demoparser2` 的 CPython 原生扩展调用 Rust。`setup-backend-dev.ps1` 更新这两个已有环境；启动校验同时检查 wheel 版本 `0.41.4+cs2insight10` 和原生方法返回的 `demotracer-21f6a9b-insight-cpu1`。

Insight 特有的烟雾/inferno 采集、烟雾体素解码和 Parquet 读写保留。SharedString 和不可变共享列表在 Python、事件和 Parquet 出口转换为原有类型。购买事件支持 DemoTracer 的完整武器皮肤对象。标量使用原有 f32 精度，输出至 Python 时精确提升为 f64；新增嵌套皮肤结构保留属性原始位。

`parse_ticks` 与 `write_replay_parquet` 使用行查询入口：

- 普通字段启用 DemoTracer 属性依赖投影。
- `NON_MULTITHREADABLE_PROPS` 与 `usercmd_*` 进入顺序通道，其余进入 fullpacket 并行通道；两路由 Rayon 并发执行。
- 两路复用一次 first pass 的 schema 与属性 ID，并遵守调用者实际 ticks/players 过滤。Insight 常用的采样查询无需先生成全量玩家行。
- 合并前逐行、逐类型核对 tick、entity ID、SteamID、round，检查非空和长度。任何缺列、重复属性 ID、解析失败或不对齐均回退完整顺序解析。
- 事件、烟雾、属性状态过滤等不适用行通道的请求保持完整解析路径。

`parse_ticks(..., _reference=True)` 是验证入口：关闭行通道和属性投影，使用完整 DemoTracer 解码；usercmd 请求强制顺序解析。这验证 Insight 的适配与合并，不是另一个独立实现的 parser。

## 构建与安装

在仓库根目录执行：

```powershell
./packaging/demoparser-lean/setup-backend-dev.ps1 -BuildFromSource
```

已有 pinned upstream 本地仓库时可以避免克隆：

```powershell
./packaging/demoparser-lean/setup-backend-dev.ps1 -BuildFromSource -SourceDir ./tmp/cpu-query-perf/upstream
```

也可使用已构建 wheel：

```powershell
./packaging/demoparser-lean/setup-backend-dev.ps1 -WheelPath ./dist/wheels/demoparser2-0.41.4+cs2insight10-cp312-cp312-win_amd64.whl
```

构建不依赖 DemoTracer 仓库仍在本机。公开仓库的 `pyproject.toml`/`uv.lock` 指向 GitHub pre-release 上的 `0.41.4+cs2insight10` wheel。新 checkout 用 `uv sync --frozen` 即可；本地重编后可用 `-WheelPath` 覆盖安装。发布 CI 在 `develop` 上构建并上传同一 pre-release tag。

## 可复现基准

用同一个构建脚本生成前后版本；baseline 仅加入与新版相同的粗粒度 native 计时边界：

```powershell
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe ./.venv/Scripts/python.exe -BenchmarkBaseline -OutputDir tmp/cpu-before
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe ./.venv/Scripts/python.exe -OutputDir dist/wheels
./packaging/demoparser-lean/benchmark-cpu.ps1 `
  -BeforeWheel ./tmp/cpu-before/demoparser2-0.41.4+cs2insight9-cp312-cp312-win_amd64.whl `
  -AfterWheel ./dist/wheels/demoparser2-0.41.4+cs2insight10-cp312-cp312-win_amd64.whl `
  -Demos @('path/to/faceit.dem.zst', 'path/to/cache.dem', 'path/to/anubis.dem')
```

两版参数均为 opt-level=3、fat LTO、codegen-units=1、debug=0、strip=symbols、默认 panic=unwind。每个变体/样本先完整预热一次，再 AB/BA/AB 三轮，独立进程加载指定 wheel；运行期不编译、不开 profiler。

基准采用项目的回放字段、32 FPS 采样函数、事件批量查询字段、战斗统计、位置、皮肤和烟雾接口。它是这些真实原生工作负载的固定套件，不代表完整应用启动或导出流程。`replay` 是与 Parquet 同字段的全量正确性对照，不应在应用合计中与 `parquet` 重复相加。

每次记录文件读取、外层 zstd 解压、解压后暂存写入、mmap 构造、native parse 和 Python 桥接/Parquet 导出残差。先读完整文件，因此这是预热文件缓存场景；DEM 内部消息解压仍包含在 native parse 中。残差也包含参数准备及 Rust 对象释放，不能称为纯 Parquet 编码时间。

计时结束后才遍历全部输出计算 SHA256：列名/事件名排序，行及嵌套列表保序，保留空值、整数和浮点二进制位。Parquet 同时检查全部 row group 读回结果和文件字节。每个变体须跨轮稳定，新版行查询须与完整 DemoTracer 路径一致；旧皮肤差异单列报告。

额外真实 DEM 回归：

```powershell
./.venv/Scripts/python.exe backend/scripts/verify_demoparser_cpu.py tmp/cpu-verification.json path/to/demo.dem
```

它覆盖完整 usercmd history/subtick、连续状态、皮肤、重复属性回退、玩家过滤、状态过滤及购买事件。Rust overlay 还带有实体生命周期/缓存失效、稀疏标量浮点位、共享列表和 delta 原子性回归测试。
