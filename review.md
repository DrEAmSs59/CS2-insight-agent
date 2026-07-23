# 最新代码审查结论（修复后）

## 结论

**当前工作区已完成本轮审查中确认有效的发布阻断项和低成本边界修复。自动化检查全部通过；合并建议为：完成下文唯一的 Windows 端到端人工验收后 `Approve`。**

本轮没有照搬原始 review 中的所有架构建议。动态端口、Windows Job Object、完整 source ownership 平台、逐字段 provenance、单图 FFmpeg compositor、optimistic concurrency 等属于后续架构优化，不是修复当前确定性缺陷所必需。

审查基线为 `develop@2261de8c01dadb94ccb2e3aaca825a5d322c52b5`，本结论针对该基线加当前工作区修复后的代码。

---

## 已修复的有效问题

| ID | 修复状态 | 当前处理 |
| --- | --- | --- |
| P0-01 Demo 扫描跨作用域清库 | 已修复 | 每条 watch 导入记录持久化 `watch_root`；按成功扫描的单个 root 事务清理；离线、无权限和扫描异常不推进清理；手动导入不受 watcher purge 影响。 |
| P0-02 Tauri 关闭时强杀后端 | 已修复 | 新增后端 graceful shutdown；先停止队列和 LiteCut 任务并等待资源释放；Tauri 最多等待 18 秒，超时才强杀并写 recovery marker。 |
| P1-01 固定端口身份冲突 | 已修复 | 启用 Tauri single-instance；每次启动生成 instance ID，后端 runtime-state 返回 PID/ID，桌面端校验身份后才进入 UI。固定端口暂时保留。 |
| P1-02 数据迁移误判与空间风险 | 已修复 | 只有合法配置、DB 或有效业务目录算已有数据；迁移前计算空间；任意旧目录原子改名保留；源数据始终不删除。 |
| P1-03 先卸载旧 Electron 再迁移 | 已修复 | 安装前仅检查进程；Tauri 安装和数据迁移校验成功后才卸载 Electron，之前任一步失败都保留可运行旧版。 |
| P1-05 已分析玩家被完整 roster 覆盖 | 已修复 | 只有没有 resolved/analyzed/cache/auto-target 时才回退完整 roster。 |
| P1-06 Demo 删除失败仍删 DB | 已修复 | `.dem` 和同名 `.zip` 先进入应用 quarantine；随后事务删除 DB；DB 失败自动恢复文件。 |
| P1-07 重新分析提前清空 last-known-good | 已修复 | 解析成功后才事务替换结果；解析或保存失败保留旧结果，并保证退出 `parsing` 状态。 |
| P1-08 ZIP 复用与稳定性判断不足 | 已修复 | 使用 CRC/内容判断，`.part` 写入后原子替换；稳定检查同时比较 size/mtime；处理 created/modified/moved。 |
| P1-09 多玩家 AI Director 身份错误 | 已修复 | 只按精确 Demo 路径查询，按目标 SteamID/玩家读取 `players[target]`；移除 basename 模糊命中。 |
| P1-12 CS2/OBS 操作可并发 | 已修复 | 录制 execute/queue、Demo 回放和 OBS 调优共用进程级 runtime session 互斥；single-instance 负责桌面跨实例入口。 |
| P1-13 OBS 猜测最新输出文件 | 已修复 | 只接受 OBS 返回的精确 output path；无法确认归属就失败，不再扫描、重命名“最新文件”。 |
| P1-14a 调优停录失败不重试 | 已修复 | stop 只有成功后才标记完成；异常收尾会重连并再次确认录制已停止。 |
| P1-16 LiteCut schema/导出校验不一致 | 已修复 | 保存、导入和两种导出统一经过 Pydantic normalization；尺寸、时间、速度、音量、裁剪、ID 和集合规模都有边界。 |
| P1-17 同轨 overlap 被静默串接 | 已修复 | API 与 composer 双层拒绝重叠，返回冲突 clip ID。 |
| P1-19 LiteCut 先删文件后删 DB | 已修复 | 项目、批量项目和素材删除都先 quarantine，再执行 DB 事务；失败恢复文件。 |
| P1-21 Release 不跑测试、Python 依赖漂移 | 已修复 | Release workflow 增加后端、前端、Cargo fmt/clippy/test；Python 使用固定 constraints，打包脚本强制应用。 |

