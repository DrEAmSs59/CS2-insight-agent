# OBS 黑场 Fade 转场 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `recording/executor/` 路径的片段边界（StartRecord / 段间 jump-cut / StopRecord）加入 OBS 黑场 Fade 转场，失败时自动 fallback 到硬切。

**Architecture:** 新增独立 `OBSFadeController` 类（与 `OBSRecordingController` 平级），持有 `FadeConfig`，负责创建黑场 Scene 和执行场景切换；`RecordingExecutor` 组合两个 controller，在 3 处边界调用 fade；前端 `CommonParamsModal` 存全局默认值，`RecordWarmupModal` 逐次覆盖，两者均写入 `RecordingOptions`。

**Tech Stack:** Python 3.10+ / Pydantic v2 / obswebsocket（obs-websocket-py ≥1.0） / pytest + unittest.mock / React 19 / TailwindCSS 4

---

## File Map

| 文件 | 操作 | 说明 |
|---|---|---|
| `backend/app/env_utils.py` | 修改 | `AppConfig` 新增 5 个转场字段 |
| `backend/app/recording/models.py` | 修改 | `RecordingOptions` 新增 3 个 Optional 覆盖字段 |
| `backend/app/recording/executor/obs_client.py` | 修改 | 新增 7 个同步方法（场景/转场操作） |
| `backend/app/recording/executor/obs_fade_controller.py` | **新建** | `FadeConfig` dataclass + `OBSFadeController` |
| `backend/app/recording/executor/recording_executor.py` | 修改 | `__init__` 接收 `OBSFadeController`，3 处边界调用 fade |
| `backend/app/recording/api.py` | 修改 | `_resolve_fade_config()` + 构造并传入 `OBSFadeController` |
| `backend/tests/test_obs_fade_controller.py` | **新建** | `OBSFadeController` 单元测试 |
| `backend/tests/test_fade_config_resolve.py` | **新建** | `_resolve_fade_config` 单元测试 |
| `frontend/src/recording/recordingRequestFactory.js` | 修改 | `DEFAULT_RECORDING_OPTIONS` 新增 3 个 fade 字段 |
| `frontend/src/components/CommonParamsModal.jsx` | 修改 | 新增「OBS 转场效果」折叠区 |
| `frontend/src/components/RecordWarmupModal.jsx` | 修改 | 新增 per-recording fade 覆盖控件 |

---

## Task 1: AppConfig + RecordingOptions（配置层）

**Files:**
- Modify: `backend/app/env_utils.py`
- Modify: `backend/app/recording/models.py`
- Test: `backend/tests/test_fade_config_resolve.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_fade_config_resolve.py`：

```python
"""Tests for fade config field defaults and Optional merge logic."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.env_utils import AppConfig
from app.recording.models import RecordingOptions


def test_appconfig_defaults():
    cfg = AppConfig()
    assert cfg.obs_transition_enabled is False
    assert cfg.obs_transition_name == "Fade"
    assert cfg.obs_transition_duration_ms == 350
    assert cfg.obs_game_scene_name == "CS2 Insight Recording"
    assert cfg.obs_black_scene_name == "CS2 Insight Black"


def test_recording_options_defaults():
    opts = RecordingOptions()
    assert opts.obs_transition_enabled is None
    assert opts.obs_transition_name is None
    assert opts.obs_transition_duration_ms is None


def test_appconfig_custom():
    cfg = AppConfig(
        obs_transition_enabled=True,
        obs_transition_name="Swipe",
        obs_transition_duration_ms=500,
        obs_game_scene_name="MyGame",
        obs_black_scene_name="MyBlack",
    )
    assert cfg.obs_transition_enabled is True
    assert cfg.obs_transition_name == "Swipe"
    assert cfg.obs_transition_duration_ms == 500
    assert cfg.obs_game_scene_name == "MyGame"
    assert cfg.obs_black_scene_name == "MyBlack"


def test_recording_options_override():
    opts = RecordingOptions(
        obs_transition_enabled=True,
        obs_transition_name="Cut",
        obs_transition_duration_ms=200,
    )
    assert opts.obs_transition_enabled is True
    assert opts.obs_transition_name == "Cut"
    assert opts.obs_transition_duration_ms == 200
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
python -m pytest backend/tests/test_fade_config_resolve.py -v
```

期望：`AttributeError: 'AppConfig' object has no attribute 'obs_transition_enabled'`

- [ ] **Step 3: 在 `AppConfig` 里加 5 个字段**

打开 `backend/app/env_utils.py`，找到 `class AppConfig(BaseModel):` 中 `record_inject_console_lines: str = ""` 这行，在其**后面**追加：

```python
    obs_transition_enabled: bool = False
    obs_transition_name: str = "Fade"
    obs_transition_duration_ms: int = 350
    obs_game_scene_name: str = "CS2 Insight Recording"
    obs_black_scene_name: str = "CS2 Insight Black"
```

- [ ] **Step 4: 在 `RecordingOptions` 里加 3 个 Optional 字段**

打开 `backend/app/recording/models.py`，找到 `class RecordingOptions(BaseModel):` 中 `final_round_demo_exit_guard_sec: float = 1.5` 这行，在其**后面**追加：

```python
    obs_transition_enabled: Optional[bool] = None
    obs_transition_name: Optional[str] = None
    obs_transition_duration_ms: Optional[int] = None
```

