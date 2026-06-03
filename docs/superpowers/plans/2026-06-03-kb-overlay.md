# 虚拟键盘 Overlay 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CS2 demo 录制时，将被观察玩家的虚拟键盘（10 键）作为 OBS Browser Source 实时合成进视频，不做任何后期处理。

**Architecture:** demoparser2 在规划阶段提取逐 tick 按键状态（`kb_track`）存入 `RecordingSegment.metadata`；录制执行器在 4 个时序锚点通过 WebSocket 广播 load/resume/pause/end 消息；OBS Browser Source 加载 `keyboard.html`，按同一墙钟时钟驱动渲染，与画面同步录入。

**Tech Stack:** Python 3.12 / FastAPI / demoparser2 / asyncio WebSocket / vanilla JS (Browser Source)

---

## 文件清单

| 文件 | 操作 | 职责 |
|---|---|---|
| `backend/app/parser/input_track.py` | 新增 | demoparser2 提取 9 键逐 tick 状态 |
| `backend/app/recording/executor/kb_overlay_bus.py` | 新增 | 进程内 WS 广播单例 |
| `backend/app/recording/executor/overlay/keyboard.html` | 新增 | OBS Browser Source 渲染页 |
| `backend/app/env_utils.py` | 修改（~L399） | AppConfig 增加两个字段 |
| `backend/app/main.py` | 修改（~L327） | 条件注册 WS 端点 + 静态挂载 |
| `backend/app/obs_director.py` | 修改（~L3552） | build_plan 后注入 kb_track |
| `backend/app/recording/api.py` | 修改（~L364） | /execute 单段端点也注入 kb_track |
| `backend/app/recording/executor/recording_executor.py` | 修改（多处） | 4 个广播锚点 |
| `backend/tests/test_input_track.py` | 新增 | input_track 单元测试 |
| `backend/tests/test_kb_overlay_bus.py` | 新增 | kb_overlay_bus 单元测试 |

---

## Task 1: `input_track.py` — 按键状态提取模块

**Files:**
- Create: `backend/app/parser/input_track.py`
- Test: `backend/tests/test_input_track.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_input_track.py`：

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from app.parser.input_track import _resolve_col, _to_df, KEYS

def test_resolve_col_exact():
    df = pd.DataFrame({"buttons": [1], "name": ["x"]})
    assert _resolve_col(df, "buttons") == "buttons"

def test_resolve_col_case_insensitive():
    df = pd.DataFrame({"Buttons": [1]})
    assert _resolve_col(df, "buttons") == "Buttons"

def test_resolve_col_missing_returns_none():
    df = pd.DataFrame({"foo": [1]})
    assert _resolve_col(df, "buttons") is None

def test_to_df_passthrough():
    df = pd.DataFrame({"a": [1, 2]})
    result = _to_df(df)
    assert list(result["a"]) == [1, 2]

def test_to_df_empty_list():
    result = _to_df([])
    assert result.empty

def test_keys_constant():
    # 确认 KEYS 包含全部 10 个按键（9 键 + scope）
    assert set(KEYS) == {"W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope"}
```

- [ ] **Step 2: 运行测试确认失败**

```
python -m pytest backend/tests/test_input_track.py -v
```

预期：`ImportError: cannot import name '_resolve_col' from 'app.parser.input_track'`（模块不存在）

- [ ] **Step 3: 创建 `input_track.py`**

新建 `backend/app/parser/input_track.py`：

```python
from __future__ import annotations
import pandas as pd
from demoparser2 import DemoParser

TICK_RATE = 64

PROP_BUTTONS = "buttons"
PROP_WALK    = "is_walking"
PROP_SCOPE   = "is_scoped"
PROP_DUCKING = "ducking"
PROP_RELOAD  = "is_in_reload"

# CS2 默认按键位（已在 falcons-vs-legacy demo 标定确认）
BIT_ATTACK  = 0
BIT_JUMP    = 1
BIT_FWD     = 3
BIT_BACK    = 4
BIT_LEFT    = 9
BIT_RIGHT   = 10

KEYS = ("W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope")