---

## 一并完成的低成本边界修复

- 窗口默认/最小尺寸调整为 `1440×900 / 1100×700`，覆盖常见 1366/1440 宽度设备。
- 分析 workspace 增加 `algorithm_version`、`data_source`、`team_assignment_source` 和推导字段列表；UI 改称“Demo 解析与推导统计”。
- 雷达回放增加最多约 6000 帧的响应限制，原有 10 分钟上限仍保留。
- AI 锐评单次最多 32 个 clip，并限制并发；内部自动调用也只评审有界子集。
- 录制队列最多 100 项。
- LiteCut 最多 32 条轨道、32 个 overlay，clip/marker/keyframe 也有上限。
- LiteCut autosave promise 按 project ID 隔离；JSON/便携导入切换项目前会 flush，保存失败则中止切换。
- 删除文件统一保留带 manifest 的可恢复目录，不再直接不可逆删除。

---

## 原 review 中不需要作为本轮阻断项的建议

| 建议 | 处理结论 |
| --- | --- |
| 雷达解析需要接入隔离 worker | 不成立；当前已经在解析 worker 中执行。本轮只补响应规模上限。 |
| 每个分析字段改成 `{value, source, confidence}` | 过度设计；workspace 级算法版本、来源和 fallback 标志已经足够定位口径。 |
| 立即改动态端口 | 暂不需要；single-instance + instance ID 握手已解决错误连接和双开问题。 |
| 立即引入 Windows Job Object / 完整资源 lease | 暂不需要；graceful shutdown、有限超时、recovery marker 和统一互斥已覆盖当前故障。 |
| 立即把 overlay compositor 重写为单图 filter graph | 性能优化，不是正确性缺陷；先用 overlay 数量上限控制成本。 |
| 完整 optimistic concurrency | 单实例桌面产品暂不需要；按项目隔离 autosave 并在切换前 flush 已解决当前竞态。 |
| 不稳定 OBS 参数必须默认回滚 | 产品策略；当前需要保证 stop/恢复可靠并明确展示状态，不强制改变默认选择。 |

以下仍可作为非阻断 backlog：本地 API token/CSP/CORS 加固、SSE stale/reconnect 可观测性、首次编辑前 snapshot、废弃同步导出入口、跨午夜日志和 GPU/encoder probe 优化、单体模块拆分。

---

## 自动化验证结果

- 后端全量：`505 passed`
- 前端全量：`57 files / 431 tests passed`
- 前端生产构建：通过（Vite 3236 modules）
- Python 全模块 `compileall`：通过
- `git diff --check`：通过（只有仓库现有 CRLF 提示）

当前机器没有 Rust toolchain，因此没有在本机执行 Cargo/NSIS 构建；Release workflow 已新增并强制执行 `cargo fmt --check`、`cargo clippy --locked`、`cargo test --locked` 和最终 Windows bundle 流程。CI 仍必须通过后才能发版。

---

## 唯一需要人工验证的点

在真实 Windows + CS2 + OBS 环境执行一次“录制中关闭桌面应用”的端到端验收：

1. 先记录 CS2 用户配置及 POV `gameinfo.gi` 的 hash，启动一段真实 Demo 录制。
2. OBS 正在录制时直接关闭 Tauri 主窗口。
3. 确认 OBS 已停止且视频可播放，Python 后端已退出，没有由本次录制启动并遗留的 CS2/FFmpeg/虚拟键盘任务。
4. 确认 CS2 配置和 POV 文件 hash 恢复到关闭前；重新打开应用后无错误 recovery marker，Demo 分析和 LiteCut 项目仍可读取。

该场景通过、Release CI 全绿后，本轮 review 可正式判定为 `Approve`。
