# Remove Legacy Recording Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy OBSDirector recording paths (`/api/record/start`, `/api/record/batch`, `execute_recording_pipeline`, `execute_batch_recording`) and all code that exclusively supports them, leaving only the stable V3 `RecordingExecutor` path via `/api/recording/queue`.

**Architecture:** The V3 path (`POST /api/recording/queue` → `execute_recording_queue` in `recording/api.py` → `OBSDirector.execute_plan_queue` → `RecordingExecutor`) is now the sole recording pipeline. The legacy path consisted of two main.py endpoints that called `OBSDirector.execute_recording_pipeline` / `execute_batch_recording`, plus ~3500 lines of per-clip recording logic inside `obs_director.py`. All of that gets deleted. `OBSDirector` itself survives: its CS2 launch/GSI infrastructure, `execute_plan_queue`, `test_obs_connection`, `connect_obs`/`disconnect_obs` (used by `obs_config_center`) still have callers.

**Tech Stack:** Python 3.11 / FastAPI / obswebsocket-py. No new dependencies. No new files.

**Baseline:** `cd backend && python -m pytest tests/ -q` → 27 passed. This number must stay 27 after every task.

---

## File Change Map

| File | Change |
|------|--------|
| `backend/app/main.py` | Delete two endpoint handlers + all supporting models/functions |
| `backend/app/obs_director.py` | Delete ~3500 lines of legacy recording methods; update `connect_obs`, `test_obs_connection`, `__init__`, and `execute_plan_queue` |
| `backend/app/obs_config_center.py` | Replace `OBSDirector` connection wrapper with direct `obsws` |

---

## Task 1: Remove legacy endpoints and supporting code from `main.py`

**Files:**
- Modify: `backend/app/main.py`

### What to delete (in order of appearance)

- [ ] **Step 1: Remove the `merge_warmup_extras_for_pov` import (line 57)**

Replace:
```python
from .pov_experimental import merge_warmup_extras_for_pov
```
With nothing (delete the line entirely). `merge_warmup_extras_for_pov` is only called inside the two legacy endpoints being removed.

- [ ] **Step 2: Slim the `obs_director` import block (lines 68-75)**

Replace:
```python
from .obs_director import (
    CS2_RUNNING_MESSAGE,
    CS2AlreadyRunningError,
    CS2NotReadyError,
    OBSDirector,
    RecordingWarmupExtras,
    _RECORDING_RESULT_CLIP_META_KEYS,
)
```
With:
```python
from .obs_director import OBSDirector
```
`OBSDirector` remains because `/api/status/setup` and `/api/obs/test` still call `director.test_obs_connection()`. The other five symbols are only used by the deleted endpoints. `is_cs2_running` / `is_restore_required` / `CS2_RUNNING_MESSAGE` are already imported from `cs2_config_backup` at line 60-67.

- [ ] **Step 3: Remove the `_recording_abort_event` global (line 107)**

Delete:
```python
_recording_abort_event: Optional[asyncio.Event] = None
```

- [ ] **Step 4: Delete `_raise_if_recording_never_started` (≈lines 425-438)**

Delete the entire function — it is only called by the two legacy endpoints.

- [ ] **Step 5: Delete `_clip_meta_from_recording_result` (≈lines 441-448)**

Delete the entire function.

- [ ] **Step 6: Delete `_persist_recorded_clips_from_results` (≈lines 451-~480)**

Delete the entire function (it calls `_clip_meta_from_recording_result` which was just deleted).

- [ ] **Step 7: Delete `RecordWarmupOptions` model (≈lines 1749-1783)**

Delete the entire `class RecordWarmupOptions(BaseModel)` definition including its `@model_validator`.

- [ ] **Step 8: Delete `RecordRequest` model (≈lines 1786-1794)**

Delete the entire `class RecordRequest(BaseModel)` definition.

- [ ] **Step 9: Delete `_raise_if_cs2_already_running` and `_raise_if_config_restore_required` (≈lines 1797-1804)**

Delete both small helper functions.

- [ ] **Step 10: Delete the `start_recording` handler and its endpoint (≈lines 1807-1934)**

Delete from `@app.post("/api/record/start")` through the end of the `async def start_recording` function (everything up to but not including the `BatchRecordGroup` class definition).

- [ ] **Step 11: Delete `BatchRecordGroup`, `BatchRecordRequest`, `_resolve_spectators_for_record` (≈lines 1937-1995)**

Delete all three.

- [ ] **Step 12: Delete the `start_batch_recording` handler (≈lines 1998-2135)**