def _resolve_col(df: pd.DataFrame, *candidates: str) -> str | None:
    cols = list(df.columns)
    for c in candidates:
        if c in cols:
            return c
    low = {c.lower(): c for c in cols}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


def _to_df(result) -> pd.DataFrame:
    if isinstance(result, pd.DataFrame):
        return result
    if hasattr(result, "to_pandas"):
        return result.to_pandas()
    return pd.DataFrame(result) if result else pd.DataFrame()


def extract_input_track(
    demo_path: str,
    *,
    steamid: str | int | None = None,
    player_name: str | None = None,
    start_tick: int,
    end_tick: int,
) -> list[dict]:
    """返回 [{tick, W,A,S,D,jump,crouch,walk,reload,fire,scope}, ...]（按 tick 升序）。

    steamid 为主键；缺失时用 player_name 兜底（存在 steamid 缺失的真实片段）。
    """
    parser = DemoParser(demo_path)
    ticks = list(range(int(start_tick), int(end_tick) + 1))
    df = _to_df(parser.parse_ticks(
        [PROP_BUTTONS, PROP_WALK, PROP_SCOPE, PROP_DUCKING, PROP_RELOAD, "name", "steamid"],
        ticks=ticks,
    ))
    if df.empty:
        return []

    c_mask   = _resolve_col(df, PROP_BUTTONS, "m_nButtonDownMaskPrev")
    c_walk   = _resolve_col(df, PROP_WALK,    "m_bIsWalking")
    c_scope  = _resolve_col(df, PROP_SCOPE,   "m_bIsScoped")
    c_duck   = _resolve_col(df, PROP_DUCKING, "m_bDucking", "in_crouch")
    c_reload = _resolve_col(df, PROP_RELOAD,  "m_bInReload")
    c_name   = _resolve_col(df, "name")
    c_sid    = _resolve_col(df, "steamid")

    if c_mask is None:
        raise RuntimeError("按键掩码列缺失：检查 demoparser2 版本的 'buttons' 别名")

    sel = pd.Series(False, index=df.index)
    if steamid is not None and c_sid:
        sel |= df[c_sid].astype(str).str.strip() == str(steamid).strip()
    if not sel.any() and player_name and c_name:
        sel |= df[c_name].astype(str).str.strip() == str(player_name).strip()
    pdf = df[sel]
    if pdf.empty:
        names = sorted(set(df[c_name].astype(str))) if c_name else []
        raise RuntimeError(
            f"片段内未匹配到玩家 sid={steamid} name={player_name!r}；在场={names}"
        )

    def b(mask: int, bit: int) -> bool:
        return bool((int(mask) >> bit) & 1)

    out = []
    for _, r in pdf.iterrows():
        m = int(pd.to_numeric(r.get(c_mask), errors="coerce") or 0)
        out.append({
            "tick":   int(r.get("tick", 0)),
            "W":      b(m, BIT_FWD),
            "A":      b(m, BIT_LEFT),
            "S":      b(m, BIT_BACK),
            "D":      b(m, BIT_RIGHT),
            "jump":   b(m, BIT_JUMP),
            "fire":   b(m, BIT_ATTACK),
            "crouch": bool(pd.to_numeric(r.get(c_duck),   errors="coerce") or 0) if c_duck   else False,
            "walk":   bool(pd.to_numeric(r.get(c_walk),   errors="coerce") or 0) if c_walk   else False,
            "reload": bool(pd.to_numeric(r.get(c_reload), errors="coerce") or 0) if c_reload else False,
            "scope":  bool(pd.to_numeric(r.get(c_scope),  errors="coerce") or 0) if c_scope  else False,
        })
    out.sort(key=lambda d: d["tick"])
    return out
