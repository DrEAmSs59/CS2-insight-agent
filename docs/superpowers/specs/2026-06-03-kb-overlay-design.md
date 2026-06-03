# 虚拟键盘 Overlay 设计文档（实时合成版）

**日期**: 2026-06-03  
**状态**: 已批准，待实现

---

## 1. 背景与目标

在 CS2 demo 录制时，将被观察玩家的虚拟键盘（W/A/S/D、跳、蹲、走、换弹、开火、开镜）作为 OBS Browser Source 与画面实时合成录入，彻底绕开后期合成的对齐难题。

**核心约束**（来自现有录制流程）：
- 不使用 HLAE，无法读取实时 demo tick
- 录制依赖「已知 start_tick + 墙钟」驱动，overlay 骑在同一时钟上
- 残留的固定偏移（resume 指令 → 首帧）通过 `kb_overlay_tick_offset` 常量标定一次后全局通用

---

## 2. 架构与数据流

```
[规划阶段]  recording/api.py — build_plan() 之后
    └─ extract_input_track(demo_path, steamid, player_name, start_tick, end_tick)
         └─ segment.metadata["kb_track"] = [{tick, W,A,S,D,jump,crouch,walk,reload,fire,scope}, ...]

[录制阶段]  recording_executor.py — 4 个广播锚点
    ├─ 段开始(spec完成后)   ──ws──▶  {type:"load",  start_tick, end_tick, tick_rate, offset_ticks, frames}
    ├─ demo_resume          ──ws──▶  {type:"resume"}   ← overlay 起表
    ├─ 段边界 demo_pause    ──ws──▶  {type:"pause"}    ← overlay 停表
    └─ 末段收尾             ──ws──▶  {type:"end"}      ← overlay 隐藏

[OBS]  Browser Source(keyboard.html)
    页面每帧: tick = start_tick + offset + 活动墙钟秒×tick_rate → 查 frames 渲染
    → OBS 合成 → 黑场转场自动覆盖 overlay
```

---

## 3. 新增 / 修改文件清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `backend/app/parser/input_track.py` | 新增 | demoparser2 提取逐 tick 9 键状态 |
| `backend/app/recording/executor/kb_overlay_bus.py` | 新增 | 进程内 WebSocket 广播单例 |
| `backend/app/recording/executor/overlay/keyboard.html` | 新增 | OBS Browser Source 渲染页 |
| `backend/app/env_utils.py` | 修改 | AppConfig 增加 `kb_overlay_enabled`、`kb_overlay_tick_offset` |
| `backend/app/main.py` | 修改 | 条件注册 `/ws/kb-overlay` 和 `/overlay` 静态挂载 |
| `backend/app/recording/api.py` | 修改 | `build_plan()` 后调用 `extract_input_track` 填充 `kb_track` |
| `backend/app/recording/executor/recording_executor.py` | 修改 | 4 个广播锚点 |

---

## 4. 详细设计

### 4.1 配置（`env_utils.py` → `AppConfig`）

```python
kb_overlay_enabled: bool = False
kb_overlay_tick_offset: int = 0   # 标定值：正=overlay超前需减，负则加
```

- `kb_overlay_enabled=False` 时：无 WS 端点、无静态挂载、不解析 kb_track、不广播。零运行时开销。
- 两字段通过现有 `/api/config` GET/POST 自动暴露，无需新增 API。
- 修改 flag 需重启后端（属于启动时配置）。

### 4.2 数据提取（`parser/input_track.py`）

精简版提取模块，不含标定/诊断代码（那些保留在桌面工具 `kb_input_extract.py`）。

**签名**：
```python
def extract_input_track(
    demo_path: str,
    *,
    steamid: str | int | None = None,
    player_name: str | None = None,
    start_tick: int,
    end_tick: int,
) -> list[dict]:
```

**已标定常量**（`falcons-vs-legacy` demo 验证，CS2 默认键位）：
- `BIT_ATTACK=0, BIT_JUMP=1, BIT_FWD=3, BIT_BACK=4, BIT_LEFT=9, BIT_RIGHT=10`
- 蹲/走/换弹/开镜直接读状态字段（`ducking`/`is_walking`/`is_in_reload`/`is_scoped`）

**匹配逻辑**：steamid 为主键，`player_name` 强制兜底（存在 steamid 缺失的真实片段）。

**错误处理**：若抛出异常，调用方 catch、log、写入空列表 `[]`，录制正常继续。

**调用位置**（`recording/api.py`，`build_plan()` 之后）：
```python
if cfg.kb_overlay_enabled:
    for seg in plan.segments:
        try:
            seg.metadata["kb_track"] = extract_input_track(
                plan.demo_path,
                steamid=seg.target_steamid64,
                player_name=seg.target_player_name,
                start_tick=seg.start_tick,
                end_tick=seg.end_tick,
            )
        except Exception as e:
            logger.warning("kb_track extraction failed for segment %d: %s", seg.segment_index, e)
            seg.metadata["kb_track"] = []
```

