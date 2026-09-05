# 录制 / 播放前自定义昵称

- 入口：录制队列 → 开始录制，以及高级播放 → 自定义玩家昵称。
- 默认关闭；开启后按 Demo 分组读取双方名单。留空保持原名，支持重名。
- Unicode 原样传递，禁止控制字符和无效 Unicode；最长 32 个 UTF-16 单位、127 个 UTF-8 字节。一个补充平面表情通常占两个 UTF-16 单位。
- 仅修改本次临时 DEM 副本；SteamID64/XUID、槽位、装备身份不变。配置不写入全局录制预设。
- 同一 Demo 的队列片段共享一份副本；不同 Demo 单独配置。退出或录制失败后清理副本。
- 不需要注入，也不依赖开启 POV HUD。若开启定制 VPK，其数据从同一份改名副本生成。

## 实现与验证

`demo-player-aliases` 修改实际 CCSPlayerController 的 `m_iszPlayerName`、userinfo，以及结尾玩家名单消息中的名字。完整快照也会处理；共享 class baseline 不绑定任何玩家。userinfo / 结尾名单的非名字字段（包括未知 protobuf 字段）原字节保留。

后端在启动游戏前独立解析副本名单，检查所有 SteamID、队伍号和预期昵称；校验失败不启动游戏。

自动观战仍优先使用原始数字槽位和 SteamID 校验。旧录制请求若没有槽位，名称回退会引用普通昵称；含控制台特殊符号的昵称不会拼入命令，而是提示重新解析以获得槽位（不限制这些昵称在 Demo 中显示）。

2026-09-03 本机完整 10 人样本验证：中文、俄文、表情、重复昵称、空格、标点、长度边界；对比 1,350 条 tick 玩家状态和全部 178 次死亡、562 次受伤、3,168 次开火、25 次回合开始、24 次回合结束事件，除名字外一致。原 DEM 的 SHA-256 不变。

前端录制 / 高级播放实际组件已经本地浏览器排版验收。尚未替用户启动 CS2 验收游戏内所有昵称展示位置；这一步由用户安装后测试。

## 开发检查

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_player_aliases.py backend/tests/test_demo_playback_service.py backend/tests/test_demo_playback_api.py
cargo test --manifest-path tools/demo-cosmetic-rewriter/Cargo.toml --locked --lib player_aliases
```

前端运行 `npm.cmd test`。正常桌面打包自动编译并携带 `demo-player-aliases.exe`；安装版不需要 Rust、开发仓库或额外下载。
