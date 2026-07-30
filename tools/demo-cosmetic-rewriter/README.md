# CS2 Demo Cosmetic Rewriter

独立的离线 CS2 `.dem` 饰品改写工具，不是 DemoTracer 功能，也不是运行时注入器。

支持已有饰品改写，也支持把原皮武器、默认刀和默认手套的完整 Econ 状态实体化。已有贴纸和挂件可按现有槽位改写；暂不新增贴纸槽或挂件。

## 构建与使用

```powershell
cargo build --release --manifest-path tools\demo-cosmetic-rewriter\Cargo.toml

tools\demo-cosmetic-rewriter\target\release\demo-cosmetic-rewriter.exe rewrite `
  --input input.dem `
  --output output.dem `
  --config tools\demo-cosmetic-rewriter\examples\all-features.json `
  --demoparser2-python .venv\Scripts\python.exe
```

示例配置：`examples/zont1x-t-loadout.json`、`examples/all-features.json`。

已有饰品使用 account ID + item ID high/low + entity kind/class 定位；原皮目标使用零 item ID，并以 `source_definition_index` 或玩家 Pawn 关系定位。`name_hint` 仅用于预检。`team` 用于确认目标曾在该阵营出现，实际改写覆盖其全部生命周期 handle。

## 写入与验证

- 单次 writer pass 同时替换已有字段，并在 `missing_fields.econ=materialize` 时补齐目标 Created delta 的完整 Econ、动态属性和视觉状态；不修改共享 baseline。
- writer 后修正并校验 `DEM_FileInfo`、`DEM_SpawnGroups` offsets 与 EOF。
- 输出先写临时文件，默认通过外层 header、demoparser2 的 header/player/skins/round_end 和 SHA-256 门禁后原子移动；`--deep-verify` 或独立 `verify` 命令再做较慢的 source2 前后逐快照比对。
- writer/verifier 使用 64 MiB 线程栈。

独立复验：

```powershell
tools\demo-cosmetic-rewriter\target\release\demo-cosmetic-verifier.exe `
  --original input.dem --rewritten output.dem `
  --config tools\demo-cosmetic-rewriter\examples\all-features.json `
  --demoparser2-python .venv\Scripts\python.exe `
  --expected-sha256 <sha256>
```

第三方来源、六个修改文件和许可证见 `THIRD_PARTY.md`。不得提交真实或生成的 demo、本机 Steam 路径和用户绝对路径。