Delete from `@app.post("/api/record/batch")` through the end of `async def start_batch_recording`.

- [ ] **Step 13: Simplify `record_abort` to V3-only (≈lines 2137-2150)**

Replace the entire function body with V3-only logic:

```python
@app.post("/api/record/abort")
def record_abort():
    """请求中止当前进行中的 OBS 录制（异步收尾，接口立即返回）。"""
    from .recording.api import get_queue_abort_event
    v3_ev = get_queue_abort_event()
    if v3_ev is not None:
        v3_ev.set()
        return {"status": "ok", "message": "已请求中止，正在收尾…"}
    return {"status": "idle", "message": "当前没有进行中的录制"}
```

- [ ] **Step 14: Verify no broken references**

```bash
cd backend
python -c "from app.main import app; print('import OK')"
```
Expected output: `import OK`

- [ ] **Step 15: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 16: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: remove legacy /api/record/start and /api/record/batch endpoints"
```

---

## Task 2: Remove OBS scene-management block from `obs_director.py`

These methods were only called by the deleted legacy recording pipeline and by `connect_obs` / `test_obs_connection` (which will be updated in Task 4).

**Files:**
- Modify: `backend/app/obs_director.py`

The block spans from `_obs_ensure_managed_recording_scene` (≈line 2041) through `_obs_cs2_window_setting` (≈line 2350). Identify the exact lines with:

```bash
grep -n "def _obs_ensure_managed_recording_scene\|def _obs_ensure_managed_game_capture\|def _obs_managed_game_capture_settings\|def _obs_apply_managed_game_capture_settings\|def _obs_apply_managed_game_capture_transform\|def _obs_cs2_window_setting" backend/app/obs_director.py
```

- [ ] **Step 1: Delete the six methods**

Delete all six method definitions from `_obs_ensure_managed_recording_scene` through the end of `_obs_cs2_window_setting`. These methods are self-contained (no other methods in the keep-list call them). The next method after this block is `_cleanup_cs2_artifacts`.

Verify the block end by finding `_cleanup_cs2_artifacts`:
```bash
grep -n "def _cleanup_cs2_artifacts" backend/app/obs_director.py
```

- [ ] **Step 2: Verify import**

```bash
cd backend
python -c "from app.obs_director import OBSDirector; print('import OK')"
```
Expected: `import OK`

- [ ] **Step 3: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 4: Commit**

```bash
git add backend/app/obs_director.py
git commit -m "refactor: remove legacy OBS scene-management methods from OBSDirector"
```

---

## Task 3: Remove legacy file-scan and rename helpers from `obs_director.py`

These methods are only called by `_execute_single_clip_recording` (being deleted in Task 4) and/or `execute_recording_pipeline` / `execute_batch_recording` (deleted in Task 5). They are NOT called by `execute_plan_queue`.

**Files:**
- Modify: `backend/app/obs_director.py`

Find exact line ranges with:

```bash
grep -n "def _obs_record_directory_path\|def _obs_snapshot_record_dir_video_paths\|def _pick_new_recording_path_after_snapshot\|def _locate_recent_recording_output\|def _finalize_obs_recording_rename" backend/app/obs_director.py
```

- [ ] **Step 1: Delete `_obs_record_directory_path`**

Delete the method `_obs_record_directory_path` (≈lines 3354-3373). This method reads from `self._ws` which will no longer be live during recording.

- [ ] **Step 2: Delete `_obs_snapshot_record_dir_video_paths`**

Delete (≈lines 3375-3391). Called only by `_execute_single_clip_recording`.

- [ ] **Step 3: Delete `_pick_new_recording_path_after_snapshot`**

Delete (≈lines 3393-3427). Called only by `_finalize_obs_recording_rename`.

- [ ] **Step 4: Delete `_locate_recent_recording_output`**

Delete (≈lines 3429-3454). Called only by `_finalize_obs_recording_rename`.

- [ ] **Step 5: Delete `_finalize_obs_recording_rename`**

Delete (≈lines 3550-3595). Called only by `_execute_single_clip_recording`.

- [ ] **Step 6: Verify import**

```bash
cd backend
python -c "from app.obs_director import OBSDirector; print('import OK')"
```
Expected: `import OK`

- [ ] **Step 7: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 8: Commit**

```bash
git add backend/app/obs_director.py
git commit -m "refactor: remove legacy file-scan and rename helpers from OBSDirector"
```

---

## Task 4: Remove the legacy clip-recording core from `obs_director.py`

This is the largest deletion: `_prepare_clip_playback`, `_execute_single_clip_recording`, and the cursor-hiding helpers.

**Files:**
- Modify: `backend/app/obs_director.py`

Find exact line ranges:

```bash
grep -n "def _prepare_clip_playback\|def _execute_single_clip_recording\|def _obs_apply_hide_cursor_inputs\|def _obs_restore_hide_cursor_inputs\|def _win_cursor_corner_backup\|def _win_cursor_move_corner\|def _win_cursor_restore_pos" backend/app/obs_director.py
```

- [ ] **Step 1: Delete `_prepare_clip_playback`**

Delete from the `def _prepare_clip_playback` line through the end of that method. The next method after it is `_execute_single_clip_recording`.

- [ ] **Step 2: Delete `_execute_single_clip_recording`**

Delete from `def _execute_single_clip_recording` through its end. The next method is `_obs_apply_hide_cursor_inputs`.

- [ ] **Step 3: Delete cursor helpers**

Delete `_obs_apply_hide_cursor_inputs`, `_obs_restore_hide_cursor_inputs`, `_win_cursor_corner_backup`, `_win_cursor_move_corner`, `_win_cursor_restore_pos` (five consecutive methods, ≈lines 5428-5522).

- [ ] **Step 4: Verify import**

```bash
cd backend
python -c "from app.obs_director import OBSDirector; print('import OK')"
```
Expected: `import OK`

- [ ] **Step 5: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 6: Commit**

```bash
git add backend/app/obs_director.py
git commit -m "refactor: remove legacy _prepare_clip_playback and _execute_single_clip_recording"
```

---

## Task 5: Remove `execute_recording_pipeline` and `execute_batch_recording` from `obs_director.py`

**Files:**
- Modify: `backend/app/obs_director.py`

- [ ] **Step 1: Delete `execute_recording_pipeline`**

Find the exact start and end lines:
```bash
grep -n "async def execute_recording_pipeline\|async def execute_batch_recording\|async def execute_plan_queue" backend/app/obs_director.py
```

Delete from `async def execute_recording_pipeline` through just before `async def execute_batch_recording`.

- [ ] **Step 2: Delete `execute_batch_recording`**

Delete from `async def execute_batch_recording` through just before `async def execute_plan_queue`.

- [ ] **Step 3: Verify import**

```bash
cd backend
python -c "from app.obs_director import OBSDirector; print('import OK')"
```
Expected: `import OK`

- [ ] **Step 4: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/app/obs_director.py
git commit -m "refactor: remove execute_recording_pipeline and execute_batch_recording from OBSDirector"
```