```

- [ ] **Step 4: 运行测试确认通过**

```
python -m pytest backend/tests/test_input_track.py -v
```

预期：6 个测试全部 PASS

- [ ] **Step 5: Commit**

```
git add backend/app/parser/input_track.py backend/tests/test_input_track.py
git commit -m "feat(parser): add input_track.py — extract per-tick key states for kb overlay"
```

---

## Task 2: `kb_overlay_bus.py` — WebSocket 广播单例

**Files:**
- Create: `backend/app/recording/executor/kb_overlay_bus.py`
- Test: `backend/tests/test_kb_overlay_bus.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_kb_overlay_bus.py`：

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

# --- helpers ---
def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)

def make_ws():
    ws = MagicMock()
    ws.send_text = AsyncMock()
    return ws


def get_fresh_bus():
    """Import a fresh KbOverlayBus class (avoids module-level singleton state)."""
    import importlib
    import app.recording.executor.kb_overlay_bus as m
    importlib.reload(m)
    return m.KbOverlayBus()


def test_register_and_broadcast():
    bus = get_fresh_bus()
    ws = make_ws()
    run(bus.register(ws))
    run(bus.broadcast({"type": "resume"}))
    ws.send_text.assert_called_once_with('{"type": "resume"}')


def test_unregister_stops_messages():
    bus = get_fresh_bus()
    ws = make_ws()
    run(bus.register(ws))
    run(bus.unregister(ws))
    run(bus.broadcast({"type": "resume"}))
    ws.send_text.assert_not_called()


def test_load_replayed_on_reconnect():
    bus = get_fresh_bus()
    ws1 = make_ws()
    run(bus.register(ws1))
    load_msg = {"type": "load", "frames": [], "start_tick": 100, "end_tick": 200,
                "tick_rate": 64, "offset_ticks": 0}
    run(bus.broadcast(load_msg))

    ws2 = make_ws()
    run(bus.register(ws2))
    # ws2 should receive the replayed load immediately on register
    ws2.send_text.assert_called_once()
    sent = json.loads(ws2.send_text.call_args[0][0])
    assert sent["type"] == "load"
    assert sent["start_tick"] == 100


def test_dead_client_dropped_on_broadcast():
    bus = get_fresh_bus()
    ws_dead = make_ws()
    ws_dead.send_text = AsyncMock(side_effect=Exception("disconnected"))
    ws_live = make_ws()
    run(bus.register(ws_dead))
    run(bus.register(ws_live))
    run(bus.broadcast({"type": "pause"}))
    # live client received it; dead client silently removed
    ws_live.send_text.assert_called_once()
    # dead client no longer in bus (broadcast again — only live gets it)
    ws_live.send_text.reset_mock()
    run(bus.broadcast({"type": "end"}))
    ws_live.send_text.assert_called_once()
```

- [ ] **Step 2: 运行测试确认失败**

```
python -m pytest backend/tests/test_kb_overlay_bus.py -v
```

预期：`ModuleNotFoundError: No module named 'app.recording.executor.kb_overlay_bus'`

- [ ] **Step 3: 创建 `kb_overlay_bus.py`**

新建 `backend/app/recording/executor/kb_overlay_bus.py`：

```python
import asyncio
import json
import logging

logger = logging.getLogger(__name__)


class KbOverlayBus:
    def __init__(self) -> None:
        self._clients: set = set()
        self._lock = asyncio.Lock()
        self._last_load: dict | None = None

    async def register(self, ws) -> None:
        async with self._lock:
            self._clients.add(ws)
        if self._last_load is not None:
            try:
                await ws.send_text(json.dumps(self._last_load))
            except Exception:
                pass

    async def unregister(self, ws) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, msg: dict) -> None:
        if msg.get("type") == "load":
            self._last_load = msg
        data = json.dumps(msg)
        async with self._lock:
            dead = []
            for ws in self._clients:
                try:
                    await ws.send_text(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)


kb_overlay_bus = KbOverlayBus()
```

- [ ] **Step 4: 运行测试确认通过**

```
python -m pytest backend/tests/test_kb_overlay_bus.py -v
```

预期：4 个测试全部 PASS

- [ ] **Step 5: Commit**

```
git add backend/app/recording/executor/kb_overlay_bus.py backend/tests/test_kb_overlay_bus.py
git commit -m "feat(executor): add kb_overlay_bus — in-process WebSocket broadcast singleton"
```

---

## Task 3: `AppConfig` — 新增两个配置字段

