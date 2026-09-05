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

## UserCmd 按键真源

`demo-input-hud-track` 是只读的 DEM 按键提取器。它直接解码
`svc_UserCmds -> CMsgServerUserCmd -> CCSGOUserCmdPB`，完整还原三组
button-state bit plane、上下沿、stateful codegen-delta subtick 列表和
`userinfo` player-slot 身份时间线；同时保留每次非零
`CBaseUserCmdPB.weaponselect` 请求，用于还原“请求选择哪一个武器实体”。
它不从坐标、速度或游戏事件猜按键，也不会把 weapon selection 请求误称为
数字键、滚轮或 `lastinv` 等不可从 DEM 区分的物理绑定。VPK 键盘会在实体
索引与 DEM 的 active-weapon handle 严格匹配后，按物品定义投影到常规槽位
标签 `1` 主武器、`2` 副武器、`3` 刀/装备、`4` 投掷物、`5` C4；这些标签
表达选择目标，不宣称玩家实际按下了对应数字键。`E`、`F` 与 `TAB` 分别直接
来自 `IN_USE`、`IN_LOOK_AT_WEAPON` 和 `IN_SCORE` 的 UserCmd 掩码；标签采用
常见绑定名称，但 DEM 真源只证明对应游戏语义，并不证明玩家的物理绑定。
鼠标轨迹直接来自同一 `CBaseUserCmdPB` 的 `mousedx`/`mousedy` 原始字段，
按 demo tick 汇总后映射为 yaw/pitch 方向的近期光流；它保留记录方向和相对
幅度，但不宣称知道玩家 DPI、灵敏度或操作系统鼠标加速设置。

```powershell
cargo run --release --manifest-path tools\demo-cosmetic-rewriter\Cargo.toml `
  --bin demo-input-hud-track -- `
  --input input.dem `
  --output tmp\input-track.json `
  --include-evidence
```

JSON 报告内含完整掩码目录、三平面状态码、subtick delta wire 语义、
weapon-selection 请求和值域统计。

## 玩家 HUD 只读审计（Probe 4A）

`demo-hud-audit` 不修改 Demo，也不生成 Demo 副本。它扫描
`CCSPlayerController`、Player Pawn 和 Observer Pawn 的 serializer 与真实
Created/Updated delta，输出：

- `ServerInfo.player_slot` / `is_hltv`；
- Controller 的名字、SteamID、派生 player slot、Pawn 与队伍映射；
- HUD 身份候选字段在 serializer 中是否存在；
- 字段是否真实出现在实体 delta 中，以及首个 Created 值和后续值变化；
- 目标玩家与 SourceTV/HLTV Controller（若存在）的字段对照。

```powershell
cargo run --release --manifest-path tools\demo-cosmetic-rewriter\Cargo.toml `
  --bin demo-hud-audit -- `
  --input input.dem `
  --output tmp\demo-hud-research\probe4a.json `
  --target-name donk
```

审计确认 Controller 字段存在后，可生成一次只修改一个字段的 Probe：

```powershell
cargo run --release --manifest-path tools\demo-cosmetic-rewriter\Cargo.toml `
  --bin demo-hud-controller-handle-probe -- `
  --input input.dem `
  --output tmp\demo-hud-research\probe4b1.dem `
  --expected-input-sha256 <sha256> `
  --local-controller-index 1 `
  --field m_hPawn `
  --value <target-player-pawn-handle>
```

该 Probe 保持 `ServerInfo.player_slot` 和 `is_hltv` 不变，不修改共享 baseline；
若目标 Controller 的 Created delta 缺少该字段，只在目标 Created delta 中补入它。
同一工具也支持 `m_iTeamNum`，用于在 Pawn handle Probe 成功触发本地 UI 后，
用单一增量变量验证能否绕过选边界面；`m_bPawnIsAlive` 接受 `0` 或 `1`，
用于继续区分选边状态和玩家/观战 HUD 状态。`m_iPawnHealth` 使用 `Unsigned32`，
可验证“存活但生命值为 0”的矛盾 Controller 状态是否仍会强制进入观战 HUD。

需要验证 Pawn 到本地 Controller 的反向绑定时，可额外传入
`--target-class CCSPlayerPawn`，并把 `--local-controller-index` 设为目标 Pawn 的实体索引。
该模式支持 `m_hController`、`m_hDefaultController` 和 `m_hOriginalController`。

`demo-usercmd-audit` 可快速统计 `svc_UserCmds` 的槽位和 FullPacket delta 基线。
当目标玩家槽位已有完整 UserCmd 链时，`demo-hud-serverinfo-probe` 可同时修改
`ServerInfo.player_slot` 与 `is_hltv`，用于验证非 HLTV 本地回放路径。

`demo-netmessage-audit` 对原始 Demo 做只读的完整 packet type 映射，并分别统计
直接 CS2 UserMessage、`svc_UserMessage` 包装消息、SetView、VoiceData、
ResetHud、StopSpectatorMode 与 KillCam。

`demo-drop-usercmds-probe` 只删除现有非 HLTV Probe 中的 `svc_UserCmds`，
并在输出落盘前校验输入 SHA-256 及已有的 `player_slot` / `is_hltv`，用于隔离
UserCmd delta 错误是否会连带破坏快照提交。

`demo-snapshot-audit` 对 `net_Tick` 和 `svc_PacketEntities` 做快速只读审计，
记录 `server_tick`、`delta_from`、FullPacket epoch、缺失基线及指定 tick
附近的逐帧样本。

`demo-packetentities-header-probe` 支持两个互斥的快照头部实验：
`strip-serialized-entities` 只删除 GOTV 辅助序列化字段；
`rebase-first-delta` 只把每个 FullPacket 后的首个增量标成新的非 delta 锚点。

`demo-full-anchor-probe` 会先应用每个 FullPacket 后的第一条实体 delta，
再把合并后的全部活动实体编码为真正的非 delta Created 集合。后续原始
delta 不变，因此每个 seek 区间只增加一个完整锚点。

`demo-full-window-probe` 会把开头指定 tick 窗口内的每条实体消息都物化为
独立完整快照，用于判断非 HLTV 本地客户端能否显示不依赖历史基线的连续画面。