确认文件顶部已有 `from typing import Any, Optional`（已有，无需再加）。

- [ ] **Step 5: 运行测试，确认通过**

```bash
python -m pytest backend/tests/test_fade_config_resolve.py -v
```

期望：4 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/env_utils.py backend/app/recording/models.py backend/tests/test_fade_config_resolve.py
git commit -m "feat: add OBS fade transition config fields to AppConfig and RecordingOptions"
```

---

## Task 2: OBSClient 新增同步方法

**Files:**
- Modify: `backend/app/recording/executor/obs_client.py`

- [ ] **Step 1: 在 `OBSClient` 的 `get_record_directory` 方法之后追加以下 7 个方法**

打开 `backend/app/recording/executor/obs_client.py`，在 `get_record_directory` 方法末尾（line ~192）和 `# Internal helpers` 注释（line ~197）之间插入：

```python
    # ------------------------------------------------------------------
    # Scene & transition control
    # ------------------------------------------------------------------

    def get_scene_names(self) -> list[str]:
        """GetSceneList → sorted list of scene names."""
        self._require_connected()
        try:
            resp = self._ws.call(obs_requests.GetSceneList())
            scenes = (getattr(resp, "datain", None) or {}).get("scenes") or []
            return [str(s.get("sceneName") or "") for s in scenes if isinstance(s, dict)]
        except Exception as exc:
            raise OBSRecordError(f"GetSceneList failed: {exc}") from exc

    def create_scene(self, scene_name: str) -> None:
        """CreateScene. Silently succeeds if the scene already exists."""
        self._require_connected()
        try:
            self._ws.call(obs_requests.CreateScene(sceneName=scene_name))
        except Exception as exc:
            raise OBSRecordError(f"CreateScene({scene_name!r}) failed: {exc}") from exc

    def set_current_program_scene(self, scene_name: str) -> None:
        """SetCurrentProgramScene — triggers the current OBS transition."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetCurrentProgramScene", None)
            if req is None:
                raise OBSRecordError("SetCurrentProgramScene not available in obs-websocket-py")
            self._ws.call(req(sceneName=scene_name))
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(f"SetCurrentProgramScene({scene_name!r}) failed: {exc}") from exc

    def set_current_scene_transition(self, name: str, duration_ms: int) -> None:
        """SetCurrentSceneTransition — sets the global OBS transition."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetCurrentSceneTransition", None)
            if req is None:
                raise OBSRecordError("SetCurrentSceneTransition not available in obs-websocket-py")
            self._ws.call(req(transitionName=name, transitionDuration=duration_ms))
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"SetCurrentSceneTransition({name!r}, {duration_ms}ms) failed: {exc}"
            ) from exc

    def get_scene_transition_list(self) -> list[str]:
        """GetSceneTransitionList → list of available transition names."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetSceneTransitionList", None)
            if req is None:
                return []
            resp = self._ws.call(req())
            transitions = (getattr(resp, "datain", None) or {}).get("transitions") or []
            return [str(t.get("transitionName") or "") for t in transitions if isinstance(t, dict)]
        except Exception as exc:
            logger.warning("GetSceneTransitionList failed: %s", exc)
            return []

    def scene_has_source(self, scene_name: str, source_name: str) -> bool:
        """Return True if scene already contains a source with source_name."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetSceneItemList", None)
            if req is None:
                return False
            resp = self._ws.call(req(sceneName=scene_name))
            items = (getattr(resp, "datain", None) or {}).get("sceneItems") or []
            return any(
                isinstance(it, dict) and str(it.get("sourceName") or "") == source_name
                for it in items
            )
        except Exception:
            return False

    def add_color_source_to_scene(
        self, scene_name: str, source_name: str, color: int = 0xFF000000
    ) -> None:
        """Create a Color Source in scene_name. color is ARGB int (default opaque black)."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "CreateInput", None)
            if req is None:
                raise OBSRecordError("CreateInput not available in obs-websocket-py")
            self._ws.call(
                req(
                    sceneName=scene_name,
                    inputName=source_name,
                    inputKind="color_source_v3",
                    inputSettings={"color": color, "width": 1920, "height": 1080},
                    sceneItemEnabled=True,
                )
            )
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"add_color_source_to_scene({scene_name!r}) failed: {exc}"
            ) from exc
```

- [ ] **Step 2: 验证语法**

```bash
python -c "from app.recording.executor.obs_client import OBSClient; print('OK')"
```

期望：`OK`（从 `backend/` 目录运行）。

- [ ] **Step 3: 运行现有测试，确认无破坏**

```bash
python -m pytest backend/tests/ -v
```

期望：所有已有测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add backend/app/recording/executor/obs_client.py
git commit -m "feat: add scene/transition sync methods to OBSClient"
```

---

## Task 3: OBSFadeController（新文件）

**Files:**
- Create: `backend/app/recording/executor/obs_fade_controller.py`
- Create: `backend/tests/test_obs_fade_controller.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_obs_fade_controller.py`：

```python
"""Unit tests for OBSFadeController."""
import asyncio
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock, patch, call
import pytest

from app.recording.executor.obs_fade_controller import OBSFadeController, FadeConfig
from app.env_utils import OBSConfig