---

## Task 6: Clean up `obs_director.py` remaining legacy references

Update `__init__`, `connect_obs`, `test_obs_connection`, and `execute_plan_queue` to remove the last traces of the deleted methods.

**Files:**
- Modify: `backend/app/obs_director.py`

- [ ] **Step 1: Remove legacy instance variables from `__init__`**

In `OBSDirector.__init__`, delete these four lines:
```python
self._obs_cursor_restore: list[tuple[str, bool]] = []
self._obs_managed_scene_ready = False
self._obs_managed_input_ready = False
self._pov_enabled = False
```
Also delete `self._last_warmup: Optional[RecordingWarmupExtras] = None` (only set by the deleted legacy recording methods).

- [ ] **Step 2: Update `connect_obs` — remove `_obs_ensure_managed_recording_scene` call**

Replace:
```python
    def connect_obs(self) -> bool:
        """Establish WebSocket connection to OBS."""
        try:
            self._ws = obsws(
                self.obs_config.host,
                self.obs_config.port,
                self.obs_config.password,
            )
            self._ws.connect()
            logger.info("OBS WebSocket connected at %s:%d", self.obs_config.host, self.obs_config.port)
            self._obs_ensure_managed_recording_scene()
            return True
        except Exception as e:
            logger.error("OBS connection failed: %s", e)
            return False
```
With:
```python
    def connect_obs(self) -> bool:
        """Establish WebSocket connection to OBS."""
        try:
            self._ws = obsws(
                self.obs_config.host,
                self.obs_config.port,
                self.obs_config.password,
            )
            self._ws.connect()
            logger.info("OBS WebSocket connected at %s:%d", self.obs_config.host, self.obs_config.port)
            return True
        except Exception as e:
            logger.error("OBS connection failed: %s", e)
            return False
```

- [ ] **Step 3: Update `test_obs_connection` — remove managed scene call and fields**