**运行时开销**：每段约 0.5–2s（demoparser2 读磁盘），内联执行，无子进程。

### 4.3 广播总线（`executor/kb_overlay_bus.py`）

进程内单例 `kb_overlay_bus = KbOverlayBus()`：

- `register(ws)`：加入客户端集合，立即补发最近一次 `load` 消息（Browser Source 重连恢复）
- `unregister(ws)`：移出集合
- `broadcast(msg: dict)`：JSON 序列化后发全部客户端，静默丢弃断线连接
- `asyncio.Lock` 保护客户端集合

### 4.4 FastAPI 集成（`main.py`）

严格门控——flag=False 时完全不注册，URL 返回 404：

```python
if cfg.kb_overlay_enabled:
    from .recording.executor.kb_overlay_bus import kb_overlay_bus
    overlay_dir = Path(__file__).parent / "recording/executor/overlay"
    app.mount("/overlay", StaticFiles(directory=str(overlay_dir)), name="overlay")

    @app.websocket("/ws/kb-overlay")
    async def kb_overlay_ws(ws: WebSocket):
        await ws.accept()
        await kb_overlay_bus.register(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await kb_overlay_bus.unregister(ws)
```

### 4.5 执行器接线（`recording_executor.py`）

顶部添加懒加载 helper，flag=False 时返回 `None`，调用方 `if bus:` 短路：

```python
def _kb_bus():
    from ...env_utils import load_config
    if load_config().kb_overlay_enabled:
        from .kb_overlay_bus import kb_overlay_bus
        return kb_overlay_bus
    return None
```

**4 个锚点**：

| # | 锚点位置 | 广播消息 |
|---|---|---|
| ① | spec 完成、最终 resume 之前 | `{type:"load", segment_index, start_tick, end_tick, tick_rate, offset_ticks, frames}` |
| ② | `demo_resume_silent_strict()` 成功后（首段 start + 后续段 resume 两处） | `{type:"resume"}` |
| ③ | `_stop_obs_and_console_pause()` 返回后（非末段） | `{type:"pause"}` |
| ④ | 末段 stop 后、整体收尾 | `{type:"end"}` |

广播调用模式：
```python
bus = _kb_bus()
if bus:
    await bus.broadcast({...})
```

### 4.6 渲染页（`overlay/keyboard.html`）

- 透明背景（`background: transparent`）
- **水平居中，垂直位置离底部约 1/3 屏高**：
  ```css
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 33vh;
  ```
- 键盘布局：W / ASD / JUMP 长条 / CTRL·SHIFT·R / 鼠标 L·R
- 按下：暖黄 `#E8B23A`；未按：深灰 `#2A2D34`
- 收到 `end` → `display:none`（不显示空键盘）
- 断线自动重连（1s 后），重连时 bus 补发最近 `load`
- `PORT` 从 `location.port` 读取，自动适配后端端口

**计时模型**：
```javascript
tick = start_tick + offset_ticks + Math.round(activeMs / 1000 * tick_rate)
```
`activeMs` 累计跨段活动时长，支持一个 clip 内多次 pause/resume。

---

## 5. OBS 配置（一次性手动操作）

1. 录制场景加 **Browser Source**：
   - URL：`http://127.0.0.1:8000/overlay/keyboard.html`
   - 宽 `500`、高 `300`
   - 勾选「透明背景」
   - 图层置于游戏画面源之上
2. 黑场转场自动覆盖 overlay，无需额外处理。

---

## 6. 标定 `kb_overlay_tick_offset`

1. 录一段含明确开枪的片段（参考：`latto` demo tick 16689 是 AK 击杀，`fire` 在 16684 起亮）
2. 逐帧看视频：找枪口闪光首帧对应的相对 tick
3. 与 overlay `fire` 点亮 tick 对比，差值即 offset
4. 写入配置，之后所有片段共用

---

## 7. 验收标准

- **提取层**：对 `latto/16433–16753` 跑 `extract_input_track`，断言 `fire` 在 16684–16700 连续点亮，16689 起 `crouch` 点亮，A/D 不同时为真
- **端到端**：导出视频里键盘在击杀前急停（A→D 切换）、扫射时 L 键亮、击杀帧 CTRL+L 亮，与画面逐帧吻合（标定后偏差 < 2 帧）
- **黑场**：段间转场时键盘与画面一起淡入淡出，无「键盘浮在黑屏」
- **多段 pause**：clip 内手动暂停再继续，键盘随 pause/resume 停走且不漂移
- **flag=False**：`/overlay/keyboard.html` 返回 404，`/ws/kb-overlay` 返回 404

---

## 8. 不在本次范围内

- 变速 / 升格播放支持
- 键盘样式自定义 UI
- 多玩家同时显示
- 后期合成路径