def _make_config(enabled=True, name="Fade", duration_ms=350,
                 game="CS2 Insight Recording", black="CS2 Insight Black"):
    return FadeConfig(
        enabled=enabled,
        transition_name=name,
        duration_ms=duration_ms,
        game_scene_name=game,
        black_scene_name=black,
    )


def _make_obs_config():
    return OBSConfig(host="localhost", port=4455, password="")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# setup()
# ---------------------------------------------------------------------------

def test_setup_disabled_returns_false():
    cfg = _make_config(enabled=False)
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    result = _run(ctrl.setup())
    assert result is False
    assert ctrl.is_ready is False


def test_setup_creates_scenes_when_missing():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.return_value = []          # no scenes exist
    mock_client.get_scene_transition_list.return_value = ["Fade", "Cut"]
    mock_client.scene_has_source.return_value = False

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is True
    assert ctrl.is_ready is True
    # Both scenes must have been created
    create_calls = [c.args[0] for c in mock_client.create_scene.call_args_list]
    assert "CS2 Insight Recording" in create_calls
    assert "CS2 Insight Black" in create_calls


def test_setup_skips_create_for_existing_scenes():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.return_value = ["CS2 Insight Recording", "CS2 Insight Black"]
    mock_client.get_scene_transition_list.return_value = ["Fade"]
    mock_client.scene_has_source.return_value = True  # game capture already in scene

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is True
    mock_client.create_scene.assert_not_called()


def test_setup_fallback_on_exception():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.side_effect = RuntimeError("OBS unavailable")

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is False
    assert ctrl.is_ready is False


# ---------------------------------------------------------------------------
# fade_to_black() / fade_to_game()
# ---------------------------------------------------------------------------

def test_fade_to_black_not_ready_returns_true():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    # is_ready is False by default (setup not called)
    result = _run(ctrl.fade_to_black())
    assert result is True  # no-op, not an error


def test_fade_to_game_not_ready_returns_true():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    result = _run(ctrl.fade_to_game())
    assert result is True


def test_fade_to_black_calls_obs_and_sleeps():
    cfg = _make_config(duration_ms=100)
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True  # bypass setup

    mock_client = MagicMock()

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            with patch("asyncio.sleep") as mock_sleep:
                result = await ctrl.fade_to_black()
                mock_sleep.assert_called_once_with(0.1)
        return result

    result = _run(run())
    assert result is True
    mock_client.set_current_scene_transition.assert_called_once_with("Fade", 100)
    mock_client.set_current_program_scene.assert_called_once_with("CS2 Insight Black")


def test_fade_to_game_targets_game_scene():
    cfg = _make_config(duration_ms=200, game="MyGame")
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True

    mock_client = MagicMock()

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            with patch("asyncio.sleep"):
                return await ctrl.fade_to_game()

    result = _run(run())
    assert result is True
    mock_client.set_current_program_scene.assert_called_once_with("MyGame")