**Files:**
- Modify: `backend/app/env_utils.py:399`（`AppConfig` 末尾，`match_count` 之后）

- [ ] **Step 1: 在 `AppConfig` 末尾添加两个字段**

在 `env_utils.py` 中找到 `AppConfig` 类的末尾（当前最后一行是 `match_count: int = 20`，约 L399），在其后添加：

```python
    # 虚拟键盘 overlay（OBS Browser Source 实时合成）
    kb_overlay_enabled: bool = False
    kb_overlay_tick_offset: int = 0   # 标定值：正=overlay超前需减，负=overlay滞后需加
```

修改后末尾应为：

```python
    match_count: int = 20         # 20 / 50 / 100
    # 虚拟键盘 overlay（OBS Browser Source 实时合成）
    kb_overlay_enabled: bool = False
    kb_overlay_tick_offset: int = 0   # 标定值：正=overlay超前需减，负=overlay滞后需加
```

- [ ] **Step 2: 验证 `AppConfig` 可以正常序列化新字段**

```
cd backend && python -c "
from app.env_utils import AppConfig
cfg = AppConfig()
print('kb_overlay_enabled:', cfg.kb_overlay_enabled)
print('kb_overlay_tick_offset:', cfg.kb_overlay_tick_offset)
d = cfg.model_dump()
assert 'kb_overlay_enabled' in d
assert 'kb_overlay_tick_offset' in d
print('OK')
"
```

预期输出：
```
kb_overlay_enabled: False
kb_overlay_tick_offset: 0
OK
```

- [ ] **Step 3: 运行基线测试确保没有回归**

```
python -m pytest backend/tests/ --ignore=backend/tests/test_demo_watcher_zip.py --ignore=backend/tests/test_detect_obs_path.py -q --tb=short
```

预期：全部通过（同基线 124 个）

- [ ] **Step 4: Commit**

```
git add backend/app/env_utils.py
git commit -m "feat(config): add kb_overlay_enabled and kb_overlay_tick_offset to AppConfig"
```

---

## Task 4: `keyboard.html` — OBS Browser Source 渲染页

**Files:**
- Create: `backend/app/recording/executor/overlay/keyboard.html`

- [ ] **Step 1: 创建目录并写入 HTML**

```
mkdir -p backend/app/recording/executor/overlay
```