Replace the full body of `test_obs_connection`:
```python
    def test_obs_connection(self, *, handshake_timeout_sec: Optional[float] = None) -> dict:
        """Quick connection test — returns version info or error."""
        prev_ws = self._ws
        try:
            if handshake_timeout_sec is not None:
                ws = _ObswsBoundedHandshake(
                    self.obs_config.host,
                    self.obs_config.port,
                    self.obs_config.password,
                    handshake_timeout_sec=handshake_timeout_sec,
                )
            else:
                ws = obsws(self.obs_config.host, self.obs_config.port, self.obs_config.password)
            ws.connect()
            ver = ws.call(obs_requests.GetVersion())
            ws.disconnect()
            return {
                "ok": True,
                "obs_version": ver.getObsVersion(),
                "ws_version": ver.getObsWebSocketVersion(),
            }
        except Exception as e:
            logger.warning("OBS WebSocket test failed: %s", e, exc_info=True)
            return {"ok": False, "error": _friendly_obs_websocket_test_error(e)}
        finally:
            self._ws = prev_ws
```

Note: `self._ws = ws` and the `managed_scene_ready`/`managed_input_ready` fields are removed. `prev_ws` is preserved so the finally block restores the original state.

- [ ] **Step 4: Remove `_obs_record_directory_path` fallback from `execute_plan_queue`**

In `execute_plan_queue`, find the fallback block (≈line 6124-6126):
```python
                        if _obs_dir is None or not _obs_dir.is_dir():
                            # Last-resort: try legacy path (works if self._ws is live)
                            _obs_dir = self._obs_record_directory_path()
```
Delete these three lines. The `_obs_record_directory_path` method was removed in Task 3 and `self._ws` is never live during V3 recording anyway.

- [ ] **Step 5: Verify import and server start**

```bash
cd backend
python -c "from app.obs_director import OBSDirector; d = OBSDirector.__init__.__doc__; print('OK')"
python -c "from app.main import app; print('server import OK')"
```
Expected: both print OK.

- [ ] **Step 6: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 7: Commit**

```bash
git add backend/app/obs_director.py
git commit -m "refactor: clean up OBSDirector __init__, connect_obs, test_obs_connection after legacy removal"
```

---

## Task 7: Decouple `obs_config_center.py` from `OBSDirector`

`obs_config_center.py` uses `OBSDirector` only as a thin wrapper to get an `obsws` connection (`connect_obs` / `disconnect_obs` / `obs_ws`). Replace with direct `obsws` usage.

**Files:**
- Modify: `backend/app/obs_config_center.py`

- [ ] **Step 1: Remove the OBSDirector import**

Delete:
```python
from .obs_director import OBSDirector
```

`obswebsocket.obsws` is already imported at line 18 of that file.

- [ ] **Step 2: Update `apply_recommended` — first OBSDirector usage (≈lines 1061-1106)**

Find the pattern:
```python
    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )
    try:
        if director.connect_obs() and director.obs_ws:
            ws = director.obs_ws
            ...
        else:
            ...
    except Exception as e:
        ...
    finally:
        director.disconnect_obs()
```

Replace with:
```python
    ws: Optional[obsws] = None
    try:
        _ws = obsws(obs_cfg.host, obs_cfg.port, obs_cfg.password)
        _ws.connect()
        ws = _ws
    except Exception as e:
        logger.info("apply_recommended: WebSocket 未连接，仅完成磁盘预设写入: %s", e)

    try:
        if ws is not None:
            if _obs_is_recording(ws):
                logger.warning("apply_recommended: OBS 正在录制，跳过 WebSocket 同步")
                changed.append("websocket_sync_skipped_recording")
            else:
                _try_set_video_and_profile_params(
                    ws,
                    base_w=bw,
                    base_h=bh,
                    fps=fps_v,
                    encoder=encoder_pick,
                    output_width=ow,
                    output_height=oh,
                    project_profile=pp,
                    basic_ini_path=basic_ini,
                    sync_simple_output_from_disk=bundled_used,
                )
                changed.append("websocket_video_and_simple_output")
                restart_obs_required = False

                if fix_scene:
                    sn = _dedicated_scene_name()
                    cn = _dedicated_capture_name()
                    vr = ws.call(obs_requests.GetVideoSettings())
                    vd = _parse_ws_video(vr)
                    bw_run = int(vd["base_width"] or bw)
                    bh_run = int(vd["base_height"] or bh)
                    if _apply_scale_inner_transform(ws, sn, cn, bw_run, bh_run):
                        changed.append("fixed_capture_source_transform")
        else:
            changed.append("websocket_sync_skipped_no_connection")
    except Exception as e:
        logger.warning("apply_recommended: WebSocket 同步异常（磁盘已写入）: %s", e, exc_info=True)
        changed.append("websocket_sync_failed")
    finally:
        if ws is not None:
            try:
                ws.disconnect()
            except Exception:
                pass
```