def test_fade_to_black_returns_false_on_exception():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True

    mock_client = MagicMock()
    mock_client.set_current_scene_transition.side_effect = RuntimeError("OBS error")

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            return await ctrl.fade_to_black()

    result = _run(run())
    assert result is False  # fallback, not exception
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
python -m pytest backend/tests/test_obs_fade_controller.py -v
```

期望：`ModuleNotFoundError: No module named 'app.recording.executor.obs_fade_controller'`

- [ ] **Step 3: 新建 `obs_fade_controller.py`**

新建 `backend/app/recording/executor/obs_fade_controller.py`：

```python
"""OBS black-scene fade transition controller.

Manages scene lifecycle (game scene + black scene) and fires fade-in/fade-out
transitions at segment boundaries.  Completely independent of OBSRecordingController
— never touches StartRecord / PauseRecord / ResumeRecord / StopRecord.

All public async methods are safe to call even when not ready (returns True as no-op).
All OBS failures are logged as warnings and return False — never raise.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from ...env_utils import OBSConfig
from .obs_client import OBSClient, OBSRecordError

logger = logging.getLogger(__name__)

_BLACK_COLOR_SOURCE_NAME = "CS2 Insight Black Source"
_GAME_CAPTURE_INPUT_NAME = "CS2 Insight Game Capture"
_GAME_CAPTURE_KIND = "game_capture"


@dataclass
class FadeConfig:
    enabled: bool
    transition_name: str
    duration_ms: int
    game_scene_name: str
    black_scene_name: str


class OBSFadeController:
    """Async-safe OBS scene fade controller.

    Call ``setup()`` once before recording starts.  Then call ``fade_to_black()``
    and ``fade_to_game()`` at segment boundaries.

    All methods use **fresh** OBS connections (same pattern as OBSRecordingController)
    to avoid stale-receive-thread issues on long-lived sessions.
    """

    def __init__(self, obs_config: OBSConfig, fade_config: FadeConfig) -> None:
        self._obs_config = obs_config
        self._cfg = fade_config
        self._ready = False

    @property
    def is_ready(self) -> bool:
        return self._ready

    def _new_client(self) -> OBSClient:
        return OBSClient(
            self._obs_config,
            handshake_timeout_sec=4.0,
            command_timeout_sec=5.0,
        )

    # ------------------------------------------------------------------
    # setup
    # ------------------------------------------------------------------

    async def setup(self) -> bool:
        """Ensure game scene + black scene exist in OBS.

        Returns True on success (fade transitions will be used).
        Returns False if disabled or any OBS call fails (hard-cut fallback).
        """
        if not self._cfg.enabled:
            logger.info("[OBSFade] transition disabled; running in hard-cut mode")
            return False

        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            ok = await asyncio.to_thread(self._setup_scenes, client)
            if ok:
                self._ready = True
                logger.info(
                    "[OBSFade] setup complete — game=%r black=%r transition=%r %dms",
                    self._cfg.game_scene_name,
                    self._cfg.black_scene_name,
                    self._cfg.transition_name,
                    self._cfg.duration_ms,
                )
            return ok
        except Exception as exc:
            logger.warning("[OBSFade] setup failed: %s", exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass

    def _setup_scenes(self, client: OBSClient) -> bool:
        """Synchronous scene setup — runs in executor thread."""
        try:
            existing = set(client.get_scene_names())
        except OBSRecordError as exc:
            logger.warning("[OBSFade] GetSceneList failed: %s", exc)
            return False

        # ── Game scene ──────────────────────────────────────────────────
        game = self._cfg.game_scene_name
        if game not in existing:
            try:
                client.create_scene(game)
                logger.info("[OBSFade] created game scene: %r", game)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] create game scene failed: %s", exc)
                return False

        if not client.scene_has_source(game, _GAME_CAPTURE_INPUT_NAME):
            try:
                client.ensure_game_capture_in_scene(game, _GAME_CAPTURE_INPUT_NAME)
            except Exception as exc:
                logger.warning("[OBSFade] ensure game capture failed: %s", exc)
                # non-fatal — scene exists but capture may need manual setup

        # ── Black scene ─────────────────────────────────────────────────
        black = self._cfg.black_scene_name
        if black not in existing:
            try:
                client.create_scene(black)
                logger.info("[OBSFade] created black scene: %r", black)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] create black scene failed: %s", exc)
                return False

        if not client.scene_has_source(black, _BLACK_COLOR_SOURCE_NAME):
            try:
                client.add_color_source_to_scene(
                    black, _BLACK_COLOR_SOURCE_NAME, color=0xFF000000
                )
                logger.info("[OBSFade] added black color source to %r", black)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] add black source failed (non-fatal): %s", exc)

        # ── Validate transition (warning only) ───────────────────────────
        available = client.get_scene_transition_list()
        if available and self._cfg.transition_name not in available:
            logger.warning(
                "[OBSFade] transition %r not in OBS list %s; will attempt anyway",
                self._cfg.transition_name, available,
            )

        return True

    # ------------------------------------------------------------------
    # fade_to_black / fade_to_game
    # ------------------------------------------------------------------

    async def fade_to_black(self) -> bool:
        """Switch to black scene with configured transition.  Records the fade-out.

        Returns True (no-op success) when not ready.
        Returns False on OBS error — caller should log warning and continue.
        """
        if not self._ready:
            return True
        return await self._do_fade(self._cfg.black_scene_name, direction="to_black")

    async def fade_to_game(self) -> bool:
        """Switch to game scene with configured transition.  Records the fade-in.

        Returns True (no-op success) when not ready.
        Returns False on OBS error — caller should log warning and continue.
        """
        if not self._ready:
            return True
        return await self._do_fade(self._cfg.game_scene_name, direction="to_game")

    async def _do_fade(self, target_scene: str, direction: str) -> bool:
        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            await asyncio.to_thread(
                client.set_current_scene_transition,
                self._cfg.transition_name,
                self._cfg.duration_ms,
            )
            await asyncio.to_thread(client.set_current_program_scene, target_scene)
            await asyncio.sleep(self._cfg.duration_ms / 1000.0)
            logger.debug("[OBSFade] %s complete (%dms)", direction, self._cfg.duration_ms)
            return True
        except Exception as exc:
            logger.warning("[OBSFade] %s failed: %s", direction, exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass
```

- [ ] **Step 4: 在 `OBSClient` 里追加 `ensure_game_capture_in_scene` 方法**

打开 `backend/app/recording/executor/obs_client.py`，在 `add_color_source_to_scene` 方法末尾（`# Internal helpers` 注释之前）追加：

```python
    def ensure_game_capture_in_scene(
        self, scene_name: str, capture_name: str, capture_kind: str = "game_capture"
    ) -> None:
        """Create a Game Capture input and link it to scene_name.

        Migrated from obs_director._obs_ensure_managed_game_capture.
        Raises OBSRecordError on failure.
        """
        self._require_connected()
        if self.scene_has_source(scene_name, capture_name):
            return  # already present — nothing to do

        # Check if the input already exists globally (just not in this scene).
        input_exists = False
        try:
            req = getattr(obs_requests, "GetInputList", None)
            if req is not None:
                resp = self._ws.call(req())
                inputs = (getattr(resp, "datain", None) or {}).get("inputs") or []
                input_exists = any(
                    isinstance(it, dict) and str(it.get("inputName") or "") == capture_name
                    for it in inputs
                )
        except Exception as exc:
            logger.warning("OBSClient: GetInputList failed: %s", exc)

        try:
            if input_exists:
                req = getattr(obs_requests, "CreateSceneItem", None)
                if req is None:
                    raise OBSRecordError("CreateSceneItem not available")
                self._ws.call(req(sceneName=scene_name, sourceName=capture_name))
            else:
                req = getattr(obs_requests, "CreateInput", None)
                if req is None:
                    raise OBSRecordError("CreateInput not available")
                self._ws.call(
                    req(
                        sceneName=scene_name,
                        inputName=capture_name,
                        inputKind=capture_kind,
                        inputSettings={},
                        sceneItemEnabled=True,
                    )
                )
            logger.info("OBSClient: game capture %r linked to scene %r", capture_name, scene_name)
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"ensure_game_capture_in_scene({scene_name!r}) failed: {exc}"
            ) from exc
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
python -m pytest backend/tests/test_obs_fade_controller.py -v
```

期望：11 个测试全部 PASS。

- [ ] **Step 6: 运行全量测试，确认无破坏**

```bash
python -m pytest backend/tests/ -v
```

期望：所有测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add backend/app/recording/executor/obs_fade_controller.py \
        backend/app/recording/executor/obs_client.py \
        backend/tests/test_obs_fade_controller.py
git commit -m "feat: add OBSFadeController with black-scene setup and fade transitions"
```

---

## Task 4: `_resolve_fade_config` + API 串联

**Files:**
- Modify: `backend/app/recording/api.py`
- Test: `backend/tests/test_fade_config_resolve.py`（追加）

- [ ] **Step 1: 追加合并逻辑的测试**

打开 `backend/tests/test_fade_config_resolve.py`，在文件末尾追加：

```python
# ---------------------------------------------------------------------------
# _resolve_fade_config merge logic
# ---------------------------------------------------------------------------

import importlib
import types


def _import_resolve():
    """Import _resolve_fade_config from api.py."""
    import app.recording.api as api_mod
    return api_mod._resolve_fade_config


def test_resolve_uses_appconfig_when_options_are_none():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=True, obs_transition_name="Swipe",
                    obs_transition_duration_ms=500)
    opts = RecordingOptions()  # all None
    fc = resolve(opts, cfg)
    assert fc.enabled is True
    assert fc.transition_name == "Swipe"
    assert fc.duration_ms == 500
    assert fc.game_scene_name == "CS2 Insight Recording"
    assert fc.black_scene_name == "CS2 Insight Black"


def test_resolve_options_override_appconfig():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=False, obs_transition_name="Fade",
                    obs_transition_duration_ms=350)
    opts = RecordingOptions(obs_transition_enabled=True,
                            obs_transition_name="Cut",
                            obs_transition_duration_ms=100)
    fc = resolve(opts, cfg)
    assert fc.enabled is True
    assert fc.transition_name == "Cut"
    assert fc.duration_ms == 100


def test_resolve_partial_override():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=True, obs_transition_name="Fade",
                    obs_transition_duration_ms=350)
    opts = RecordingOptions(obs_transition_duration_ms=200)  # only duration overridden
    fc = resolve(opts, cfg)
    assert fc.enabled is True       # from AppConfig
    assert fc.transition_name == "Fade"  # from AppConfig
    assert fc.duration_ms == 200    # from opts
```

- [ ] **Step 2: 运行新测试，确认失败**

```bash
python -m pytest backend/tests/test_fade_config_resolve.py::test_resolve_uses_appconfig_when_options_are_none -v
```

期望：`ImportError` 或 `AttributeError`（`_resolve_fade_config` 未定义）。

- [ ] **Step 3: 在 `api.py` 添加 import 和 `_resolve_fade_config`**

打开 `backend/app/recording/api.py`，在顶部 import 区追加：

```python
from .executor.obs_fade_controller import OBSFadeController, FadeConfig
```

然后在 `build_v3_recorded_clip_meta` 函数定义**前面**（文件约第 62 行之前）插入：

```python
def _resolve_fade_config(options: "RecordingOptions", cfg: "AppConfig") -> FadeConfig:
    """Merge per-request RecordingOptions fade overrides with AppConfig global defaults."""
    return FadeConfig(
        enabled=(
            options.obs_transition_enabled
            if options.obs_transition_enabled is not None
            else cfg.obs_transition_enabled
        ),
        transition_name=options.obs_transition_name or cfg.obs_transition_name,
        duration_ms=(
            options.obs_transition_duration_ms
            if options.obs_transition_duration_ms is not None
            else cfg.obs_transition_duration_ms
        ),
        game_scene_name=cfg.obs_game_scene_name,
        black_scene_name=cfg.obs_black_scene_name,
    )
```

- [ ] **Step 4: 修改 `execute_recording` 端点，把 `OBSFadeController` 传给 executor**

找到 `execute_recording` 函数中的：

```python
    executor = RecordingExecutor(obs_client)
    result = await executor.execute(plan)
```

替换为：

```python
    fade_config = _resolve_fade_config(dto.options, config)
    fade_ctrl = OBSFadeController(obs_cfg, fade_config)
    await fade_ctrl.setup()

    executor = RecordingExecutor(obs_client, fade_controller=fade_ctrl)
    result = await executor.execute(plan)
```

- [ ] **Step 5: 运行全量测试**

```bash
python -m pytest backend/tests/ -v
```

期望：所有测试 PASS（`RecordingExecutor` 还未接受 `fade_controller` 参数，会有 TypeError——若出现，先跳 Step 6 改 executor 签名，再回来）。

- [ ] **Step 6: Commit**

```bash
git add backend/app/recording/api.py backend/tests/test_fade_config_resolve.py
git commit -m "feat: wire _resolve_fade_config and OBSFadeController into recording API"
```

---

## Task 5: `RecordingExecutor` 集成

**Files:**
- Modify: `backend/app/recording/executor/recording_executor.py`

- [ ] **Step 1: 更新 `RecordingExecutor.__init__` 签名，接收 `OBSFadeController`**

打开 `backend/app/recording/executor/recording_executor.py`，找到：

```python
class RecordingExecutor:
    def __init__(self, obs_client: OBSClient, abort_event: Optional[asyncio.Event] = None):
        self._obs = obs_client
        self._abort_event = abort_event
        # Controller is created per-execute call so it always holds the current client.
        self._ctrl: Optional[OBSRecordingController] = None
```

替换为：

```python
class RecordingExecutor:
    def __init__(
        self,
        obs_client: OBSClient,
        abort_event: Optional[asyncio.Event] = None,
        fade_controller: Optional["OBSFadeController"] = None,
    ):
        self._obs = obs_client
        self._abort_event = abort_event
        self._fade: Optional["OBSFadeController"] = fade_controller
        # Controller is created per-execute call so it always holds the current client.
        self._ctrl: Optional[OBSRecordingController] = None
```

在文件顶部的 import 区（紧跟 `from .obs_recording_controller import ...` 之后）追加：

```python
from .obs_fade_controller import OBSFadeController
```

- [ ] **Step 2: 在 `_stop_obs_and_console_pause` 里加 fade-out**

找到 `_stop_obs_and_console_pause` 方法：

```python
    async def _stop_obs_and_console_pause(self, is_last: bool) -> Optional[str]:
        ...
        if is_last:
            silent_result, obs_result = await asyncio.gather(
                demo_pause_silent_strict(),
                self._ctrl.stop_record_safe(),
                return_exceptions=True,
            )
```

在 `if is_last:` **之前**插入 fade-out：

```python
        # Fade to black before OBS pause/stop — the transition is recorded as fade-out.
        if self._fade is not None:
            ok = await self._fade.fade_to_black()
            if not ok:
                logger.warning("[RecordingV3] fade_to_black failed at segment boundary; hard-cut")
```

- [ ] **Step 3: 在 `execute()` 的 StartRecord 前后加 fade**

在 `execute()` 方法里找到（约 line 513）：

```python
                if not obs_recording_started:
                    ...
                    await self._ctrl.start_record_safe()
                    obs_recording_started = True
                else:
                    ...
                    await self._ctrl.resume_record_safe()
```

在 `await self._ctrl.start_record_safe()` **之前**插入：

```python
                    if self._fade is not None:
                        ok = await self._fade.fade_to_black()
                        if not ok:
                            logger.warning("[RecordingV3] fade_to_black before StartRecord failed; hard-cut")
```

在 `obs_recording_started = True` **之后**、`else:` 分支的 `await self._ctrl.resume_record_safe()` **之后**都插入 fade-in：

```python
                    # fade-in (StartRecord path)
                    if self._fade is not None:
                        ok = await self._fade.fade_to_game()
                        if not ok:
                            logger.warning("[RecordingV3] fade_to_game after StartRecord failed; hard-cut")
```

```python
                    # fade-in (ResumeRecord path)
                    if self._fade is not None:
                        ok = await self._fade.fade_to_game()
                        if not ok:
                            logger.warning("[RecordingV3] fade_to_game after ResumeRecord failed; hard-cut")
```

> **注意**：`demo_resume_silent_strict()` 在 fade_to_game() **之后**调用，保证控制台注入不进成片。不改变该调用位置。

- [ ] **Step 4: 验证语法**

```bash
python -c "from app.recording.executor.recording_executor import RecordingExecutor; print('OK')"
```

期望：`OK`（从 `backend/` 目录运行）。

- [ ] **Step 5: 运行全量测试**

```bash
python -m pytest backend/tests/ -v
```

期望：所有测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/recording/executor/recording_executor.py
git commit -m "feat: integrate OBSFadeController into RecordingExecutor at segment boundaries"
```

---

## Task 6: 前端 DTO 层（recordingRequestFactory.js）

**Files:**
- Modify: `frontend/src/recording/recordingRequestFactory.js`

- [ ] **Step 1: 在 `DEFAULT_RECORDING_OPTIONS` 里追加 3 个 fade 字段**

打开 `frontend/src/recording/recordingRequestFactory.js`，找到 `export const DEFAULT_RECORDING_OPTIONS = {`，在对象末尾（`final_round_demo_exit_guard_sec: 1.5,` 之后）追加：

```js
  obs_transition_enabled: null,
  obs_transition_name: null,
  obs_transition_duration_ms: null,
```

这 3 个字段为 `null`，表示"不覆盖后端全局默认"，与 `RecordingOptions` 的 `Optional` 语义一致。

- [ ] **Step 2: 验证前端构建不报错**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

期望：`built in ...` 成功，无 error。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/recording/recordingRequestFactory.js
git commit -m "feat: add obs_transition fields to DEFAULT_RECORDING_OPTIONS"
```

---

## Task 7: CommonParamsModal — 全局默认 UI

**Files:**
- Modify: `frontend/src/components/CommonParamsModal.jsx`

> **前置**：先阅读 `CommonParamsModal.jsx` 前 100 行确认 state 管理模式（用 `useState` 还是 store），找到现有 section 的结构参考，然后再改。

- [ ] **Step 1: 在 CommonParamsModal 中定位全局配置写入的 state 和保存函数**

搜索文件中的 `axios.put` 或 `save` 或 `api/config`——这是找到现有配置保存方式：

```bash
grep -n "axios\|api/config\|onSave\|handleSave" frontend/src/components/CommonParamsModal.jsx | head -20
```

记录 save 函数名和 state 名称，供下面步骤使用。

- [ ] **Step 2: 在 CommonParamsModal 添加 fade 相关 state**

找到现有的 `useState` 声明区，在最后一个 `useState` 之后追加：

```jsx
  const [obsTransitionEnabled, setObsTransitionEnabled] = useState(
    () => !!initialConfig?.obs_transition_enabled
  );
  const [obsTransitionName, setObsTransitionName] = useState(
    () => initialConfig?.obs_transition_name ?? "Fade"
  );
  const [obsTransitionDurationMs, setObsTransitionDurationMs] = useState(
    () => initialConfig?.obs_transition_duration_ms ?? 350
  );
```

（`initialConfig` 是 CommonParamsModal 收到的 prop，已有的同名 prop 模式——若不同则用实际 prop 名替换）

- [ ] **Step 3: 把 3 个字段加入保存载荷**

找到保存函数里构建提交对象的地方，追加这 3 个字段：

```js
    obs_transition_enabled: obsTransitionEnabled,
    obs_transition_name: obsTransitionName,
    obs_transition_duration_ms: Number(obsTransitionDurationMs),
```

- [ ] **Step 4: 在 Modal 的 JSX 里添加「OBS 转场效果」折叠区**

参考现有 `<WorkflowSection>` 或 `<section>` 的写法（若 CommonParamsModal 用的是 accordion/section 组件则跟它的 pattern 走）。在合适位置（OBS 设置相关区域附近）插入：

```jsx
<WorkflowSection
  title="OBS 转场效果"
  subtitle="片段开始/结束时录入黑场渐入渐出，让成片段落过渡更自然。"
  defaultOpen={false}
>
  <div className="space-y-3">
    <label className="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={obsTransitionEnabled}
        onChange={(e) => setObsTransitionEnabled(e.target.checked)}
        className="h-4 w-4 rounded border-cs2-border accent-cs2-orange"
      />
      <span className="text-sm text-cs2-text-primary">启用渐入渐出</span>
    </label>

    <label className="block text-xs font-medium text-cs2-text-secondary">
      转场样式
      <select
        value={obsTransitionName}
        onChange={(e) => setObsTransitionName(e.target.value)}
        disabled={!obsTransitionEnabled}
        className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
      >
        <option value="Fade">Fade（淡入淡出）</option>
        <option value="Cut">Cut（硬切，无渐变）</option>
        <option value="Swipe">Swipe（横推）</option>
      </select>
    </label>

    <label className="block text-xs font-medium text-cs2-text-secondary">
      时长（ms）
      <input
        type="number"
        min={0}
        max={2000}
        step={50}
        value={obsTransitionDurationMs}
        onChange={(e) => setObsTransitionDurationMs(Number(e.target.value))}
        disabled={!obsTransitionEnabled}
        className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
      />
      <span className="mt-0.5 text-[11px] text-cs2-text-muted">建议 250–500 ms；0 = 瞬切</span>
    </label>
  </div>
</WorkflowSection>
```

> 若 `CommonParamsModal` 使用不同的 section 组件（如直接 `<section>` 或 `<details>`），按已有模式替换 `<WorkflowSection>`。

- [ ] **Step 5: 验证前端构建**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

期望：成功无 error。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/CommonParamsModal.jsx
git commit -m "feat: add OBS transition UI section to CommonParamsModal"
```

---

## Task 8: RecordWarmupModal — 逐次覆盖 UI

**Files:**
- Modify: `frontend/src/components/RecordWarmupModal.jsx`

- [ ] **Step 1: 在 `RecordWarmupModal` 的 state 初始化区追加 3 个 fade state**

打开 `RecordWarmupModal.jsx`，找到 `const [opts, setOpts] = useState(...)` 或类似的 options state 初始化，在其后追加：

```jsx
  const [obsTransitionEnabled, setObsTransitionEnabled] = useState(
    () => defaultOverrides?.obs_transition_enabled ?? null  // null = 沿用全局
  );
  const [obsTransitionName, setObsTransitionName] = useState(
    () => defaultOverrides?.obs_transition_name ?? null
  );
  const [obsTransitionDurationMs, setObsTransitionDurationMs] = useState(
    () => defaultOverrides?.obs_transition_duration_ms ?? null
  );
```

（`defaultOverrides` 是 `RecordWarmupModal` 已有的 prop，内含从 AppConfig 读来的默认值）

- [ ] **Step 2: 把 fade 字段追加到 `onConfirm` 载荷**

找到调用 `onConfirm(...)` 的那行（约 line 226）：

```js
    onConfirm({ ...apiShape, console_cmds });
```

替换为：

```js
    onConfirm({
      ...apiShape,
      console_cmds,
      obs_transition_enabled: obsTransitionEnabled,
      obs_transition_name: obsTransitionName,
      obs_transition_duration_ms: obsTransitionDurationMs,
    });
```

- [ ] **Step 3: 在 JSX 末尾（提交按钮之前）插入转场折叠区**

找到 Modal 的滚动内容区结尾，添加：

```jsx
<div className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-4">
  <p className="mb-3 text-xs font-black uppercase tracking-[0.22em] text-cs2-text-muted">
    OBS 转场效果
  </p>
  <div className="space-y-3">
    <label className="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={obsTransitionEnabled ?? false}
        onChange={(e) =>
          setObsTransitionEnabled(e.target.checked ? true : null)
        }
        className="h-4 w-4 rounded border-cs2-border accent-cs2-orange"
      />
      <span className="text-sm text-cs2-text-primary">
        启用渐入渐出
        {obsTransitionEnabled === null && (
          <span className="ml-1.5 text-[11px] text-cs2-text-muted">（沿用全局设置）</span>
        )}
      </span>
    </label>

    <label className="block text-xs font-medium text-cs2-text-secondary">
      转场样式
      <select
        value={obsTransitionName ?? ""}
        onChange={(e) =>
          setObsTransitionName(e.target.value || null)
        }
        disabled={!obsTransitionEnabled}
        className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
      >
        <option value="">（沿用全局）</option>
        <option value="Fade">Fade（淡入淡出）</option>
        <option value="Cut">Cut（硬切）</option>
        <option value="Swipe">Swipe（横推）</option>
      </select>
    </label>

    <label className="block text-xs font-medium text-cs2-text-secondary">
      时长（ms）
      <input
        type="number"
        min={0}
        max={2000}
        step={50}
        placeholder="沿用全局"
        value={obsTransitionDurationMs ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          setObsTransitionDurationMs(v === "" ? null : Number(v));
        }}
        disabled={!obsTransitionEnabled}
        className="mt-1 block w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary disabled:opacity-40"
      />
    </label>
  </div>
</div>
```

- [ ] **Step 4: 在 `buildDtoFromQueueItem.js` 里把 fade 字段合入 options**

打开 `frontend/src/recording/buildDtoFromQueueItem.js`，找到 `const options = pacingOverrideToOptions(mergedPacing);` 行，在其**后面**追加：

```js
  // Fade transition per-recording overrides (null = use AppConfig global default).
  if (item.obs_transition_enabled !== undefined)
    options.obs_transition_enabled = item.obs_transition_enabled ?? null;
  if (item.obs_transition_name !== undefined)
    options.obs_transition_name = item.obs_transition_name ?? null;
  if (item.obs_transition_duration_ms !== undefined)
    options.obs_transition_duration_ms = item.obs_transition_duration_ms ?? null;
```

（`item` 在录制队列 store 里携带 warmup 确认后的值；若 warmup 结果经 `onConfirm` 写回 store 的字段名不同，按实际字段名调整）

- [ ] **Step 5: 验证前端构建**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

期望：成功无 error。

- [ ] **Step 6: 运行全量后端测试**

```bash
python -m pytest backend/tests/ -v
```

期望：所有测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/RecordWarmupModal.jsx \
        frontend/src/recording/buildDtoFromQueueItem.js
git commit -m "feat: add OBS fade override controls to RecordWarmupModal"
```

---

## 自查（Self-Review）

### Spec coverage

| Spec 要求 | 覆盖 task |
|---|---|
| `obs_transition_enabled/name/duration_ms/game_scene_name/black_scene_name` 配置 | Task 1 |
| `_obs_pause_segment_boundary / _obs_resume_segment_boundary / _obs_fade_to_black / _obs_fade_to_game` 等效方法 | Task 3 (`fade_to_black` / `fade_to_game`) |
| StartRecord 前切黑场 → 录入 fade-in | Task 5 |
| 段间：录 fade-out → pause → seek/GSI → resume → 录 fade-in | Task 5 (`_stop_obs_and_console_pause` + execute loop) |
| StopRecord 前录 fade-out | Task 5 |
| OBS 没找到场景/转场 API 失败 → warning + fallback 硬切 | Task 3 (setup fallback) + Task 5 (fade return False → warning + continue) |
| 不修改 demo tick 计算，转场时长不从 segment sleep 扣 | 不涉及 tick 计算，sleep 在 fade 内部独立追加 ✅ |
| 前端 CommonParamsModal 全局默认 | Task 7 |
| 前端 RecordWarmupModal 逐次覆盖 | Task 8 |
| 自动创建黑场 Scene | Task 3 (`_setup_scenes`) |
| 游戏 Scene 逻辑从 obs_director 迁移 | Task 3 (`ensure_game_capture_in_scene`) + Task 4 |

### Placeholder scan

无 TBD / TODO / "similar to above" / "add error handling"。所有步骤含完整代码。✅

### Type consistency

- `FadeConfig` 定义于 Task 3，在 Task 4 的 `_resolve_fade_config` 里 return `FadeConfig(...)`，在 Task 5 的 `RecordingExecutor.__init__` 里接收 `Optional[OBSFadeController]`——类型链一致。✅
- `OBSFadeController.fade_to_black()` / `fade_to_game()` 返回 `bool`，Task 5 里检查 `if not ok: logger.warning(...)` 一致。✅
- `DEFAULT_RECORDING_OPTIONS` 新增字段为 `null`（JS），后端 `RecordingOptions` 新增字段为 `Optional[...] = None`——JSON null ↔ Python None 一致。✅