新建 `backend/app/recording/executor/overlay/keyboard.html`（完整内容）：

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  #kb {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 33vh;
    display: flex;
    gap: 14px;
    align-items: flex-end;
    opacity: .92;
    font-family: Consolas, monospace;
  }
  .col { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; justify-content: center; }
  .key {
    height: 40px;
    border-radius: 6px;
    background: #2A2D34;
    border: 1px solid #3F434D;
    color: #8A8F99;
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background .04s, color .04s, box-shadow .04s;
  }
  .key.on {
    background: #E8B23A;
    color: #1A1A1A;
    border-color: #F5C85A;
    box-shadow: 0 0 7px rgba(232,178,58,.55);
  }
  .k44 { width: 40px; }
  .kw  { width: 144px; }
  .mouse {
    width: 60px;
    height: 92px;
    border: 1px solid #3F434D;
    border-radius: 30px 30px 14px 14px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #23262d;
  }
  .mtop { display: flex; height: 46px; border-bottom: 1px solid #3F434D; }
  .mbtn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: #8A8F99;
  }
  .mbtn.lb { border-right: 1px solid #3F434D; }
  .mbtn.on { background: #E8B23A; color: #1A1A1A; box-shadow: inset 0 0 8px rgba(232,178,58,.5); }
  .mbody { flex: 1; background: #2A2D34; }
  #kb.hidden { display: none; }
</style>
</head>
<body>
<div id="kb" class="hidden">
  <div class="col">
    <div class="row">
      <div class="key k44" data-k="W">W</div>
    </div>
    <div class="row">
      <div class="key k44" data-k="A">A</div>
      <div class="key k44" data-k="S">S</div>
      <div class="key k44" data-k="D">D</div>
    </div>
    <div class="row">
      <div class="key kw" data-k="jump">JUMP</div>
    </div>
    <div class="row">
      <div class="key k44" data-k="crouch">CTRL</div>
      <div class="key k44" data-k="walk">SHIFT</div>
      <div class="key k44" data-k="reload">R</div>
    </div>
  </div>
  <div class="mouse">
    <div class="mtop">
      <div class="mbtn lb" data-k="fire">L</div>
      <div class="mbtn rb" data-k="scope">R</div>
    </div>
    <div class="mbody"></div>
  </div>
</div>

<script>
const PORT = location.port || "8000";
const els = {};
document.querySelectorAll("[data-k]").forEach(e => els[e.dataset.k] = e);
const kb = document.getElementById("kb");

let track = [], tickRate = 64, startTick = 0, offset = 0;
let byTick = new Map(), tickList = [];
let running = false, resumeAt = 0, activeMs = 0;

function loadTrack(msg) {
  track = msg.frames || [];
  tickRate = msg.tick_rate || 64;
  startTick = msg.start_tick || 0;
  offset = msg.offset_ticks || 0;
  byTick = new Map(track.map(f => [f.tick, f]));
  tickList = track.map(f => f.tick);
  activeMs = 0;
  running = false;
  kb.classList.remove("hidden");
  render(startTick);
}

function nearest(tick) {
  if (byTick.has(tick)) return byTick.get(tick);
  if (!tickList.length) return null;
  let lo = 0, hi = tickList.length - 1;
  if (tick <= tickList[0]) return track[0];
  if (tick >= tickList[hi]) return track[hi];
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tickList[m] < tick) lo = m + 1; else hi = m;
  }
  return track[lo];
}

function render(tick) {
  const f = nearest(tick) || {};
  for (const k in els) els[k].classList.toggle("on", !!f[k]);
}

function loop() {
  if (running) {
    const elapsedMs = activeMs + (performance.now() - resumeAt);
    render(startTick + offset + Math.round(elapsedMs / 1000 * tickRate));
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/kb-overlay`);
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if      (m.type === "load")   loadTrack(m);
    else if (m.type === "resume") { resumeAt = performance.now(); running = true; }
    else if (m.type === "pause")  { if (running) { activeMs += performance.now() - resumeAt; running = false; } }
    else if (m.type === "end")    { running = false; activeMs = 0; kb.classList.add("hidden"); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
</script>
</body>
</html>
```

- [ ] **Step 2: 验证文件存在且 HTML 语法无误**

```
python -c "
from pathlib import Path
p = Path('backend/app/recording/executor/overlay/keyboard.html')
assert p.exists(), f'not found: {p}'
content = p.read_text(encoding='utf-8')
assert 'bottom: 33vh' in content, 'missing bottom: 33vh'
assert 'translateX(-50%)' in content, 'missing horizontal center'
assert 'ws://127.0.0.1' in content, 'missing WS connect'
print('OK')
"
```

预期：`OK`

- [ ] **Step 3: Commit**

```
git add backend/app/recording/executor/overlay/keyboard.html
git commit -m "feat(overlay): add keyboard.html — OBS Browser Source render page"
```

---

## Task 5: `main.py` — 条件注册 WS 端点和静态挂载

**Files:**
- Modify: `backend/app/main.py:327`（`WEB_DIST_DIR` 挂载块之后，约 L327）

- [ ] **Step 1: 在 `main.py` 中找到插入点**

找到以下代码块（约 L320–328）：

```python
WEB_DIST_DIR = _resolve_web_dist_dir()
if WEB_DIST_DIR is not None:
    assets_dir = WEB_DIST_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="web-assets")
    logger.info("前端静态目录已启用: %s", WEB_DIST_DIR)
else:
    logger.warning("未找到前端静态目录（web/ 或 frontend/dist），仅提供 API 服务")
```

在这个块**之后**（L328 处）插入以下代码：

```python
# ── 虚拟键盘 overlay：仅在 kb_overlay_enabled=True 时注册 WS 端点和静态挂载 ─────
_kb_cfg = load_config()
if _kb_cfg.kb_overlay_enabled:
    from fastapi import WebSocket, WebSocketDisconnect
    from .recording.executor.kb_overlay_bus import kb_overlay_bus as _kb_overlay_bus

    _overlay_dir = Path(__file__).parent / "recording" / "executor" / "overlay"
    app.mount("/overlay", StaticFiles(directory=str(_overlay_dir)), name="kb-overlay-static")
    logger.info("虚拟键盘 overlay 已启用，Browser Source URL: http://127.0.0.1:<PORT>/overlay/keyboard.html")

    @app.websocket("/ws/kb-overlay")
    async def kb_overlay_ws(ws: WebSocket) -> None:
        await ws.accept()
        await _kb_overlay_bus.register(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await _kb_overlay_bus.unregister(ws)
```

- [ ] **Step 2: 验证 main.py 可正常导入（flag=False 时不报错）**

```
cd backend && python -c "import app.main; print('import OK')"
```

预期：`import OK`（无报错）

- [ ] **Step 3: 运行基线测试确认无回归**

```
python -m pytest backend/tests/ --ignore=backend/tests/test_demo_watcher_zip.py --ignore=backend/tests/test_detect_obs_path.py -q --tb=short
```

预期：全部通过

- [ ] **Step 4: Commit**

```
git add backend/app/main.py
git commit -m "feat(main): conditionally register /ws/kb-overlay and /overlay static mount"
```

---

## Task 6: `obs_director.py` 和 `api.py` — `build_plan` 后注入 `kb_track`

**Files:**
- Modify: `backend/app/obs_director.py:3552`（`build_plan` + 错误处理之后，voice_filter 块之前）
- Modify: `backend/app/recording/api.py:364`（`/execute` 端点中 `build_plan` 之后）

### 6a: obs_director.py（主录制队列路径）

- [ ] **Step 1: 在 `obs_director.py` 中找到插入点**

找到以下代码（约 L3552–3554），即 `build_plan` 的 `except Exception` 块结束后，`# ── voice_filter` 注释之前：

```python
                    except Exception as e:
                        logger.error("[RecordingV3] build_plan error: %s", e)
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": str(e), "segment_results": [], "warnings": [],
                        })
                        continue

                    # ── voice_filter: patch segment masks before execution ────────
```

在 `continue` 和 `# ── voice_filter` 之间插入：

```python
                    # ── kb_track: 为 overlay 填充逐 tick 按键状态 ────────────────
                    from .env_utils import load_config as _load_cfg
                    _kb_enabled_cfg = _load_cfg()
                    if _kb_enabled_cfg.kb_overlay_enabled:
                        from .parser.input_track import extract_input_track as _extract_kb
                        for _seg in plan.segments:
                            try:
                                _seg.metadata["kb_track"] = _extract_kb(
                                    plan.demo_path,
                                    steamid=_seg.target_steamid64,
                                    player_name=_seg.target_player_name,
                                    start_tick=_seg.start_tick,
                                    end_tick=_seg.end_tick,
                                )
                            except Exception as _kb_e:
                                logger.warning(
                                    "[RecordingV3] kb_track extraction failed seg=%d: %s",
                                    _seg.segment_index, _kb_e,
                                )
                                _seg.metadata["kb_track"] = []
```

### 6b: api.py（`/execute` 单段端点）

- [ ] **Step 2: 在 `api.py` 中找到插入点**

找到 `/execute` 端点（约 L357–370）：

```python
@router.post("/execute", response_model=dict)
async def execute_recording(dto: RecordingRequestDTO) -> dict:
    try:
        plan = build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    config = load_config()
```

在 `plan = build_plan(dto)` 之后、`config = load_config()` 之前插入（注意 `load_config` 已在文件顶部导入；`..parser` 是从 `recording/` 上溯一级到 `app/parser/`）：

```python
    # kb_track: 为 overlay 填充逐 tick 按键状态
    _kb_cfg = load_config()
    if _kb_cfg.kb_overlay_enabled:
        from ..parser.input_track import extract_input_track as _extract_kb
        for _seg in plan.segments:
            try:
                _seg.metadata["kb_track"] = _extract_kb(
                    plan.demo_path,
                    steamid=_seg.target_steamid64,
                    player_name=_seg.target_player_name,
                    start_tick=_seg.start_tick,
                    end_tick=_seg.end_tick,
                )
            except Exception as _kb_e:
                logger.warning(
                    "kb_track extraction failed seg=%d: %s", _seg.segment_index, _kb_e,
                )
                _seg.metadata["kb_track"] = []
```

- [ ] **Step 3: 验证两个文件可正常导入**

```
cd backend && python -c "import app.obs_director; import app.recording.api; print('OK')"
```

预期：`OK`

- [ ] **Step 4: 运行基线测试确认无回归**

```
python -m pytest backend/tests/ --ignore=backend/tests/test_demo_watcher_zip.py --ignore=backend/tests/test_detect_obs_path.py -q --tb=short
```

预期：全部通过

- [ ] **Step 5: Commit**

```
git add backend/app/obs_director.py backend/app/recording/api.py
git commit -m "feat(recording): inject kb_track into segment metadata after build_plan"
```

---

## Task 7: `recording_executor.py` — 4 个广播锚点

**Files:**
- Modify: `backend/app/recording/executor/recording_executor.py`（多处）

### 7a: 顶部添加 `_kb_bus()` helper

- [ ] **Step 1: 在文件顶部（`logger = ...` 之后，约 L19–20）添加 helper**

找到：
```python
logger = logging.getLogger(__name__)

# Seconds seeked before each segment's start_tick
PREPARE_PREROLL_SEC: float = 5.0
```

在 `logger = ...` 和 `PREPARE_PREROLL_SEC` 之间插入：

```python

def _kb_bus():
    """Return (bus, tick_offset) when kb_overlay_enabled, else (None, 0)."""
    try:
        from ...env_utils import load_config
        cfg = load_config()
        if cfg.kb_overlay_enabled:
            from .kb_overlay_bus import kb_overlay_bus
            return kb_overlay_bus, cfg.kb_overlay_tick_offset
    except Exception:
        pass
    return None, 0

```

### 7b: 锚点① — `load` 广播（segment 开始，最终 resume 之前）

- [ ] **Step 2: 在 `execute()` 中找到锚点①的位置**

找到（约 L613–619）：

```python
                await asyncio.sleep(0.35)
                logger.info("[RecordingV3] reached effective start_tick; starting OBS")

                # ── 4. Start or Resume OBS recording ────────────────────────
```

在 `logger.info("[RecordingV3] reached effective start_tick...")` 和 `# ── 4.` 注释之间插入：

```python
                # ── kb overlay: load ────────────────────────────────────────
                _bus, _tick_off = _kb_bus()
                if _bus:
                    await _bus.broadcast({
                        "type": "load",
                        "segment_index": segment.segment_index,
                        "start_tick": segment.start_tick,
                        "end_tick": segment.end_tick,
                        "tick_rate": plan.tick_rate,
                        "offset_ticks": _tick_off,
                        "frames": segment.metadata.get("kb_track", []),
                    })
```

### 7c: 锚点② — `resume` 广播（两条路径）

- [ ] **Step 3: 找到锚点②的插入位置**

找到 `self._obs_on_black = False` 的两处位置（分别是首段和后续段结束处），以及之后的 `if not resume_ok:` 检查（约 L660–663）：

```python
                    else:
                        resume_ok = await demo_resume_silent_strict()
                    self._obs_on_black = False

                # ── 5. Handle demo_resume_silent_strict failure ───────────────
                if not resume_ok:
```

在 `self._obs_on_black = False`（最后一个，约 L658）和 `# ── 5.` 注释之间插入：

```python
                # ── kb overlay: resume ──────────────────────────────────────
                if resume_ok:
                    _bus, _ = _kb_bus()
                    if _bus:
                        await _bus.broadcast({"type": "resume"})
```

### 7d: 锚点③④ — `pause` 和 `end` 广播

- [ ] **Step 4: 找到锚点③④的插入位置**

找到（约 L741–745）：

```python
                obs_stop_path = await self._stop_obs_and_console_pause(is_last=is_last)
                if is_last:
                    result.recording_stopped_at = time.time()
                    final_output_path = obs_stop_path
                    await asyncio.to_thread(self._obs.disconnect)
```

将这个块替换为：

```python
                obs_stop_path = await self._stop_obs_and_console_pause(is_last=is_last)
                if is_last:
                    result.recording_stopped_at = time.time()
                    final_output_path = obs_stop_path
                    await asyncio.to_thread(self._obs.disconnect)
                    # ── kb overlay: end ─────────────────────────────────────
                    _bus, _ = _kb_bus()
                    if _bus:
                        await _bus.broadcast({"type": "end"})
                else:
                    # ── kb overlay: pause ───────────────────────────────────
                    _bus, _ = _kb_bus()
                    if _bus:
                        await _bus.broadcast({"type": "pause"})
```

- [ ] **Step 5: 验证 recording_executor.py 可正常导入**

```
cd backend && python -c "import app.recording.executor.recording_executor; print('OK')"
```

预期：`OK`

- [ ] **Step 6: 运行全部测试确认无回归**

```
python -m pytest backend/tests/ --ignore=backend/tests/test_demo_watcher_zip.py --ignore=backend/tests/test_detect_obs_path.py -q --tb=short
```

预期：全部通过（新增 10 个测试，总计 ≥134）

- [ ] **Step 7: Commit**

```
git add backend/app/recording/executor/recording_executor.py
git commit -m "feat(executor): add 4 kb overlay broadcast anchors (load/resume/pause/end)"
```

---

## Task 8: 端到端验证步骤（手动）

本 task 不写代码，记录 OBS 配置和功能验证步骤。

- [ ] **Step 1: 启用功能 flag**

在 `cs2-insight.config.json` 中设置：
```json
{
  "kb_overlay_enabled": true,
  "kb_overlay_tick_offset": 0
}
```
然后重启后端。

- [ ] **Step 2: OBS 配置 Browser Source（一次性）**

1. 录制场景中添加 **Browser Source**
2. URL：`http://127.0.0.1:8000/overlay/keyboard.html`
3. 宽 `500`，高 `300`
4. 勾选"透明背景"（Allow Transparency）
5. 图层置于游戏画面源之上

- [ ] **Step 3: 浏览器直接验证渲染（无需 CS2）**

打开 `http://127.0.0.1:8000/overlay/keyboard.html`，确认：
- 页面加载成功，WS 连接建立（无 404）
- 此时键盘不显示（`hidden`）

在另一个终端发一条测试 load+resume：
```python
import asyncio, json
import websockets

async def test():
    async with websockets.connect("ws://127.0.0.1:8000/ws/kb-overlay") as ws:
        await ws.send(json.dumps({
            "type": "load",
            "segment_index": 0,
            "start_tick": 1000,
            "end_tick": 1100,
            "tick_rate": 64,
            "offset_ticks": 0,
            "frames": [{"tick": 1000, "W": True, "A": False, "S": False, "D": False,
                        "jump": False, "crouch": False, "walk": False,
                        "reload": False, "fire": True, "scope": False}]
        }))
        await asyncio.sleep(0.5)
        await ws.send(json.dumps({"type": "resume"}))
        await asyncio.sleep(2)
        await ws.send(json.dumps({"type": "end"}))

asyncio.run(test())
```

预期：浏览器页面中键盘出现，W 键和 L 键（fire）点亮，2 秒后键盘消失。

- [ ] **Step 4: 标定 `kb_overlay_tick_offset`**

1. 录制一段含开枪的片段（参考：`latto` demo，`fire` 应在 tick 16684–16700 附近点亮）
2. 逐帧看导出视频，找枪口闪光首帧对应的视频相对时间 `t_video`
3. 计算 `video_tick = start_tick + t_video × tick_rate`
4. 对比 overlay `fire` 点亮 tick（应为 16684 或接近）
5. `offset = video_tick - overlay_fire_tick`（正值则写正，负值写负）
6. 将 offset 写入配置，重启后端