- [ ] **Step 3: Update `import_cs2obs_bytes` — second OBSDirector usage (≈lines 1186-1223)**

Find the pattern:
```python
    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        ...
    )
    try:
        if not director.connect_obs():
            raise ValueError("无法连接 OBS WebSocket")
        ws = director.obs_ws
        if not ws:
            raise ValueError("OBS WebSocket 未就绪")
        ...
    finally:
        director.disconnect_obs()
```

Replace with:
```python
    try:
        _ws = obsws(obs_cfg.host, obs_cfg.port, obs_cfg.password)
        _ws.connect()
        ws = _ws
    except Exception as e:
        raise ValueError(f"无法连接 OBS WebSocket: {e}") from e
    try:
        if _obs_is_recording(ws):
            raise ValueError("OBS 正在录制中，请停止录制后再修改配置。")
        _try_set_video_and_profile_params(
            ws,
            base_w=bw,
            base_h=bh,
            fps=fps,
            encoder=encoder_pick,
            output_width=ow,
            output_height=oh,
            rec_format=rec_fmt,
            project_profile=pp,
            sync_simple_output_from_disk=False,
        )
        restart_obs_required = False
        sn = _dedicated_scene_name()
        cn = _dedicated_capture_name()
        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        bwv = int(vd["base_width"] or bw)
        bhv = int(vd["base_height"] or bh)
        if _apply_scale_inner_transform(ws, sn, cn, bwv, bhv):
            changed.append("fixed_capture_source_transform")
    finally:
        try:
            ws.disconnect()
        except Exception:
            pass
```

- [ ] **Step 4: Verify import**

```bash
cd backend
python -c "from app.obs_config_center import apply_recommended; print('import OK')"
```
Expected: `import OK`

- [ ] **Step 5: Run tests**

```bash
cd backend
python -m pytest tests/ -q
```
Expected: `27 passed`

- [ ] **Step 6: Commit**

```bash
git add backend/app/obs_config_center.py
git commit -m "refactor: decouple obs_config_center from OBSDirector — use obsws directly"
```

---

## Self-Review

**Spec coverage:**
- ✅ `/api/record/start` removed (Task 1)
- ✅ `/api/record/batch` removed (Task 1)
- ✅ `execute_recording_pipeline` removed (Task 5)
- ✅ `execute_batch_recording` removed (Task 5)
- ✅ All supporting models/helpers removed (Task 1)
- ✅ OBS scene-management methods removed (Task 2)
- ✅ File-scan/rename helpers removed (Task 3)
- ✅ Per-clip recording core removed (Task 4)
- ✅ `connect_obs` / `test_obs_connection` / `__init__` cleaned up (Task 6)
- ✅ `obs_config_center.py` decoupled (Task 7)
- ✅ V3 `execute_plan_queue`, CS2 infrastructure, `test_obs_connection`, `connect_obs`/`disconnect_obs` all preserved

**Items preserved intentionally:**
- `OBSDirector` class (needed by recording/api.py and obs_config_center)
- `execute_plan_queue` (the V3 recording path)
- `_rename_recording_output`, `_build_clip_recording_stem`, `_safe_filename_part`, `_unique_recording_target`, `_map_name_for_recording`, `_compact_weapon_label` (used by `execute_plan_queue` for output file naming)
- `_run_cleanup_step`, `_kill_cs2`, `_cleanup_cs2_artifacts`, CS2 launch/GSI methods (used by `execute_plan_queue`)
- `test_obs_connection` (used by `/api/status/setup` and `/api/obs/test`)
- `connect_obs`, `disconnect_obs`, `obs_ws` (used by `obs_config_center.py` after Task 7 replacement... wait — Task 7 removes that dependency. After Task 7, `obs_config_center.py` no longer uses `connect_obs`/`disconnect_obs`/`obs_ws`. Check if anything else calls them.)

**Check after Task 7:** After `obs_config_center.py` is decoupled, verify there are no remaining callers of `connect_obs`/`disconnect_obs`/`obs_ws`:
```bash
grep -rn "connect_obs\|disconnect_obs\|\.obs_ws" backend/app/ --include="*.py" | grep -v obs_director.py | grep -v "__pycache__"
```
If empty: these three methods can also be removed from `OBSDirector` in a follow-up. For now, leave them in place (they are small and harmless).
