"""自动化导播控制 - OBS 录制 & CS2 Demo 回放控制"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import shutil
import subprocess
import time
import unicodedata
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, List, Literal, Optional, Tuple

from obswebsocket import obsws, requests as obs_requests

from .demo_parser import (
    TICK_RATE as DEMO_TICK_RATE,
    compute_spec_player_slot_one_based,
    get_demo_spec_calibration_tick,
    get_player_list,
    spec_player_extra_offset_for_gsi_failure,
)
from .env_utils import OBSConfig
from .gsi_ready import gsi_status, is_gsi_ready, reset_gsi_ready, wait_gsi_payload_after
from .win_cs2_console import ensure_cs2_foreground, find_cs2_hwnd, inject_console_sequence, send_cs2_space_taps

logger = logging.getLogger(__name__)


def _resolve_gsi_sink_url() -> str:
    """URI written into ``gamestate_integration_*.cfg``; must match the backend listen port."""
    explicit = os.environ.get("CS2_INSIGHT_GSI_URL") or os.environ.get("CS2_INSIGHT_BACKEND_GSI_URL")
    if explicit:
        return explicit.strip()
    try:
        port = int(os.environ.get("CS2_INSIGHT_PORT", "8000") or "8000")
    except ValueError:
        port = 8000
    # CS2 POSTs from the same machine; mirror CS2_INSIGHT_PORT so a non-default
    # uvicorn port still receives GSI (previously defaulted to :8000 only).
    return f"http://127.0.0.1:{port}/api/gsi/cs2"


class RecordingAborted(Exception):
    """用户请求中止录制（中途退出批量/单次任务）。"""


CS2_RUNNING_MESSAGE = "检测到 CS2 正在运行。为避免踢出对局或污染设置，请先手动退出 CS2 后再开始录制。"


class CS2AlreadyRunningError(RuntimeError):
    """Raised when recording would have to take over a user-owned CS2 session."""


class CS2NotReadyError(RuntimeError):
    """Raised when CS2 fails to enter an in-game state (GSI never ready) within the
    recording startup timeout window. Surfaced to frontend as HTTP 409 so the user
    sees the same warning-dialog style as the "CS2 already running" case instead
    of being silently kicked back to the queue with no feedback.
    """


def is_cs2_running() -> bool:
    """Return True when CS2 has either a visible window or a live cs2.exe process."""
    if sys.platform != "win32":
        return bool(find_cs2_hwnd())
    if find_cs2_hwnd():
        return True
    try:
        cp = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
        )
        if "cs2.exe" in (cp.stdout or "").lower():
            return True
    except Exception as e:  # noqa: BLE001
        logger.debug("Could not query cs2.exe via tasklist: %s", e)

    try:
        cp = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "if (Get-Process -Name cs2 -ErrorAction SilentlyContinue) { 'cs2' }",
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        return "cs2" in (cp.stdout or "").lower()
    except Exception as e:  # noqa: BLE001
        logger.debug("Could not query cs2.exe via PowerShell: %s", e)
        return False


TICK_RATE = 64
PRE_ROLL_TICKS = 300  # ~5 seconds of pre-roll（无 kill_ticks 时的传统 seek）
# 智能跳跃分段阈值见 ``build_smart_jump_segments`` 内 _env_int 默认值。

# 仅随录制预热（首次 seek 前、与 Space 后控制台批次）注入，段间 jump_cut 不再重复执行
_WARMUP_FIXED_CONSOLE_LINES: tuple[str, ...] = ("cl_hud_telemetry_frametime_show 0",)
# 录制开始时把玩家所有按键解绑并恢复到一组最小默认绑定。配合下面的「文件级用户配置
# 快照 + 恢复」机制使用：本次 CS2 进程内按键还原为下方默认，让玩家自定义的奇葩 bind
# 不会在 demo 回放/控制台注入期间触发；录制结束（或异常杀进程后下次启动）时再用
# 磁盘备份把用户原配置整体回滚。bind 顺序中 toggleconsole / space 必须保留，否则
# `inject_console_sequence` 与 `send_cs2_space_taps` 会失效。
_RECORDING_KEYBIND_RESET_LINES: tuple[str, ...] = (
    "unbindall",
    "bind F10 toggleconsole",
    "bind ` toggleconsole",
    'bind "SPACE" "+jump"',
    'bind "ESCAPE" "cancelselect"',
    'bind "w" "+forward"',
    'bind "a" "+moveleft"',
    'bind "s" "+back"',
    'bind "d" "+moveright"',
)
_OBS_RECORDING_SCENE_NAME = "CS2 Insight Recording"
_OBS_GAME_CAPTURE_INPUT_NAME = "CS2 Insight Game Capture"
_RECORDING_VIDEO_EXTENSIONS = {".mkv", ".mp4", ".mov", ".flv", ".ts", ".m2ts", ".avi"}


# ── 用户配置磁盘备份 ────────────────────────────────────────────────────
# 每次录制启动时把玩家当前磁盘上的 CS2 配置文件原样拷一份到
#   ``<repo>/.cs2_config_backup/``
# 下，并写一个 ``manifest.json`` 记录每个备份文件对应的原始绝对路径。下一次录制
# 启动时会**清空整个目录再重写**，因此项目里只会保留"最近一次录制前的玩家配置"。
# 这样玩家原始 cfg 始终有一份在项目目录里可手动取用，运行期则继续靠 ``OBSDirector.
# _user_config_snapshot`` 内存快照在 taskkill CS2 后自动还原。
_BACKUP_DIR_NAME = ".cs2_config_backup"
_BACKUP_MANIFEST_NAME = "manifest.json"


def _backup_root() -> Path:
    """Return the project-root backup directory.

    固定指向**本仓库根**（``backend/app/obs_director.py`` → 上溯三级 = repo root），
    不跟随 ``CS2_INSIGHT_CONFIG`` 环境变量漂移到玩家的 AppData 之类目录。
    便携包解压到哪儿，备份就放在哪儿，方便玩家自行翻出原始 cfg。
    """
    try:
        return Path(__file__).resolve().parents[2] / _BACKUP_DIR_NAME
    except Exception:  # noqa: BLE001
        return Path.cwd() / _BACKUP_DIR_NAME


def _write_persistent_backup(snap: "dict[Path, Optional[bytes]]") -> Optional[Path]:
    """清空 ``<repo>/.cs2_config_backup/`` 后把当前内存快照落盘。返回备份目录路径。"""
    if not snap:
        return None
    import json

    backup_dir = _backup_root()
    try:
        if backup_dir.exists():
            shutil.rmtree(backup_dir, ignore_errors=True)
        backup_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning("Persistent backup mkdir %s failed: %s", backup_dir, e)
        return None
    entries: list[dict] = []
    for idx, (orig_path, original) in enumerate(snap.items()):
        entry: dict = {
            "original": str(orig_path),
            "existed": original is not None,
        }
        if original is not None:
            # 文件名沿用原始 basename 便于人工阅读，前缀加序号避免不同目录下的同名碰撞
            rel = f"{idx:04d}_{orig_path.name}"
            target = backup_dir / rel
            try:
                target.write_bytes(original)
            except OSError as e:
                logger.warning("Persistent backup write %s failed: %s", target, e)
                continue
            entry["backup_relpath"] = rel
        entries.append(entry)
    manifest = {
        "version": 3,
        "created_at": time.time(),
        "created_at_iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        "entries": entries,
    }
    try:
        (backup_dir / _BACKUP_MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as e:
        logger.warning("Persistent backup manifest write failed: %s", e)
        return None
    logger.info(
        "Persistent backup written: %s (%d files)",
        backup_dir,
        len([e for e in entries if e.get("existed")]),
    )
    return backup_dir


def _clip_kill_ticks_sorted(clip: dict) -> list[int]:
    raw = clip.get("kill_ticks")
    if not raw:
        return []
    out: list[int] = []
    for x in raw:
        try:
            t = int(x)
        except (TypeError, ValueError):
            continue
        if t >= 0:
            out.append(t)
    return sorted(set(out))


def _clip_kill_ticks_in_order(clip: dict) -> list[int]:
    raw = clip.get("kill_ticks")
    if not raw:
        return []
    out: list[int] = []
    for x in raw:
        try:
            t = int(x)
        except (TypeError, ValueError):
            continue
        if t >= 0:
            out.append(t)
    return out


def _env_int(key: str, default: int) -> int:
    try:
        return int(float((os.environ.get(key) or str(default)).strip()))
    except ValueError:
        return int(default)


def _clip_death_tick(clip: dict) -> Optional[int]:
    raw = clip.get("death_tick")
    if raw is None or not str(raw).strip():
        return None
    try:
        tick = int(raw)
    except (TypeError, ValueError):
        return None
    return tick if tick >= 0 else None


def build_smart_jump_segments(clip: dict) -> list[tuple[int, int]]:
    start_tick = max(0, int(clip.get("start_tick") or 0))
    end_tick = max(start_tick, int(clip.get("end_tick") or 0))

    raw_source_ticks = clip.get("source_ticks") or []
    if str(clip.get("category") or "").strip() == "compilation" and raw_source_ticks:
        source_records: list[tuple[int, int, int, int]] = []
        kill_ticks_for_source = _clip_kill_ticks_in_order(clip)
        source_rounds = clip.get("source_rounds") or []
        for idx, item in enumerate(raw_source_ticks):
            try:
                ss = int(item[0])
                ee = int(item[1])
            except (TypeError, ValueError, IndexError):
                continue
            ss = max(0, ss)
            ee = max(ss + 1, ee)
            kt = int(kill_ticks_for_source[idx]) if idx < len(kill_ticks_for_source) else ss
            try:
                rn = int(source_rounds[idx]) if idx < len(source_rounds) else 0
            except (TypeError, ValueError):
                rn = 0
            source_records.append((ss, ee, kt, rn))
        source_records.sort(key=lambda rec: (rec[0], rec[2]))
        source_segments: list[tuple[int, int]] = []
        if str(clip.get("compilation_kind") or "") == "all_kills" and source_records:
            source_override = clip.get("pacing_override") or {}
            raw_gap = source_override.get("max_gap_sec") if isinstance(source_override, dict) else None
            if raw_gap is not None and str(raw_gap).strip():
                max_gap_ticks = max(1, int(float(raw_gap) * DEMO_TICK_RATE))
            else:
                max_gap_ticks = _env_int("CS2_INSIGHT_SMART_MAX_GAP_TICKS", int(DEMO_TICK_RATE * 12.0))
            cur_s = cur_e = cur_kt = cur_rn = 0
            for ss, ee, kt, rn in source_records:
                if source_segments and rn == cur_rn and kt - cur_kt <= max_gap_ticks:
                    cur_e = max(cur_e, ee)
                    source_segments[-1] = (cur_s, cur_e)
                else:
                    cur_s, cur_e, cur_kt, cur_rn = ss, ee, kt, rn
                    source_segments.append((cur_s, cur_e))
                    continue
                cur_kt = kt
        else:
            source_segments = [(ss, ee) for ss, ee, _kt, _rn in source_records]
        if source_segments:
            logger.info(
                "[build_segments] compilation source_ticks clip_id=%s segments=%s",
                clip.get("clip_id"),
                source_segments,
            )
            return source_segments

    kills = list(_clip_kill_ticks_sorted(clip))

    # 虽败犹荣：仅当片段携带了明确的"虽败犹荣"叙事标签时，才将 death_tick 追加进锚点链，
    # 形成「高光击杀 → jump-cut → 死亡结局」的完整叙事弧线。
    # 普通高光片段（颗秒、跳杀等）即使输了回合也不应录到死亡画面。
    _NICE_TRY_TAGS = frozenset({
        "😤 1v2 饮恨",
        "💸 ECO反击 (差点成了)",
        "🛡️ 赛点失守",
        "📉 绝地追分未果",
        "⛰️ 天王山饮恨",
    })
    _ctx_tags = clip.get("context_tags") or []
    _has_nice_try = any(
        t in _NICE_TRY_TAGS or (isinstance(t, str) and t.startswith("💀 1v"))
        for t in _ctx_tags
    )
    _death_tick_raw = clip.get("death_tick")
    if _death_tick_raw and clip.get("round_won") is False and _has_nice_try:
        _death_tick = int(_death_tick_raw)
        # 只在死亡晚于最后一杀时追加（否则 end_tick 已覆盖）
        if not kills or _death_tick > kills[-1]:
            kills = kills + [_death_tick]

    override = clip.get("pacing_override") or {}
    if not isinstance(override, dict):
        override = {}

    def _get_override_ticks(key: str, default_env_key: str, default_sec: float) -> int:
        val = override.get(key)
        if val is not None and str(val).strip():
            return max(0, int(float(val) * DEMO_TICK_RATE))
        return _env_int(default_env_key, int(DEMO_TICK_RATE * default_sec))

    PRE_FIRST = _get_override_ticks("pre_first_sec", "CS2_INSIGHT_SMART_PRE_FIRST_TICKS", 5.5)
    # POST_LAST: 最后一杀后的缓冲。需足够长以保证 demo_gototick 关键帧对齐后击杀动画可见。
    POST_LAST = _get_override_ticks("post_last_sec", "CS2_INSIGHT_SMART_POST_LAST_TICKS", 3.0)
    MAX_GAP = max(1, _get_override_ticks("max_gap_sec", "CS2_INSIGHT_SMART_MAX_GAP_TICKS", 12.0))
    # PRE_CONT: jump-cut 后续段的预卷。CS2 Demo 关键帧间距可达 4~8 秒，1.5s 不够；
    # 改为 5.0s 确保 demo_gototick 即使过冲最坏情况也能在击杀前稳定落帧。
    PRE_CONT = _get_override_ticks("pre_cont_sec", "CS2_INSIGHT_SMART_PRE_CONT_TICKS", 5.0)
    POST_MID = _get_override_ticks("post_mid_sec", "CS2_INSIGHT_SMART_POST_MID_TICKS", 1.5)

    # clip_min_tick = round_freeze_end_tick，防止 seg_start 穿越到上一回合黑屏区域
    clip_min_tick = max(0, int(clip.get("clip_min_tick") or 0))
    clip_min_guard_ticks = _get_override_ticks(
        "clip_min_guard_sec",
        "CS2_INSIGHT_SMART_CLIP_MIN_GUARD_TICKS",
        0.35,
    )
    clip_min_start_tick = clip_min_tick + clip_min_guard_ticks if clip_min_tick > 0 else 0
    # clip_max_tick：本回合 demo 安全录制上限（超出则比赛结算界面单向锁定渲染）
    _cmt_raw = clip.get("clip_max_tick")
    clip_max_tick = int(_cmt_raw) if _cmt_raw else 0
    logger.info(
        "[build_segments] clip_id=%s round=%s clip_max_tick=%s kills=%s override=%s",
        clip.get("clip_id"),
        clip.get("round"),
        clip_max_tick,
        kills,
        override,
    )

    if not kills:
        has_single_segment_override = any(k in override for k in ("pre_first_sec", "post_last_sec"))
        if not has_single_segment_override:
            return [(start_tick, end_tick)]

        anchor_tick = None
        if _death_tick_raw is not None and str(_death_tick_raw).strip():
            try:
                anchor_tick = int(_death_tick_raw)
            except Exception:
                anchor_tick = None
        if anchor_tick is None:
            anchor_tick = min(end_tick, start_tick + PRE_ROLL_TICKS)

        seg_start = max(0, anchor_tick - PRE_FIRST)
        if clip_min_start_tick > 0:
            seg_start = max(seg_start, clip_min_start_tick)
        seg_end = anchor_tick + POST_LAST
        if clip_max_tick > 0:
            seg_end = min(seg_end, clip_max_tick)
        if seg_end <= seg_start:
            seg_end = seg_start + 1
        segment = (seg_start, seg_end)
        logger.info(
            "[build_segments] no_kill_segment clip_id=%s anchor=%s segment=%s",
            clip.get("clip_id"),
            anchor_tick,
            segment,
        )
        return [segment]

    clusters: list[list[int]] = []
    for t in kills:
        if not clusters:
            clusters.append([t])
        elif t - clusters[-1][-1] <= MAX_GAP:
            clusters[-1].append(t)
        else:
            clusters.append([t])

    ncl = len(clusters)
    segments: list[tuple[int, int]] = []
    for ci, cl in enumerate(clusters):
        pre = PRE_FIRST if ci == 0 else PRE_CONT
        raw_start = max(0, cl[0] - pre)
        # 对第一段强制不早于 round_freeze_end_tick 后一点点，避免把回合刚开始的杂帧录进去。
        if ci == 0 and clip_min_start_tick > 0:
            raw_start = max(raw_start, clip_min_start_tick)
        seg_start = raw_start
        seg_end = cl[-1] + (POST_LAST if ci == ncl - 1 else POST_MID)
        # 裁剪到回合安全上限：超出后 CS2 进入结算界面，倒退 seek 无法恢复画面
        if clip_max_tick > 0:
            seg_end = min(seg_end, clip_max_tick)
        if seg_end <= seg_start:
            seg_end = seg_start + 1
        segments.append((seg_start, seg_end))

    merged: list[tuple[int, int]] = []
    for s, e in segments:
        if not merged:
            merged.append((s, e))
        else:
            last_s, last_e = merged[-1]
            if s <= last_e:
                merged[-1] = (last_s, max(last_e, e))
            else:
                merged.append((s, e))

    # 扩展最后一段以覆盖 clip end_tick（极限拆包）。
    if merged and end_tick > 0:
        ls, le = merged[-1]
        if end_tick > le:
            le_ext = min(end_tick, clip_max_tick) if clip_max_tick > 0 else end_tick
            if le_ext > le:
                merged[-1] = (ls, le_ext)
    # 扩展第一段以覆盖 clip start_tick（拆包后击杀）。
    if merged and start_tick > 0:
        fs, fe = merged[0]
        if start_tick < fs:
            fs_ext = max(start_tick, clip_min_start_tick) if clip_min_start_tick > 0 else start_tick
            if fs_ext < fs:
                merged[0] = (fs_ext, fe)

    logger.info("[build_segments] final_segments clip_id=%s segments=%s", clip.get("clip_id"), merged)
    return merged


class DirectorState(str, Enum):
    IDLE = "idle"
    LAUNCHING_CS2 = "launching_cs2"
    LOADING_DEMO = "loading_demo"
    SEEKING = "seeking"
    RECORDING = "recording"
    STOPPING = "stopping"
    COMPLETED = "completed"
    ERROR = "error"


@dataclass
class RecordingTask:
    clip_id: str
    start_tick: int
    end_tick: int
    duration_seconds: float


@dataclass
class RecordingWarmupExtras:
    """一键录制前预热阶段注入的观战相关 cvar，及本次 CS2 启动分辨率。"""

    cl_draw_only_deathnotices: bool = True
    spec_show_xray: int = 0  # 0 或 1
    fov_cs_debug: Optional[float] = None  # None 表示不注入
    resolution_width: Optional[int] = None
    resolution_height: Optional[int] = None
    hud_showtargetid_hide: bool = True
    tv_nochat: bool = True
    viewmodel_fov_68: bool = False
    snd_voipvolume_mute: bool = True
    # Demo 底部时间轴 / 回放控制条：社区常用需先 sv_cheats 1 再 demoui false
    hide_demo_playback_ui: bool = True
    # 投掷物抛物线 + 画中窗预览
    hide_grenade_trajectory_pip: bool = True
    # 与 cs2_video.txt / video.cfg 中 setting.aspectratiomode 一致：0=4:3，1=16:9，2=16:10
    aspect_ratio: Optional[Literal["4:3", "16:9", "16:10"]] = None
    # 若前端传入非空列表，则优先使用该顺序注入（须已含各 cvar）；否则由静态方法从布尔字段拼装
    console_cmds: Optional[tuple[str, ...]] = None


# CS2 视频设置「宽高比」下拉与 setting.aspectratiomode 枚举（社区常用映射）。
_ASPECT_RATIO_VIDEOCFG_MODE: dict[str, int] = {"4:3": 0, "16:9": 1, "16:10": 2}


class OBSDirector:
    """Controls OBS recording and CS2 demo playback for automated clip capture."""

    def __init__(
        self,
        obs_config: OBSConfig,
        cs2_path: str,
        on_state_change: Optional[Callable[[DirectorState, str], None]] = None,
        abort_event: Optional[asyncio.Event] = None,
        cs2_fps_max: int = 240,
    ):
        self.obs_config = obs_config
        self.cs2_path = cs2_path
        self._cs2_fps_max: int = max(0, min(int(cs2_fps_max), 9999))
        self._ws: Optional[obsws] = None
        self._cs2_process: Optional[subprocess.Popen] = None
        self._on_state_change = on_state_change
        self._state = DirectorState.IDLE
        self._copied_demo: Optional[Path] = None
        self._copied_cfg: Optional[Path] = None
        self._copied_gsi_cfg: Optional[Path] = None
        self._obs_cursor_restore: list[tuple[str, bool]] = []
        self._obs_managed_scene_ready = False
        self._obs_managed_input_ready = False
        self._spec_calibration_by_demo: dict[str, dict[str, int]] = {}
        self._spec_parse_fallback_offset_by_demo: dict[str, int] = {}
        self._demo_steam_by_name_cache: dict[str, dict[str, str]] = {}
        self._abort_event = abort_event
        # 录制期最近一次使用的 warmup 选项（预留给未来的兜底恢复路径；当前文件级
        # snapshot + restore 方案已足够保护用户配置）。
        self._last_warmup: Optional[RecordingWarmupExtras] = None
        # 启动 CS2 前对用户配置文件做的字节级快照：{Path: bytes | None}。
        # value=None 代表该文件原本不存在，restore 时需要删除 CS2 新建的同名文件。
        self._user_config_snapshot: dict[Path, Optional[bytes]] = {}

    def _set_state(self, state: DirectorState, detail: str = ""):
        self._state = state
        if self._on_state_change:
            self._on_state_change(state, detail)
        logger.info("Director state -> %s: %s", state.value, detail)

    def _abort_requested(self) -> bool:
        return self._abort_event is not None and self._abort_event.is_set()

    def _check_abort(self) -> None:
        if self._abort_requested():
            raise RecordingAborted()

    async def _sleep_abortable(self, seconds: float, step: float = 0.25) -> None:
        if seconds <= 0:
            return
        if self._abort_event is None:
            await asyncio.sleep(seconds)
            return
        deadline = time.monotonic() + float(seconds)
        while time.monotonic() < deadline:
            if self._abort_event.is_set():
                raise RecordingAborted()
            await asyncio.sleep(min(step, deadline - time.monotonic()))

    def _safe_stop_obs_recording(self) -> None:
        if not self._ws:
            return
        try:
            req_resume = getattr(obs_requests, "ResumeRecord", None)
            if req_resume is not None:
                try:
                    self._ws.call(req_resume())
                except Exception:
                    pass
            self._ws.call(obs_requests.StopRecord())
        except Exception as e:
            logger.debug("StopRecord (abort cleanup): %s", e)

    async def _run_cleanup_step(self, label: str, func: Callable[[], None], timeout: float = 20.0) -> None:
        """Run blocking teardown away from the FastAPI event loop."""
        try:
            await asyncio.wait_for(asyncio.to_thread(func), timeout=max(1.0, float(timeout)))
        except asyncio.TimeoutError:
            logger.error("%s timed out after %.1fs; backend will stay alive and continue serving API", label, timeout)
        except Exception as e:  # noqa: BLE001
            logger.exception("%s failed during recording cleanup: %s", label, e)

    async def _cleanup_recording_session(self) -> None:
        await self._run_cleanup_step("OBS disconnect", self.disconnect_obs, timeout=8.0)
        await self._run_cleanup_step("CS2 shutdown", self._kill_cs2, timeout=30.0)
        await self._run_cleanup_step("CS2 artifact cleanup", self._cleanup_cs2_artifacts, timeout=8.0)

    @staticmethod
    def _append_aborted_results_for_tail(
        demo_jobs: list[tuple[Path, list[dict], Optional[str], Optional[int]]],
        job_idx: int,
        after_clip_idx: int,
        all_results: list[dict],
    ) -> None:
        """将同一 job 中 after_clip_idx 之后的片段及后续 job 全部标记为 aborted。"""
        dem_path, clips, _, _ = demo_jobs[job_idx]
        demo_name = dem_path.name
        for idx in range(after_clip_idx + 1, len(clips)):
            c = clips[idx]
            all_results.append({"clip_id": c["clip_id"], "status": "aborted", "demo_filename": demo_name})
        for j in range(job_idx + 1, len(demo_jobs)):
            dp, cls, _, _ = demo_jobs[j]
            n = dp.name
            for c in cls:
                all_results.append({"clip_id": c["clip_id"], "status": "aborted", "demo_filename": n})

    @property
    def state(self) -> DirectorState:
        return self._state

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

    def disconnect_obs(self):
        if self._ws:
            try:
                self._ws.disconnect()
            except Exception:
                pass
            self._ws = None

    def test_obs_connection(self) -> dict:
        """Quick connection test — returns version info or error."""
        prev_ws = self._ws
        try:
            ws = obsws(self.obs_config.host, self.obs_config.port, self.obs_config.password)
            ws.connect()
            ver = ws.call(obs_requests.GetVersion())
            self._ws = ws
            scene_ready = self._obs_ensure_managed_recording_scene()
            ws.disconnect()
            self._ws = prev_ws
            return {
                "ok": True,
                "obs_version": ver.getObsVersion(),
                "ws_version": ver.getObsWebSocketVersion(),
                "managed_scene_ready": scene_ready,
                "managed_input_ready": self._obs_managed_input_ready,
            }
        except Exception as e:
            self._ws = prev_ws
            return {"ok": False, "error": str(e)}

    def _obs_ensure_managed_recording_scene(self) -> bool:
        """Ensure the app-owned OBS scene and game capture exist without changing the active scene."""
        if not self._ws:
            return False
        if os.environ.get("CS2_INSIGHT_AUTO_OBS_SCENE", "1").strip().lower() in (
            "0",
            "false",
            "no",
        ):
            return False

        scene_name = (os.environ.get("CS2_INSIGHT_OBS_SCENE_NAME") or _OBS_RECORDING_SCENE_NAME).strip()
        if not scene_name:
            scene_name = _OBS_RECORDING_SCENE_NAME

        try:
            resp = self._ws.call(obs_requests.GetSceneList())
            scenes = getattr(resp, "datain", {}).get("scenes") or []
            for scene in scenes:
                if isinstance(scene, dict) and str(scene.get("sceneName") or "") == scene_name:
                    self._obs_managed_scene_ready = True
                    logger.info("OBS managed recording scene already exists: %s", scene_name)
                    self._obs_ensure_managed_game_capture(scene_name)
                    return True
        except Exception as e:
            logger.warning("OBS GetSceneList failed; cannot prepare managed scene: %s", e)
            return False

        try:
            self._ws.call(obs_requests.CreateScene(sceneName=scene_name))
            self._obs_managed_scene_ready = True
            logger.info("OBS managed recording scene created: %s", scene_name)
            self._obs_ensure_managed_game_capture(scene_name)
            return True
        except Exception as e:
            logger.warning("OBS CreateScene %r failed: %s", scene_name, e)
            return False

    def _obs_ensure_managed_game_capture(self, scene_name: str) -> bool:
        """Ensure the app-owned Game Capture input exists in the managed scene."""
        if not self._ws:
            return False
        if os.environ.get("CS2_INSIGHT_AUTO_OBS_GAME_CAPTURE", "1").strip().lower() in (
            "0",
            "false",
            "no",
        ):
            return False

        input_name = (os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_NAME") or _OBS_GAME_CAPTURE_INPUT_NAME).strip()
        if not input_name:
            input_name = _OBS_GAME_CAPTURE_INPUT_NAME

        if self._obs_scene_has_source(scene_name, input_name):
            self._obs_apply_managed_game_capture_settings(input_name)
            self._obs_apply_managed_game_capture_transform(scene_name, input_name)
            self._obs_managed_input_ready = True
            logger.info("OBS managed game capture already in scene: %s", input_name)
            return True

        input_exists = False
        try:
            resp = self._ws.call(obs_requests.GetInputList())
            inputs = getattr(resp, "datain", {}).get("inputs") or []
            input_exists = any(
                isinstance(it, dict) and str(it.get("inputName") or "") == input_name
                for it in inputs
            )
        except Exception as e:
            logger.warning("OBS GetInputList failed; cannot inspect managed game capture: %s", e)

        if input_exists:
            try:
                self._ws.call(obs_requests.CreateSceneItem(sceneName=scene_name, sourceName=input_name))
                self._obs_apply_managed_game_capture_settings(input_name)
                self._obs_apply_managed_game_capture_transform(scene_name, input_name)
                self._obs_managed_input_ready = True
                logger.info("OBS managed game capture linked into scene: %s", input_name)
                return True
            except Exception as e:
                logger.warning("OBS CreateSceneItem %r -> %r failed: %s", input_name, scene_name, e)
                return False

        settings = self._obs_managed_game_capture_settings()
        try:
            self._ws.call(
                obs_requests.CreateInput(
                    sceneName=scene_name,
                    inputName=input_name,
                    inputKind=os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_KIND", "game_capture").strip()
                    or "game_capture",
                    inputSettings=settings,
                    sceneItemEnabled=True,
                )
            )
            self._obs_apply_managed_game_capture_transform(scene_name, input_name)
            self._obs_managed_input_ready = True
            logger.info("OBS managed game capture created: %s in %s", input_name, scene_name)
            return True
        except Exception as e:
            logger.warning("OBS CreateInput game capture %r failed: %s", input_name, e)
            return False

    def _obs_managed_game_capture_settings(self) -> dict:
        window = (
            os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_WINDOW")
            or self._obs_cs2_window_setting()
            or "Counter-Strike 2:SDL_app:cs2.exe"
        ).strip()
        return {
            "capture_mode": os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_MODE", "window").strip() or "window",
            "window": window,
            "capture_cursor": False,
        }

    def _obs_apply_managed_game_capture_settings(self, input_name: str) -> bool:
        if not self._ws:
            return False
        try:
            self._ws.call(
                obs_requests.SetInputSettings(
                    inputName=input_name,
                    inputSettings=self._obs_managed_game_capture_settings(),
                    overlay=True,
                )
            )
            logger.info("OBS managed game capture settings applied: %s", input_name)
            return True
        except Exception as e:
            logger.warning("OBS SetInputSettings game capture %r failed: %s", input_name, e)
            return False

    def _obs_apply_managed_game_capture_transform(self, scene_name: str, input_name: str) -> bool:
        """Stretch the managed game capture source to the OBS canvas."""
        if not self._ws:
            return False
        if os.environ.get("CS2_INSIGHT_OBS_STRETCH_GAME_CAPTURE", "1").strip().lower() in (
            "0",
            "false",
            "no",
        ):
            return False

        scene_item_id = self._obs_find_scene_item_id(scene_name, input_name)
        if scene_item_id is None:
            logger.warning("OBS managed game capture scene item not found: %s in %s", input_name, scene_name)
            return False

        try:
            resp = self._ws.call(obs_requests.GetVideoSettings())
            video = getattr(resp, "datain", {}) or {}
            base_width = int(video.get("baseWidth") or video.get("base_width") or 1920)
            base_height = int(video.get("baseHeight") or video.get("base_height") or 1080)
        except Exception as e:
            logger.warning("OBS GetVideoSettings failed; using 1920x1080 transform fallback: %s", e)
            base_width = 1920
            base_height = 1080

        transform = {
            "positionX": 0,
            "positionY": 0,
            "rotation": 0,
            "scaleX": 1,
            "scaleY": 1,
            "cropTop": 0,
            "cropBottom": 0,
            "cropLeft": 0,
            "cropRight": 0,
            "boundsType": os.environ.get("CS2_INSIGHT_OBS_BOUNDS_TYPE", "OBS_BOUNDS_STRETCH").strip()
            or "OBS_BOUNDS_STRETCH",
            "boundsAlignment": 5,
            "boundsWidth": base_width,
            "boundsHeight": base_height,
            "alignment": 5,
        }
        try:
            self._ws.call(
                obs_requests.SetSceneItemTransform(
                    sceneName=scene_name,
                    sceneItemId=scene_item_id,
                    sceneItemTransform=transform,
                )
            )
            logger.info("OBS managed game capture stretched to canvas: %sx%s", base_width, base_height)
            return True
        except Exception as e:
            logger.warning("OBS SetSceneItemTransform %r failed: %s", input_name, e)
            return False

    @staticmethod
    def _obs_cs2_window_setting() -> str:
        if sys.platform != "win32":
            return ""
        hwnd = find_cs2_hwnd()
        if not hwnd:
            return ""
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            title_len = user32.GetWindowTextLengthW(hwnd) + 1
            title_buf = ctypes.create_unicode_buffer(max(2, title_len))
            user32.GetWindowTextW(hwnd, title_buf, len(title_buf))
            title = title_buf.value or "Counter-Strike 2"

            class_buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_buf, len(class_buf))
            class_name = class_buf.value or "SDL_app"

            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            exe_name = "cs2.exe"
            if pid.value:
                PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
                if handle:
                    try:
                        path_buf = ctypes.create_unicode_buffer(1024)
                        size = wintypes.DWORD(len(path_buf))
                        if kernel32.QueryFullProcessImageNameW(handle, 0, path_buf, ctypes.byref(size)):
                            exe_name = Path(path_buf.value).name or exe_name
                    finally:
                        kernel32.CloseHandle(handle)

            return f"{title}:{class_name}:{exe_name}"
        except Exception as e:
            logger.debug("Could not build OBS CS2 window selector: %s", e)
            return ""

    def _obs_scene_has_source(self, scene_name: str, source_name: str) -> bool:
        return self._obs_find_scene_item_id(scene_name, source_name) is not None

    def _obs_find_scene_item_id(self, scene_name: str, source_name: str) -> Optional[int]:
        if not self._ws:
            return None
        try:
            resp = self._ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
            items = getattr(resp, "datain", {}).get("sceneItems") or []
        except Exception:
            return None
        for item in items:
            if not isinstance(item, dict):
                continue
            item_source = item.get("sourceName") or item.get("sceneItemSourceName")
            if str(item_source or "") != source_name:
                continue
            try:
                return int(item.get("sceneItemId"))
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _playdemo_arg(demo_abs: Path) -> str:
        """Source 对 Windows 绝对路径常用正斜杠。"""
        return str(demo_abs.resolve()).replace("\\", "/")

    @staticmethod
    def _game_root_from_cs2_exe(cs2: Path) -> Optional[Path]:
        """
        从 .../game/bin/win64/cs2.exe 解析出 game 目录（内含 csgo/）。
        CS2 对 +playdemo 放在 Temp 等目录外的路径支持很差，应把 .dem 放进 game/csgo/ 再播。
        """
        try:
            c = cs2.resolve()
            if c.name.lower() != "cs2.exe":
                return None
            game = c.parents[2]
            if (game / "csgo").is_dir() and (game / "bin" / "win64" / "cs2.exe").is_file():
                return game
        except (IndexError, OSError):
            return None
        return None

    def _cleanup_cs2_artifacts(self) -> None:
        for label, p in (
            ("demo", self._copied_demo),
            ("cfg", self._copied_cfg),
            ("gsi cfg", self._copied_gsi_cfg),
        ):
            if p and p.is_file():
                try:
                    p.unlink()
                except OSError as e:
                    logger.warning("Could not remove copied %s: %s", label, e)
        self._copied_demo = None
        self._copied_cfg = None
        self._copied_gsi_cfg = None

    def _launch_cs2(self, demo_abs: Path, warmup: Optional[RecordingWarmupExtras] = None) -> None:
        """
        将 Demo 复制到 CS2 的 game/csgo/ 下再以 +playdemo 启动。
        Source 2 对 Temp 等目录的绝对路径 +playdemo 常无效；工作目录需为 game/。
        """
        self._last_warmup = warmup
        if not demo_abs.is_file():
            raise FileNotFoundError(f"Demo file not found: {demo_abs}")
        cs2 = Path(self.cs2_path)
        if not cs2.exists():
            raise FileNotFoundError(f"cs2.exe not found at {self.cs2_path}")

        if is_cs2_running():
            logger.warning("Recording blocked because CS2 is already running")
            raise CS2AlreadyRunningError(CS2_RUNNING_MESSAGE)

        # 启动 CS2 前先对用户配置做快照；CS2 运行期的 archive cvar 写入在
        # _kill_cs2 末尾会被整段回滚，保护用户自定义设置不受录制影响。
        self._snapshot_user_configs()
        self._cleanup_cs2_artifacts()

        game_root = self._game_root_from_cs2_exe(cs2)
        if not game_root:
            raise FileNotFoundError(
                "无法从 cs2.exe 推断 game 目录（应为 .../game/bin/win64/cs2.exe）。请检查侧栏中的 CS2 路径是否指向正版安装。",
            )

        csgo_dir = game_root / "csgo"
        dest_name = f"_insight_{uuid.uuid4().hex}.dem"
        dest = csgo_dir / dest_name
        shutil.copy2(demo_abs, dest)
        self._copied_demo = dest

        cfg_dir = csgo_dir / "cfg"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        stem = dest.stem  # _insight_<uuid>
        cfg_path = cfg_dir / f"{stem}.cfg"
        # 用 cfg 里 playdemo 比单独 +playdemo 在 CS2 上更稳；路径仅 ASCII
        # engine_no_focus_sleep 0 关闭 Source 2 失焦节流（默认 50ms/帧 ≈ 20fps）。
        # fps_max 固定走启动项 ``+fps_max``，这里不再通过 cfg / console 重复设置。
        console_toggle_key = (os.environ.get("CS2_INSIGHT_CONSOLE_TOGGLE_KEY") or "F10").strip().upper()
        if console_toggle_key in {"~", "OEM_3"}:
            console_toggle_key = "`"
        elif console_toggle_key not in {"`", *{f"F{i}" for i in range(1, 13)}}:
            console_toggle_key = "F10"
        console_bind_lines = [f'bind "{console_toggle_key}" "toggleconsole"']
        if console_toggle_key != "F10":
            console_bind_lines.append('bind "F10" "toggleconsole"')
        cfg_lines = [
            "engine_no_focus_sleep 0",
            "cl_demo_predict 0",
            "cl_spec_show_bindings 0",
            "con_enable 1",
            *console_bind_lines,
            f'playdemo "{stem}.dem"',
        ]
        cfg_path.write_text("\n".join(cfg_lines) + "\n", encoding="ascii")
        self._copied_cfg = cfg_path

        reset_gsi_ready()
        gsi_url = _resolve_gsi_sink_url()
        gsi_path = cfg_dir / f"gamestate_integration_{stem}.cfg"
        logger.info("GSI HTTP sink (gamestate cfg): %s -> %s", gsi_url, gsi_path)
        gsi_lines = [
            '"CS2 Insight Agent"',
            "{",
            f'  "uri" "{gsi_url}"',
            '  "timeout" "1.0"',
            '  "buffer" "0.1"',
            '  "throttle" "0.1"',
            '  "heartbeat" "1.0"',
            '  "data"',
            "  {",
            '    "provider" "1"',
            '    "map" "1"',
            '    "round" "1"',
            '    "player_id" "1"',
            '    "player_state" "1"',
            '    "allplayers_id" "1"',
            '    "phase_countdowns" "1"',
            "  }",
            "}",
        ]
        gsi_path.write_text("\n".join(gsi_lines) + "\n", encoding="ascii")
        self._copied_gsi_cfg = gsi_path

        cwd = str(game_root)
        # 未从 Steam 客户端启动时，不设 SteamAppId 可能导致卡在主界面 / 不进 demo
        child_env = os.environ.copy()
        child_env["SteamAppId"] = "730"
        child_env["SteamGameId"] = "730"
        # Recording forces fullscreen for this CS2 process only. The user config
        # snapshot/restore below keeps the player's original video settings untouched.
        argv: List[str] = [
            str(cs2),
            "-console", "-novid", "-insecure", "-worldwide", "-fullscreen", "-allow_third_party_software",
            # 失焦不降速（见下方 cfg 注释）——命令行 +cvar 在 +exec 之前生效，
            # 双层设置确保从启动第 0 帧起就关闭 Source 2 的后台节流。
            "+engine_no_focus_sleep", "0",
            # fps_max 同样固定走启动项，避免录制期再经 cfg / console 改写。
            "+fps_max", str(self._cs2_fps_max),
            # 关闭TrueView
            "+cl_demo_predict", "0",
        ]

        if warmup is not None:
            w, h = warmup.resolution_width, warmup.resolution_height
            if w is not None and h is not None and int(w) > 0 and int(h) > 0:
                argv.extend(["-w", str(int(w)), "-h", str(int(h))])
                arm = warmup.aspect_ratio
                mode = _ASPECT_RATIO_VIDEOCFG_MODE.get(arm) if arm else None
                if mode is not None:
                    argv.extend(["+setting.aspectratiomode", str(mode)])

        argv.extend(["+exec", stem])
        logger.info("Launch CS2 cwd=%s cmd=%s", cwd, " ".join(argv))
        creationflags = 0
        stdin = stdout = stderr = None
        if sys.platform == "win32":
            creationflags = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "DETACHED_PROCESS", 0)
            )
            stdin = subprocess.DEVNULL
            stdout = subprocess.DEVNULL
            stderr = subprocess.DEVNULL
        self._cs2_process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=child_env,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
            creationflags=creationflags,
        )

    async def _await_gsi_startup_gate(self) -> bool:
        """等待 CS2 真正进入游戏画面（GSI 上报 map/round 等"非 menu/loading"状态）。

        历史上默认 25s 超时后 **静默继续**，玩家若机器较慢仍卡在读条页，
        我们会在加载界面注入控制台命令导致命令丢失/录制失败。现改为：
        1) 默认超时拉长到 ``CS2_INSIGHT_GSI_READY_TIMEOUT_SEC``（默认 120s）；
        2) 超时后 **抛 RuntimeError 中止本次录制**，由上层 finally 走标准
           cleanup（包含 _kill_cs2 → _restore_user_configs → 删除磁盘备份）。
        如需老的"超时仍继续"宽松行为，可设 ``CS2_INSIGHT_GSI_TIMEOUT_FATAL=0``。
        """
        gsi_timeout = self._env_float("CS2_INSIGHT_GSI_READY_TIMEOUT_SEC", "120.0")
        logger.info("Waiting up to %.1fs for CS2 GSI ready before normal recording startup", gsi_timeout)
        deadline = time.monotonic() + max(0.0, gsi_timeout)
        while time.monotonic() < deadline:
            self._check_abort()
            if is_gsi_ready():
                logger.info("CS2 GSI ready before timeout; continuing recording startup")
                return True
            await asyncio.sleep(0.2)
        if is_gsi_ready():
            logger.info("CS2 GSI ready at timeout boundary; continuing recording startup")
            return True
        fatal = (os.environ.get("CS2_INSIGHT_GSI_TIMEOUT_FATAL", "1") or "1").strip().lower() not in (
            "0", "false", "no", "off",
        )
        msg = (
            f"CS2 GSI 在 {gsi_timeout:.0f}s 内未就绪：CS2 仍在加载/未进入游戏画面。"
            "已中止本次录制以避免在读条页面注入控制台命令。"
        )
        if fatal:
            logger.error(msg)
            raise CS2NotReadyError(msg)
        logger.warning("CS2 GSI ready timeout after %.1fs; continuing (FATAL=0)", gsi_timeout)
        return False

    @staticmethod
    def _norm_steam_id(val: object) -> Optional[str]:
        if val is None:
            return None
        try:
            if isinstance(val, int):
                i = int(val)
            else:
                s = str(val).strip()
                if not s or s.lower() == "nan":
                    return None
                if s.endswith(".0") and s[:-2].isdigit():
                    s = s[:-2]
                i = int(s)
        except (TypeError, ValueError):
            return None
        return str(i) if i > 0 else None

    @classmethod
    def _gsi_current_player_steam_id(cls, payload: dict) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        player = payload.get("player") if isinstance(payload.get("player"), dict) else {}
        for key in ("steamid", "steam_id", "xuid", "id"):
            sid = cls._norm_steam_id(player.get(key))
            if sid:
                return sid
        return None

    @classmethod
    def _gsi_allplayer_spec_slots(cls, payload: dict, known_steams: set[str]) -> dict[str, int]:
        if not isinstance(payload, dict):
            return {}
        allplayers = payload.get("allplayers") if isinstance(payload.get("allplayers"), dict) else {}
        raw: dict[str, int] = {}
        for key, row in allplayers.items():
            if not isinstance(row, dict):
                continue
            sid = cls._norm_steam_id(key)
            if not sid:
                for sid_key in ("steamid", "steam_id", "xuid", "id"):
                    sid = cls._norm_steam_id(row.get(sid_key))
                    if sid:
                        break
            if not sid or sid not in known_steams:
                continue
            obs = row.get("observer_slot")
            if obs is None:
                obs = row.get("observerSlot")
            try:
                slot_raw = int(float(str(obs).strip()))
            except (TypeError, ValueError):
                continue
            if slot_raw >= 0:
                raw[sid] = slot_raw
        if not raw:
            return {}
        offset = 1 if 0 in set(raw.values()) else 0
        return {sid: slot + offset for sid, slot in raw.items()}

    @classmethod
    def _gsi_payload_spec_summary(cls, payload: dict) -> dict:
        if not isinstance(payload, dict):
            return {}
        player = payload.get("player") if isinstance(payload.get("player"), dict) else {}
        allplayers = payload.get("allplayers") if isinstance(payload.get("allplayers"), dict) else {}
        sample = []
        for key, row in list(allplayers.items())[:3]:
            if isinstance(row, dict):
                sample.append(
                    {
                        "key": str(key),
                        "name": row.get("name"),
                        "observer_slot": row.get("observer_slot"),
                        "keys": sorted(str(k) for k in row.keys()),
                    },
                )
        return {
            "payload_keys": sorted(str(k) for k in payload.keys()),
            "player_keys": sorted(str(k) for k in player.keys()),
            "player_name": player.get("name"),
            "player_steam": player.get("steamid") or player.get("steam_id") or player.get("xuid") or player.get("id"),
            "player_activity": player.get("activity"),
            "allplayers": len(allplayers),
            "allplayers_sample": sample,
        }

    def _demo_steam_by_name(self, demo_abs: Path) -> dict[str, str]:
        key = str(Path(demo_abs).resolve())
        cached = self._demo_steam_by_name_cache.get(key)
        if cached is not None:
            return cached
        out: dict[str, str] = {}
        try:
            for row in get_player_list(str(demo_abs)):
                name = str(row.get("name") or "").strip()
                sid = self._norm_steam_id(row.get("steam_id"))
                if name and sid:
                    out[name.lower()] = sid
        except Exception as e:
            logger.warning("Unable to build demo steam roster for %s: %s", demo_abs, e)
        self._demo_steam_by_name_cache[key] = out
        return out

    def _calibrated_spec_slot_for_name(self, demo_abs: Path, player_name: Optional[str]) -> Optional[int]:
        raw = str(player_name or "").strip()
        if not raw:
            return None
        cal = self._spec_calibration_by_demo.get(str(Path(demo_abs).resolve())) or {}
        if not cal:
            return None
        sid = self._demo_steam_by_name(demo_abs).get(raw.lower())
        slot = cal.get(sid) if sid else None
        logger.info(
            "Spec calibration lookup demo=%s name=%r steam=%s slot=%s calibrated=%s",
            demo_abs,
            raw,
            sid,
            slot,
            bool(cal),
        )
        return slot

    def _parsed_spec_slot_for_name(self, demo_abs: Path, tick: int, player_name: Optional[str]) -> Optional[int]:
        raw = str(player_name or "").strip()
        if not raw:
            return None
        slot = compute_spec_player_slot_one_based(demo_abs, tick, raw)
        if slot is None:
            return None
        offset = int(self._spec_parse_fallback_offset_by_demo.get(str(Path(demo_abs).resolve())) or 0)
        return int(slot) + max(0, offset)

    async def _await_gsi_steam_after(self, since: float, known_steams: set[str], timeout: float) -> Optional[str]:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while time.monotonic() < deadline:
            self._check_abort()
            snap = await asyncio.to_thread(
                wait_gsi_payload_after,
                since,
                min(0.4, max(0.05, deadline - time.monotonic())),
            )
            payload = snap.get("last_payload") if isinstance(snap, dict) else {}
            sid = self._gsi_current_player_steam_id(payload if isinstance(payload, dict) else {})
            if sid and sid in known_steams:
                return sid
            await asyncio.sleep(0.05)
        return None

    async def _await_gsi_allplayer_slots_after(
        self,
        since: float,
        known_steams: set[str],
        timeout: float,
    ) -> dict[str, int]:
        deadline = time.monotonic() + max(0.0, float(timeout))
        best: dict[str, int] = {}
        while time.monotonic() < deadline:
            self._check_abort()
            snap = await asyncio.to_thread(
                wait_gsi_payload_after,
                since,
                min(0.4, max(0.05, deadline - time.monotonic())),
            )
            payload = snap.get("last_payload") if isinstance(snap, dict) else {}
            slots = self._gsi_allplayer_spec_slots(payload if isinstance(payload, dict) else {}, known_steams)
            if len(slots) > len(best):
                best = slots
            if len(best) >= len(known_steams):
                return best
            await asyncio.sleep(0.05)
        return best

    async def _calibrate_spec_players_for_demo(self, demo_abs: Path) -> dict[str, int]:
        demo_key = str(Path(demo_abs).resolve())
        if demo_key in self._spec_calibration_by_demo:
            return self._spec_calibration_by_demo[demo_key]
        self._spec_calibration_by_demo[demo_key] = {}
        if os.environ.get("CS2_INSIGHT_SPEC_CALIBRATION", "1").strip().lower() in ("0", "false", "no"):
            return {}

        known_steams = set(self._demo_steam_by_name(demo_abs).values())
        if not known_steams:
            logger.info("Spec calibration skipped: no demo steam roster for %s", demo_abs)
            return {}
        name_by_steam = {sid: name for name, sid in self._demo_steam_by_name(demo_abs).items()}

        default_max_slot = 16
        max_slot = _env_int("CS2_INSIGHT_SPEC_CALIBRATION_MAX_SLOT", default_max_slot)
        per_slot_timeout = self._env_float("CS2_INSIGHT_SPEC_CALIBRATION_SLOT_TIMEOUT", "0.55")
        settle = self._env_float("CS2_INSIGHT_SPEC_CALIBRATION_SETTLE", "0.12")
        raw_mode = (os.environ.get("CS2_SPEC_MODE") or "5").strip()
        try:
            mode = int(raw_mode)
        except ValueError:
            mode = 5

        cal_tick = get_demo_spec_calibration_tick(demo_abs)
        goto_wait = self._env_float("CS2_INSIGHT_SPEC_CALIBRATION_GOTO_DELAY", "2.0")
        resume_wait = self._env_float("CS2_INSIGHT_SPEC_CALIBRATION_RESUME_DELAY", "4.0")
        calibration_timescale = self._env_float("CS2_INSIGHT_SPEC_CALIBRATION_TIMESCALE", "0.05")
        if calibration_timescale <= 0:
            calibration_timescale = 0.05
        logger.info(
            "Spec calibration seek tick=%d before slot scan demo=%s timescale=%s",
            cal_tick,
            demo_abs,
            calibration_timescale,
        )
        before_seek = float((gsi_status() or {}).get("last_payload_at") or 0.0)
        freeze_playback = os.environ.get("CS2_INSIGHT_SPEC_CALIBRATION_FREEZE_PLAYBACK", "1").strip().lower() not in (
            "0",
            "false",
            "no",
        )
        seek_cmds = ["demo_pause", f"demo_gototick {int(cal_tick)}"]
        if freeze_playback:
            seek_cmds += [f"demo_timescale {calibration_timescale:g}", "demo_resume"]
        ok_seek = await asyncio.to_thread(
            inject_console_sequence,
            seek_cmds,
            skip_console_toggle=False,
            close_console=True,
        )
        allplayer_slots: dict[str, int] = {}
        if ok_seek:
            await self._sleep_abortable(goto_wait)
            allplayer_slots = await self._await_gsi_allplayer_slots_after(before_seek, known_steams, resume_wait)
        else:
            logger.warning("Spec calibration seek injection failed; scanning at current demo position")

        logger.info(
            "Spec calibration roster demo=%s players=%s",
            demo_abs,
            sorted((name, sid) for name, sid in self._demo_steam_by_name(demo_abs).items()),
        )
        allplayer_unique_slots = set(allplayer_slots.values())
        if allplayer_slots:
            logger.info(
                "Spec calibration allplayers observer_slot demo=%s mapped=%d/%d mapping=%s",
                demo_abs,
                len(allplayer_slots),
                len(known_steams),
                sorted((sid, slot, name_by_steam.get(sid)) for sid, slot in allplayer_slots.items()),
            )
        if len(allplayer_slots) >= len(known_steams) and len(allplayer_unique_slots) == len(allplayer_slots):
            logger.warning(
                "Spec calibration allplayers observer_slot is complete but not treated as console spec_player demo=%s; using it only as roster-readiness signal",
                demo_abs,
            )
        if allplayer_slots:
            logger.warning(
                "Spec calibration allplayers incomplete/duplicate demo=%s mapped=%d/%d unique_slots=%d; falling back to active spec scan",
                demo_abs,
                len(allplayer_slots),
                len(known_steams),
                len(allplayer_unique_slots),
            )
        logger.info("Spec calibration start demo=%s known_steams=%d max_slot=%d", demo_abs, len(known_steams), max_slot)
        candidates: dict[str, list[int]] = {}
        samples: dict[int, str] = {}
        for slot in range(1, max(1, max_slot) + 1):
            self._check_abort()
            before = float((gsi_status() or {}).get("last_payload_at") or 0.0)
            ok = await asyncio.to_thread(
                inject_console_sequence,
                [f"spec_mode {mode}", f"spec_player {slot}"],
                skip_console_toggle=False,
                close_console=True,
            )
            if not ok:
                logger.debug("Spec calibration inject failed slot=%d", slot)
                continue
            if settle > 0:
                await self._sleep_abortable(settle)
            sid = await self._await_gsi_steam_after(before, known_steams, per_slot_timeout)
            if sid:
                samples[slot] = sid
                candidates.setdefault(sid, []).append(slot)
                logger.info(
                    "Spec calibration sample slot=%d steam=%s name=%s candidates=%s",
                    slot,
                    sid,
                    name_by_steam.get(sid),
                    candidates.get(sid),
                )
            else:
                payload = (gsi_status() or {}).get("last_payload") or {}
                logger.info(
                    "Spec calibration sample slot=%d steam=None payload=%s",
                    slot,
                    self._gsi_payload_spec_summary(payload if isinstance(payload, dict) else {}),
                )

        player_count = max(1, len(known_steams))
        window_len = min(player_count, max(1, max_slot))
        best_start = 1
        best_score: tuple[int, int, int, int] = (-1, -9999, -1, -9999)
        best_values: list[str] = []
        for start in range(1, max(1, max_slot - window_len + 2)):
            vals = [
                sid
                for slot in range(start, start + window_len)
                for sid in [samples.get(slot)]
                if sid and sid in known_steams
            ]
            unique = set(vals)
            duplicate_count = max(0, len(vals) - len(unique))
            score = (len(unique), -duplicate_count, len(vals), -start)
            if score > best_score:
                best_score = score
                best_start = start
                best_values = vals

        best_unique_count = len(set(best_values))
        out: dict[str, int] = {}
        if len(known_steams) > 1 and best_unique_count <= 1:
            logger.warning(
                "Spec calibration rejected degenerate samples demo=%s unique=%d/%d raw_candidates=%s",
                demo_abs,
                best_unique_count,
                len(known_steams),
                sorted((sid, slots, name_by_steam.get(sid)) for sid, slots in candidates.items()),
            )
            payload = (gsi_status() or {}).get("last_payload") or {}
            allplayers = payload.get("allplayers") if isinstance(payload, dict) and isinstance(payload.get("allplayers"), dict) else {}
            player = payload.get("player") if isinstance(payload, dict) and isinstance(payload.get("player"), dict) else {}
            if 0 < len(allplayers) <= len(known_steams) and not player:
                extra_offset = spec_player_extra_offset_for_gsi_failure(demo_abs, cal_tick)
                self._spec_parse_fallback_offset_by_demo[demo_key] = extra_offset
                logger.warning(
                    "Spec calibration marked parsed fallback offset demo=%s offset=%d reason=unusable allplayers %d/%d",
                    demo_abs,
                    extra_offset,
                    len(allplayers),
                    len(known_steams),
                )
        else:
            for slot in range(best_start, best_start + window_len):
                sid = samples.get(slot)
                if sid and sid in known_steams and sid not in out:
                    out[sid] = slot

        logger.info(
            "Spec calibration selected window demo=%s start=%d end=%d unique=%d/%d samples=%s raw_candidates=%s",
            demo_abs,
            best_start,
            best_start + window_len - 1,
            best_unique_count,
            len(known_steams),
            [(slot, samples.get(slot), name_by_steam.get(samples.get(slot) or "")) for slot in range(best_start, best_start + window_len)],
            sorted((sid, slots, name_by_steam.get(sid)) for sid, slots in candidates.items()),
        )
        if freeze_playback:
            await asyncio.to_thread(
                inject_console_sequence,
                ["demo_timescale 1", "demo_pause"],
                skip_console_toggle=False,
                close_console=True,
            )
        self._spec_calibration_by_demo[demo_key] = out
        logger.info(
            "Spec calibration final steam_to_slot demo=%s mapping=%s",
            demo_abs,
            sorted((sid, slot, name_by_steam.get(sid)) for sid, slot in out.items()),
        )
        logger.info(
            "Spec calibration final name_to_slot demo=%s mapping=%s",
            demo_abs,
            sorted((name_by_steam.get(sid), slot, sid) for sid, slot in out.items()),
        )
        logger.info("Spec calibration done demo=%s mapped=%d/%d", demo_abs, len(out), len(known_steams))
        return out

    # ── 用户配置保护 ────────────────────────────────────────────
    # 录制期间 CS2 会把被修改的 archive cvar（fps_max / hud_showtargetid /
    # viewmodel_fov / snd_voipvolume / cl_hud_telemetry_frametime_show 等）
    # 定期自动持久化到以下文件；``taskkill /F`` 只能阻止此后的写入，已经落盘的
    # 脏值会被下一次启动（如 5E 拉起的竞技 CS2）读回。
    #
    # 方案：发射 CS2 前对这些文件做**字节级快照**；强杀 CS2 后若文件内容发生
    # 变化，直接从快照恢复。这样无论用户原先的 fps_max 是 120/250/400/unlimited，
    # viewmodel_fov 是 54/60/68，都不会被我们覆盖。

    # CS2 仅对以下文件写入 archive cvar（命名在不同版本可能微调，用 glob 兜底）。
    _USER_CONFIG_FILENAMES: tuple[str, ...] = (
        "config.cfg",
        "cs2_user.cfg",
        "cs2_machine_convars.vcfg",
        "video.txt",
        "cs2_video.txt",
        "user_convars_0_slot0.vcfg",
        "cs2_user_convars_0_slot0.vcfg",
    )
    _USER_CONFIG_GLOB_PATTERNS: tuple[str, ...] = (
        "user_convars_0_slot*.vcfg",
        "cs2_user_convars_0_slot*.vcfg",
    )

    def _candidate_user_config_dirs(self) -> list[Path]:
        """返回所有可能存放用户 CS2 配置的目录。

        1) ``<cs2 安装根>/game/csgo/cfg``：老版本的 ``config.cfg``。
        2) ``<Steam root>/userdata/<id>/730/local/cfg``：CS2 现行的 archive cvar /
           video 设置主目录，每个 Steam 账号一份（多账号登陆时全部备份）。
        """
        dirs: list[Path] = []
        try:
            cs2 = Path(self.cs2_path)
        except Exception:
            return dirs
        # game/bin/win64/cs2.exe → parents[3] = game 根；game/csgo/cfg
        try:
            game_cfg = cs2.parents[2] / "csgo" / "cfg"
            if game_cfg.is_dir():
                dirs.append(game_cfg)
        except IndexError:
            pass
        try:
            install_cfg = cs2.parents[3] / "csgo" / "cfg"
            if install_cfg.is_dir() and install_cfg not in dirs:
                dirs.append(install_cfg)
        except IndexError:
            pass
        # game/bin/win64/cs2.exe → parents[6] = Steam 根
        try:
            steam_root = cs2.parents[6]
        except IndexError:
            steam_root = None
        if steam_root is not None:
            userdata = steam_root / "userdata"
            if userdata.is_dir():
                try:
                    for uid in userdata.iterdir():
                        candidate = uid / "730" / "local" / "cfg"
                        if candidate.is_dir():
                            dirs.append(candidate)
                except OSError as e:
                    logger.warning("iter userdata failed: %s", e)
        return dirs

    def _snapshot_user_configs(self) -> None:
        """对用户 CS2 配置文件做字节级快照，存到 ``self._user_config_snapshot``。
        启动 CS2 之前调用；跳过我们自己写的 ``_insight_<uuid>.cfg``。"""
        snap: dict[Path, Optional[bytes]] = {}

        def add_path(p: Path, record_missing: bool) -> None:
            if p in snap:
                return
            try:
                if p.is_file():
                    snap[p] = p.read_bytes()
                elif record_missing:
                    snap[p] = None
            except OSError as e:
                logger.warning("Snapshot user config %s failed: %s", p, e)
        for d in self._candidate_user_config_dirs():
            for name in self._USER_CONFIG_FILENAMES:
                p = d / name
                try:
                    if p.is_file():
                        snap[p] = p.read_bytes()
                    else:
                        # 记录"文件原本不存在"的状态，用于 restore 时删掉
                        # CS2 新建的污染文件。
                        snap[p] = None
                except OSError as e:
                    logger.warning("Snapshot user config %s failed: %s", p, e)
            for pattern in self._USER_CONFIG_GLOB_PATTERNS:
                try:
                    for p in d.glob(pattern):
                        add_path(p, record_missing=False)
                except OSError as e:
                    logger.warning("Snapshot user config glob %s failed: %s", d / pattern, e)
        self._user_config_snapshot = snap
        if snap:
            logger.info(
                "Snapshotted %d user config file(s) before launch (dirs=%s)",
                len([v for v in snap.values() if v is not None]),
                [str(d) for d in self._candidate_user_config_dirs()],
            )
            # 同步把磁盘上的玩家配置原样拷到 ``<repo>/.cs2_config_backup/``，每次录制
            # 启动会清空目录再重写，项目里只保留"最近一次录制前"的玩家原始 cfg。
            # 玩家事后可以在该目录翻出 config.cfg / video.txt 自行覆盖回去。
            try:
                _write_persistent_backup(snap)
            except Exception as e:  # noqa: BLE001
                logger.warning("Persistent disk backup failed (in-memory still active): %s", e)

    def _restore_user_configs(self) -> None:
        """强杀 CS2 后对比快照，回滚所有被 CS2 运行期写脏的用户配置文件。
        若某文件原本不存在但现在出现了（CS2 新建的污染文件），也会被删除。"""
        snap = self._user_config_snapshot
        if not snap:
            return
        restored = 0
        for p, original in snap.items():
            try:
                current_exists = p.is_file()
                if original is None:
                    if current_exists:
                        try:
                            p.unlink()
                            logger.info("Removed CS2-created user config: %s", p)
                            restored += 1
                        except OSError as e:
                            logger.warning("Remove user config %s failed: %s", p, e)
                    continue
                current = p.read_bytes() if current_exists else None
                if current != original:
                    p.write_bytes(original)
                    logger.info("Restored user config: %s (modified during recording)", p)
                    restored += 1
            except OSError as e:
                logger.warning("Restore user config %s failed: %s", p, e)
        if restored:
            logger.info("Restored %d user config file(s) post-kill", restored)
        # 一次性生效后清空，避免 batch 场景下重复回滚。
        self._user_config_snapshot = {}
        # 磁盘备份保持原样，下一次录制启动时再被覆盖。这里不删除：项目目录里
        # 永远留着「最近一次录制前」玩家原始 cfg 的快照供事后取用。

    def _kill_cs2(self) -> None:
        """强杀整棵 CS2 进程树并等待窗口真正消失。

        仅 ``Popen.terminate()`` 存在两个致命缺陷：
        1) Steam/启动器链路下 ``self._cs2_process`` 可能是短命 launcher，
           真正的 cs2.exe 根本没被杀 → 下一轮 ``find_cs2_hwnd`` 会命中
           上一次遗留的僵尸窗口；
        2) 即便杀到本体，窗口从"进程退出"到"hwnd 被销毁"仍有数百毫秒
           延迟。此期间 ``EnumWindows`` 仍可枚举到旧 hwnd，``PostMessage``
           向旧队列灌字符 → 表现为第二次录制"龟速输入 / 命令缺字符"。
        这里用 ``taskkill /F /T`` 递归结束进程树，再轮询确认窗口消失。

        等窗口彻底消失后调用 ``_restore_user_configs``，把录制期可能被 CS2
        auto-save 到用户 config 文件里的脏 archive cvar 全部回滚回录制前的样子。
        """
        pid = self._cs2_process.pid if self._cs2_process else 0
        if sys.platform == "win32":
            if pid:
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        timeout=10,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("taskkill /PID %s 失败: %s", pid, e)
                deadline = time.monotonic() + 8.0
                while time.monotonic() < deadline:
                    if not find_cs2_hwnd():
                        break
                    time.sleep(0.15)

                if find_cs2_hwnd() or is_cs2_running():
                    logger.info("Cleaning recorder-owned CS2 residual process before next launch")
                    try:
                        subprocess.run(
                            ["taskkill", "/F", "/IM", "cs2.exe"],
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=10,
                        )
                    except Exception as e:  # noqa: BLE001
                        logger.warning("taskkill /IM cs2.exe 兜底失败: %s", e)
                    deadline2 = time.monotonic() + 4.0
                    while time.monotonic() < deadline2 and is_cs2_running():
                        time.sleep(0.15)
            else:
                logger.info("Skip CS2 shutdown: no recorder-owned CS2 process")
        elif self._cs2_process:
            try:
                self._cs2_process.terminate()
                self._cs2_process.wait(timeout=10)
            except Exception:
                self._cs2_process.kill()

        if self._cs2_process:
            try:
                self._cs2_process.wait(timeout=1)
            except Exception:
                pass
            self._cs2_process = None

        # CS2 进程已结束，文件锁已释放。此时回滚用户配置，确保我们的 archive cvar
        # 修改不会泄漏到用户下一次启动（包括 5E / 竞技服的正式对局）。
        try:
            self._restore_user_configs()
        except Exception as e:  # noqa: BLE001
            logger.warning("Restore user configs after kill failed: %s", e)

    async def _await_cs2_window(self, timeout: float = 45.0) -> bool:
        """录制前等待 CS2 主窗口出现（便于后续 SendInput 注入 demo_gototick）。"""
        if sys.platform != "win32":
            logger.warning("非 Windows 无法自动注入 demo_gototick，tick 跳转已跳过")
            return True
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._check_abort()
            if find_cs2_hwnd():
                focus_timeout = self._env_float("CS2_INSIGHT_FOREGROUND_TIMEOUT_SEC", "4.0")
                if not await asyncio.to_thread(ensure_cs2_foreground, focus_timeout):
                    logger.warning("CS2 窗口已出现，但未能切到前台；继续等待")
                    await asyncio.sleep(0.4)
                    continue
                return True
            await asyncio.sleep(0.4)
        logger.error("等待 CS2 窗口超时，无法注入 demo_gototick")
        return False

    def _env_float(self, key: str, default: str) -> float:
        try:
            return float((os.environ.get(key) or default).strip())
        except ValueError:
            return float(default)

    @staticmethod
    def _safe_filename_part(value: object, fallback: str, *, max_len: int = 48) -> str:
        raw = unicodedata.normalize("NFKC", str(value or "")).strip()
        out: list[str] = []
        for ch in raw:
            cat = unicodedata.category(ch)
            if ch in '<>:"/\\|?*' or ord(ch) < 32 or cat.startswith("C") or cat.startswith("S"):
                out.append(" ")
            elif ch.isalnum() or ch in ("-", "_", "."):
                out.append(ch)
            else:
                out.append(" ")
        cleaned = re.sub(r"\s+", "_", "".join(out)).strip(" ._-")
        if not cleaned:
            cleaned = fallback
        return cleaned[:max_len].strip(" ._-") or fallback

    @staticmethod
    def _compact_weapon_label(value: object) -> str:
        raw = str(value or "").strip()
        if not raw:
            return "weapon"
        labels: list[str] = []
        for part in re.split(r"\s*/\s*", raw):
            part = part.strip()
            if not part:
                continue
            paren = re.findall(r"\(([^()]+)\)", part)
            label = paren[-1].strip() if paren else part
            labels.append(label)
        return "-".join(labels) if labels else raw

    @staticmethod
    def _map_name_for_recording(clip: dict, demo_abs: Path) -> str:
        for key in ("map_name", "_map_name"):
            val = str(clip.get(key) or "").strip()
            if val:
                return val
        stem = demo_abs.stem
        m = re.search(r"(de_[a-z0-9_]+)", stem, flags=re.IGNORECASE)
        if m:
            return m.group(1)
        for short in (
            "dust2",
            "mirage",
            "inferno",
            "nuke",
            "ancient",
            "anubis",
            "train",
            "overpass",
            "vertigo",
            "cache",
            "tuscan",
        ):
            if re.search(rf"(^|[-_]){re.escape(short)}($|[-_])", stem, flags=re.IGNORECASE):
                return f"de_{short}"
        return "map"

    @staticmethod
    def _obs_response_output_path(resp: object) -> Optional[Path]:
        datain = getattr(resp, "datain", None)
        if isinstance(datain, dict):
            for key in ("outputPath", "output_path", "output-path"):
                raw = datain.get(key)
                if raw:
                    return Path(str(raw))
        for getter_name in ("getOutputPath", "getOutputpath"):
            getter = getattr(resp, getter_name, None)
            if callable(getter):
                try:
                    raw = getter()
                except Exception:
                    continue
                if raw:
                    return Path(str(raw))
        return None

    def _obs_record_directory_path(self) -> Optional[Path]:
        if not self._ws:
            return None
        try:
            req = getattr(obs_requests, "GetRecordDirectory", None)
            if req is None:
                return None
            resp = self._ws.call(req())
            datain = getattr(resp, "datain", None)
            raw = None
            if isinstance(datain, dict):
                raw = datain.get("recordDirectory") or datain.get("record_directory") or datain.get("record-directory")
            if not raw:
                getter = getattr(resp, "getRecordDirectory", None)
                if callable(getter):
                    raw = getter()
            return Path(str(raw)) if raw else None
        except Exception as e:
            logger.debug("GetRecordDirectory failed: %s", e)
            return None

    def _locate_recent_recording_output(self, started_at_wall: Optional[float]) -> Optional[Path]:
        if started_at_wall is None:
            return None
        record_dir = self._obs_record_directory_path()
        if not record_dir or not record_dir.is_dir():
            return None
        candidates: list[tuple[float, Path]] = []
        cutoff = float(started_at_wall) - 5.0
        try:
            for p in record_dir.iterdir():
                if not p.is_file() or p.suffix.lower() not in _RECORDING_VIDEO_EXTENSIONS:
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                if st.st_mtime >= cutoff:
                    candidates.append((st.st_mtime, p))
        except OSError as e:
            logger.debug("Could not scan OBS record directory %s: %s", record_dir, e)
            return None
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    def _build_clip_recording_stem(self, clip: dict, demo_abs: Path, spectator_name: Optional[str]) -> str:
        player = (
            spectator_name
            or clip.get("_spec_name")
            or clip.get("target_player")
            or clip.get("killer_name")
            or "player"
        )
        map_name = self._map_name_for_recording(clip, demo_abs)
        category = str(clip.get("category") or "").strip()
        round_no = clip.get("round")
        round_part = ""
        if category != "compilation":
            round_part = f"R{round_no}" if round_no is not None and str(round_no).strip() else "R?"
        try:
            kills = int(clip.get("kill_count") or 0)
        except (TypeError, ValueError):
            kills = 0
        compilation_kind = str(clip.get("compilation_kind") or "").strip()
        source_count = len(clip.get("source_ticks") or []) if isinstance(clip.get("source_ticks"), list) else 0
        if category == "compilation" and compilation_kind in {"nemesis_deaths", "all_deaths"}:
            kill_part = f"{max(1, source_count)}D"
        elif category == "meme_death":
            kill_part = "1D"
        else:
            kill_part = f"{kills}K" if kills > 0 else (category or "clip")
        clip_id = str(clip.get("clip_id") or "clip").strip()
        parts = [
            self._safe_filename_part(player, "player"),
            self._safe_filename_part(map_name, "map"),
            self._safe_filename_part(round_part, "R"),
            self._safe_filename_part(kill_part, "clip"),
            self._safe_filename_part(clip_id, "clip", max_len=32),
        ]
        stem = "_".join(p for p in parts if p)
        return stem[:180].strip(" ._-") or "cs2_clip"

    @staticmethod
    def _unique_recording_target(source: Path, stem: str) -> Path:
        suffix = source.suffix
        candidate = source.with_name(f"{stem}{suffix}")
        try:
            if candidate.resolve() == source.resolve():
                return source
        except OSError:
            if str(candidate).lower() == str(source).lower():
                return source
        if not candidate.exists():
            return candidate
        for idx in range(2, 1000):
            candidate = source.with_name(f"{stem}_{idx}{suffix}")
            if not candidate.exists():
                return candidate
        return source.with_name(f"{stem}_{uuid.uuid4().hex[:8]}{suffix}")

    def _rename_recording_output(
        self,
        output_path: Optional[Path],
        clip: dict,
        demo_abs: Path,
        spectator_name: Optional[str],
    ) -> dict:
        if output_path is None:
            return {}
        source = output_path.expanduser()
        original = str(source)
        try:
            if not source.is_file():
                return {"original_output_path": original, "rename_error": "OBS output file not found"}
            stem = self._build_clip_recording_stem(clip, demo_abs, spectator_name)
            target = self._unique_recording_target(source, stem)
            if target != source:
                source.rename(target)
                logger.info("Renamed OBS recording %s -> %s", source, target)
            return {
                "original_output_path": original,
                "output_path": str(target),
                "output_filename": target.name,
            }
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not rename OBS recording %s: %s", original, e)
            return {"original_output_path": original, "rename_error": str(e)}

    async def _finalize_obs_recording_rename(
        self,
        stop_path: Optional[Path],
        clip: dict,
        demo_abs: Path,
        spectator_name: Optional[str],
        record_started_at_wall: Optional[float],
    ) -> dict:
        """StopRecord 后对 OBS 输出文件改名：无固定前置等待；最多 5 次尝试，间隔 0.5s，成功即返回。

        WebSocket 已给出 ``outputPath`` 时各轮只尝试该路径（避免录制目录内误选其它成片）；
        仅当 StopRecord 未返回路径时才按录制目录扫描兜底。
        """
        interval = 0.5
        max_attempts = 5
        clip_ref = str(clip.get("clip_id") or "")
        for attempt in range(1, max_attempts + 1):
            self._check_abort()
            path: Optional[Path]
            if stop_path is not None:
                try:
                    path = stop_path.expanduser()
                except OSError:
                    path = None
            else:
                path = self._locate_recent_recording_output(record_started_at_wall)
            result = self._rename_recording_output(path, clip, demo_abs, spectator_name)
            if result.get("output_path") and not result.get("rename_error"):
                return result
            if attempt < max_attempts:
                await self._sleep_abortable(interval)
        logger.warning(
            "OBS output rename skipped after %d attempts (clip_id=%s)",
            max_attempts,
            clip_ref,
        )
        return {}

    @staticmethod
    def _recording_warmup_console_lines(w: RecordingWarmupExtras) -> list[str]:
        """录制会话首次 seek 前注入的观战 cvar（与空格预热后的控制台批次合并）。

        在所有 cvar 之前注入 ``unbindall`` + 一组最小默认绑定，把玩家自定义
        按键统一恢复为安全默认；用户原 ``config.cfg`` / ``cs2_user_keys.cfg`` 等
        已被 ``_snapshot_user_configs`` 落盘，录制结束 / 进程崩溃后都能完整还原。
        ``unbindall`` 必须在第一行：避免玩家把 toggleconsole 改绑到非常规键时，
        我们 SendInput 投到默认 F10 / ``~`` 失效。
        """
        if w.console_cmds:
            cmds = [str(x).strip() for x in w.console_cmds if str(x).strip()]
            fix0 = _WARMUP_FIXED_CONSOLE_LINES[0]
            if cmds and cmds[0].strip() == fix0.strip():
                return [*_RECORDING_KEYBIND_RESET_LINES, *cmds]
            return [*_RECORDING_KEYBIND_RESET_LINES, fix0, *cmds]
        lines: list[str] = []
        lines.extend(_RECORDING_KEYBIND_RESET_LINES)
        lines.extend(_WARMUP_FIXED_CONSOLE_LINES)
        if w.cl_draw_only_deathnotices:
            lines.append("cl_draw_only_deathnotices true")
        else:
            lines.append("cl_draw_only_deathnotices false")
        if w.hud_showtargetid_hide:
            lines.append("hud_showtargetid 0")
        else:
            lines.append("hud_showtargetid 1")
        if w.tv_nochat:
            lines.append("tv_nochat 1")
        else:
            lines.append("tv_nochat 0")
        if w.hide_demo_playback_ui:
            lines.append("sv_cheats 1")
            lines.append("demoui false")
        x = 1 if int(w.spec_show_xray) != 0 else 0
        lines.append(f"spec_show_xray {x}")
        if w.fov_cs_debug is not None:
            lines.append(f"fov_cs_debug {float(w.fov_cs_debug)}")
        if w.viewmodel_fov_68:
            lines.append("viewmodel_fov 68")
        if w.snd_voipvolume_mute:
            lines.append("snd_voipvolume 0")
        if w.hide_grenade_trajectory_pip:
            lines.append("sv_grenade_trajectory 0")
            lines.append("sv_grenade_trajectory_prac_pipreview 0")
            lines.append("cl_grenadepreview 0")
            lines.append("sv_grenade_trajectory_time_spectator 0")
        return lines

    async def _prepare_clip_playback(
        self,
        demo_abs: Path,
        seek_tick: int,
        spectator_name: Optional[str],
        spectator_user_id: Optional[int],
        *,
        warmup: Optional[RecordingWarmupExtras] = None,
        inject_session_warmup_cvars: bool = False,
        jump_cut_seek: bool = False,
        jump_cut_skip_leading_demo_pause: bool = False,
        goto_delay_extra: float = 0.0,
    ) -> bool:
        """
        多段注入：避免 ``demo_gototick`` 异步读盘时同批 ``spec_player`` 被引擎丢弃。
        0) 观战「预热」（默认可开，且在 **demo_gototick 之前**）：部分第三方 demo（如 5E）刚进回放
            时 Demo UI 未就绪，控制台 ``spec_*`` 无效；与右下角「下一个玩家视角」相同，默认用
            **SendInput 空格**（``send_cs2_space_taps``，次数 ``CS2_INSIGHT_SPEC_PRIME_SPACE_COUNT``）。
            首次片段可合并注入会话级 cvar：``cl_draw_only_deathnotices``、``spec_show_xray``、
            ``fov_cs_debug``（见 ``RecordingWarmupExtras``）；以及环境变量 ``CS2_INSIGHT_SPEC_PRIME_CMDS``
            （``|`` 分隔）。最后等待 ``CS2_INSIGHT_SPEC_PRIME_DELAY``。
        1) gototick → 等待 GOTO_DELAY
        2) demo_resume → 等待 RESUME_DELAY
        3) 组装 spec_player（调用方给定/已校验的 user_id > 现算槽位 > 带双引号的昵称）
        4) spec_mode + spec_player → 等待 SPEC_SETTLE_DELAY
        5) hideconsole → POST_HIDE / PRE_RECORD

        ``jump_cut_seek=True``（智能跳跃段间）：默认先 ``demo_pause`` 再 gototick；若
        ``jump_cut_skip_leading_demo_pause=True`` 则跳过首道 ``demo_pause``（调用方已在段末 pause，
        避免 ``demo_pause`` 开关式二次调用误解除暂停）。**不在本函数内** ``demo_resume``，由调用方在
        OBS ``ResumeRecord`` 之后再 ``demo_resume``。
        """
        if sys.platform != "win32":
            logger.warning("非 Windows 跳过控制台注入 tick=%s", seek_tick)
            await asyncio.sleep(2.0)
            return False

        seek_tick = max(0, int(seek_tick))
        self._check_abort()
        skip_toggle = os.environ.get("CS2_INSIGHT_SKIP_CONSOLE_TOGGLE", "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        close_cmd = (os.environ.get("CS2_INSIGHT_CONSOLE_CLOSE_CMD") or "hideconsole").strip() or "hideconsole"
        if jump_cut_seek:
            goto_delay = self._env_float("CS2_INSIGHT_GOTO_DELAY_JUMP_CUT", "1.05")
            resume_delay = 0.05
        else:
            goto_delay = self._env_float("CS2_INSIGHT_GOTO_DELAY", "3.5")
            resume_delay = self._env_float("CS2_INSIGHT_RESUME_DELAY", "0.5")
        goto_delay += max(0.0, float(goto_delay_extra))
        spec_settle = self._env_float("CS2_INSIGHT_SPEC_SETTLE_DELAY", "0.4")
        # CS2：第一人称观战为 spec_mode 5（非 4）；可用环境变量 CS2_SPEC_MODE 覆盖
        raw_mode = (os.environ.get("CS2_SPEC_MODE") or "5").strip()
        try:
            mode = int(raw_mode)
        except ValueError:
            mode = 5

        pname = (spectator_name or "").strip()
        calibrated_slot: Optional[int] = None
        parsed_slot: Optional[int] = None
        if demo_abs.is_file() and pname:
            calibrated_slot = self._calibrated_spec_slot_for_name(demo_abs, pname)
            if calibrated_slot is None:
                parsed_slot = self._parsed_spec_slot_for_name(demo_abs, seek_tick, pname)

        spec_cmd: Optional[str] = None
        spec_source: Optional[str] = None
        if calibrated_slot is not None:
            spec_cmd = f"spec_player {int(calibrated_slot)}"
            spec_source = "gsi-calibrated"
        elif parsed_slot is not None and int(parsed_slot) > 0:
            spec_cmd = f"spec_player {int(parsed_slot)}"
            spec_source = "parsed-fallback"
            logger.warning(
                "Spec calibration missed name=%r demo=%s; falling back to parsed slot=%s",
                pname or None,
                demo_abs,
                parsed_slot,
            )
        elif spectator_user_id is not None and int(spectator_user_id) > 0:
            spec_cmd = f"spec_player {int(spectator_user_id)}"
            spec_source = "uid-fallback"
            logger.warning(
                "Spec calibration missed name=%r demo=%s; falling back to uid=%s",
                pname or None,
                demo_abs,
                spectator_user_id,
            )
        elif pname:
            logger.warning("Spec calibration missed name=%r demo=%s; no numeric fallback available", pname, demo_abs)

        logger.info(
            "Clip console staged tick=%s name=%r calibrated_slot=%s parsed_slot=%s uid=%r spec_cmd=%r source=%s mode=%s",
            seek_tick,
            pname or None,
            calibrated_slot,
            parsed_slot,
            spectator_user_id,
            spec_cmd,
            spec_source,
            mode,
        )

        def _inj(lines: list[str], *, skip: bool, close: bool) -> bool:
            return inject_console_sequence(lines, skip_console_toggle=skip, close_console=close)

        if jump_cut_seek and not jump_cut_skip_leading_demo_pause:
            logger.info("jump_cut_seek: demo_pause then gototick (no mid-seek demo_resume)")
            ok_dp = await asyncio.to_thread(_inj, ["demo_pause"], skip=True, close=False)
            if not ok_dp:
                logger.warning("demo_pause inject failed (jump_cut_seek)")
            await asyncio.sleep(0.08)

        def _spec_prime_console_lines() -> list[str]:
            """仅当显式设置 ``CS2_INSIGHT_SPEC_PRIME_CMDS`` 时返回控制台行（``|`` 分隔）。"""
            raw_cmds = os.environ.get("CS2_INSIGHT_SPEC_PRIME_CMDS")
            if raw_cmds is None or not str(raw_cmds).strip():
                return []
            parts = [p.strip() for p in str(raw_cmds).replace("\n", "|").split("|")]
            return [p for p in parts if p]

        prime_raw = (os.environ.get("CS2_INSIGHT_SPEC_PRIME", "1") or "1").strip().lower()
        prime_on = prime_raw not in ("0", "false", "no", "off")
        prime_after = self._env_float("CS2_INSIGHT_SPEC_PRIME_DELAY", "0.25")
        try:
            space_count = (
                max(0, int(float((os.environ.get("CS2_INSIGHT_SPEC_PRIME_SPACE_COUNT") or "1").strip())))
                if prime_on
                else 0
            )
        except ValueError:
            space_count = 1 if prime_on else 0

        prime_lines = _spec_prime_console_lines()
        session_lines: list[str] = []
        if inject_session_warmup_cvars and warmup is not None:
            session_lines = self._recording_warmup_console_lines(warmup)
        post_space_console = [*session_lines, *prime_lines]

        ok0 = True
        console_opened_by_prime = False
        any_prime = False
        if not jump_cut_seek:
            if prime_on and space_count > 0:
                any_prime = True
                logger.info(
                    "Spec prime before seek: SendInput Space x%d (demo UI 下一玩家视角), then delay %.2fs",
                    space_count,
                    prime_after,
                )
                ok0 = await asyncio.to_thread(send_cs2_space_taps, space_count)
                if not ok0:
                    logger.warning("Spec prime Space SendInput failed (pre-gototick)")
                    return False
            if post_space_console:
                any_prime = True
                logger.info(
                    "Spec prime console after Space: session=%d env_extra=%d total=%d, post delay %.2fs",
                    len(session_lines),
                    len(prime_lines),
                    len(post_space_console),
                    prime_after,
                )
                okc = await asyncio.to_thread(
                    _inj,
                    post_space_console,
                    skip=skip_toggle if not console_opened_by_prime else True,
                    close=False,
                )
                if okc:
                    logger.info("Injected spec prime console OK (pre-gototick, %d lines)", len(post_space_console))
                    console_opened_by_prime = True
                else:
                    logger.warning(
                        "Console inject failed spec prime (pre-gototick, %d lines)",
                        len(post_space_console),
                    )
                    return False
            if any_prime:
                await self._sleep_abortable(prime_after)

        # ==== [核心修复] 将 demo_pause 捆绑在 gototick 一起注入 ====
        # 强制在 goto_delay (默认3.5秒) 等待加载期间，游戏绝对处于暂停状态
        # 并且强制 demo_timescale 1 防止变速播放，彻底消灭时间轴漂移
        gototick_cmds: list[str] = []
        if not jump_cut_skip_leading_demo_pause:
            gototick_cmds.extend(["demo_pause", "demo_timescale 1"])

        # 移除原有的 0 0 参数，因为 CS2 引擎不需要
        gototick_cmds.append(f"demo_gototick {seek_tick}")

        ok1 = await asyncio.to_thread(
            _inj,
            gototick_cmds,
            skip=True if console_opened_by_prime else skip_toggle,
            close=False,
        )
        if ok1:
            logger.info("Injected stage 1: demo_gototick %s", seek_tick)
        else:
            logger.warning("Console inject failed stage 1: demo_gototick %s", seek_tick)
            return False

        await self._sleep_abortable(goto_delay)

        resume_on = os.environ.get("CS2_INSIGHT_DEMO_RESUME_AFTER_SEEK", "1").strip().lower() not in (
            "0",
            "false",
            "no",
        )
        ok2 = True
        if resume_on and not jump_cut_seek:
            ok2 = await asyncio.to_thread(_inj, ["demo_resume"], skip=True, close=False)
            if ok2:
                logger.info("Injected stage 2: demo_resume")
            else:
                logger.warning("Console inject failed stage 2: demo_resume")

        await self._sleep_abortable(resume_delay)

        ok4 = True
        if spec_cmd is not None:
            ok4 = await asyncio.to_thread(
                _inj,
                [f"spec_mode {mode}", spec_cmd],
                skip=True,
                close=False,
            )
            if ok4:
                logger.info("Injected stage 4: spec_mode %s + %s", mode, spec_cmd)
            else:
                logger.warning("Console inject failed stage 4: spec_mode + %s", spec_cmd)
            await self._sleep_abortable(spec_settle)

        ok5 = await asyncio.to_thread(_inj, [close_cmd], skip=True, close=False)
        if ok5:
            logger.info("Injected stage 5: %s", close_cmd)
        else:
            logger.warning("Console inject failed stage 5: %s", close_cmd)

        await self._sleep_abortable(self._env_float("CS2_INSIGHT_POST_HIDE_DELAY", "0.55"))
        await self._sleep_abortable(self._env_float("CS2_INSIGHT_PRE_RECORD_DELAY", "0.35"))
        if jump_cut_seek:
            return bool(ok0 and ok1 and ok4 and ok5)
        return bool(ok0 and ok1 and ok2 and ok4 and ok5)

    async def _execute_single_clip_recording(
        self,
        clip: dict,
        demo_abs: Path,
        spectator_name: Optional[str],
        spectator_user_id: Optional[int],
        *,
        clip_idx: int,
        warmup: Optional[RecordingWarmupExtras] = None,
        batch_new_demo_first_clip: bool = False,
    ) -> dict:
        """Seek + spec + OBS StartRecord/StopRecord for one clip. Expects CS2 running and OBS connected."""
        # 多玩家同 demo 批量录制时，clip dict 内嵌了 _spec_name / _spec_uid 字段，
        # 优先级高于调用方传入的 spectator_name / spectator_user_id（后者此时为 None）。
        if clip.get("_spec_name"):
            spectator_name = clip["_spec_name"]
        if clip.get("_spec_uid") is not None:
            spectator_user_id = clip["_spec_uid"]

        clip_id = str(clip["clip_id"])
        self._check_abort()
        start_tick = max(0, int(clip["start_tick"]))
        end_tick = max(start_tick, int(clip["end_tick"]))
        segments = build_smart_jump_segments(clip)
        has_kill_timeline = bool(_clip_kill_ticks_sorted(clip))
        death_anchor_tick = _clip_death_tick(clip)
        has_death_timeline = (
            death_anchor_tick is not None
            and str(clip.get("category") or "").strip() in ("fail", "meme_death")
        )
        _pacing_override = clip.get("pacing_override") or {}
        has_single_segment_override = isinstance(_pacing_override, dict) and any(
            k in _pacing_override for k in ("pre_first_sec", "post_last_sec")
        )
        use_smart_jump = len(segments) > 1
        post_start_seg0 = 0.0
        first_seg_extra = 0.0

        # === [新增] 计算引擎空转消耗 (Engine Burn Compensation) ===
        # _prepare_clip_playback 会解除暂停让镜头稳定，这会消耗部分 Demo 播放时间
        resume_on = os.environ.get("CS2_INSIGHT_DEMO_RESUME_AFTER_SEEK", "1").strip().lower() not in (
            "0",
            "false",
            "no",
        )
        if resume_on:
            burn_sec = (
                self._env_float("CS2_INSIGHT_RESUME_DELAY", "0.5")
                + self._env_float("CS2_INSIGHT_SPEC_SETTLE_DELAY", "0.4")
                + self._env_float("CS2_INSIGHT_POST_HIDE_DELAY", "0.55")
                + self._env_float("CS2_INSIGHT_PRE_RECORD_DELAY", "0.35")
                # inject_console_sequence 每次调用自身有阻塞耗时（约 0.4–0.6s/次）；
                # 这里统计 demo_resume + spec + hideconsole + pause_bracket demo_pause 共约 4 次，
                # 总额外 burn ≈ 2s（可通过环境变量精确校准）。
                + self._env_float("CS2_INSIGHT_INJECT_OVERHEAD_SEC", "2.0")
            )
        else:
            burn_sec = 0.0
        engine_burn_ticks = int(burn_sec * TICK_RATE)
        # ========================================================

        def _estimated_record_start_tick(seek: int) -> int:
            return max(0, int(seek)) + max(0, int(engine_burn_ticks))

        if use_smart_jump:
            # 补偿：往前多跳 engine_burn_ticks，确保 OBS 开始录制时刚好到达逻辑起点
            seek_tick = max(0, segments[0][0] - engine_burn_ticks)
            planned_wall_seconds = post_start_seg0 + first_seg_extra + sum(
                max(0.0, (ee - ss) / float(TICK_RATE)) for ss, ee in segments
            )
        elif has_kill_timeline or has_single_segment_override or has_death_timeline:
            ss0, ee0 = segments[0]
            seek_tick = max(0, ss0 - engine_burn_ticks)
            kill_seg_pad = 0.2
            record_start_tick = _estimated_record_start_tick(seek_tick)
            legacy_duration = max(0.0, (ee0 - record_start_tick) / float(TICK_RATE)) + kill_seg_pad
            planned_wall_seconds = legacy_duration
        else:
            seek_tick = max(0, start_tick - PRE_ROLL_TICKS - engine_burn_ticks)
            tail = 0.2
            record_start_tick = _estimated_record_start_tick(seek_tick)
            legacy_duration = max(0.0, (end_tick - record_start_tick) / float(TICK_RATE)) + tail
            planned_wall_seconds = legacy_duration

        self._set_state(
            DirectorState.SEEKING,
            f"clip={clip_id} tick={seek_tick} smart_jump={use_smart_jump} segments={len(segments)}",
        )
        goto_extra = (
            max(0.0, self._env_float("CS2_INSIGHT_BATCH_FIRST_GOTO_EXTRA_SEC", "2.5"))
            if batch_new_demo_first_clip
            else 0.0
        )
        await self._prepare_clip_playback(
            demo_abs,
            seek_tick,
            spectator_name,
            spectator_user_id,
            warmup=warmup,
            inject_session_warmup_cvars=(clip_idx == 0),
            goto_delay_extra=goto_extra,
        )

        self._set_state(DirectorState.RECORDING, clip_id)
        cursor_bak: Optional[Tuple[int, int, int, int]] = None
        # 段间在 **demo 已 pause** 下等待 spec 稳定；默认不宜过长（过长旧逻辑会在 OBS 仍暂停时白等）
        settle_between = self._env_float("CS2_INSIGHT_SMART_JUMP_SETTLE", "0.6")
        # jump cut 中 demo_resume 在 _obs_resume() 之前执行，demo 会提前播放：
        #   = post_obs_resume_demo_delay + settle_between ≈ 0.25 + 0.6 = 0.85s ≈ 54 ticks
        # 通过将 seek_tick 提前 jc_burn_ticks，确保 OBS 恢复时 demo 恰好在 seg_start。
        # CS2_INSIGHT_JC_BURN_SEC（默认 0.9）可微调，覆盖 demo_resume 注入本身的阻塞耗时差异。
        _jc_burn_sec = self._env_float("CS2_INSIGHT_JC_BURN_SEC", "0.9")
        _jc_burn_ticks = int(_jc_burn_sec * TICK_RATE)
        record_started_at_wall: Optional[float] = None
        stop_record_output_path: Optional[Path] = None
        output_result: dict = {}
        fatal_recording_error: Optional[str] = None

        def _obs_record_paused() -> Optional[bool]:
            if not self._ws:
                return None
            try:
                status_req = getattr(obs_requests, "GetRecordStatus", None)
                if status_req is None:
                    return None
                resp = self._ws.call(status_req())
                paused = getattr(resp, "datain", {}).get("outputPaused", None)
                if paused is None:
                    paused = getattr(resp, "outputPaused", None)
                return bool(paused) if paused is not None else None
            except Exception as e:
                logger.debug("GetRecordStatus check skipped: %s", e)
                return None

        def _obs_pause() -> bool:
            """Send PauseRecord and verify OBS actually paused.

            OBS can silently ignore PauseRecord (no exception, no error code) when
            the current output container/encoder does not support pause (e.g. MP4,
            some hardware encoders).  We follow up with GetRecordStatus to confirm
            outputPaused == True and treat a mismatch as a hard failure so the
            caller knows smart-jump-cut is unavailable and falls back gracefully.
            """
            if not self._ws:
                return False
            if _obs_record_paused() is True:
                return True
            try:
                req = getattr(obs_requests, "PauseRecord", None)
                if req is None:
                    logger.warning("obs_requests.PauseRecord not available; fallback to continuous recording")
                    return False
                self._ws.call(req())
            except Exception as e:
                if _obs_record_paused() is True:
                    return True
                logger.warning("OBS PauseRecord failed (%s); fallback to continuous recording", e)
                return False
            # Verify the pause actually took effect.
            # OBS silently ignores PauseRecord for output types that don't support it
            # (e.g. MP4 container, certain hardware encoders).  Without this check the
            # entire demo is recorded as one long uncut video with no visible error.
            try:
                status_req = getattr(obs_requests, "GetRecordStatus", None)
                if status_req is not None:
                    deadline = time.time() + max(
                        0.05,
                        self._env_float("CS2_INSIGHT_OBS_PAUSE_VERIFY_TIMEOUT_SEC", "1.2"),
                    )
                    paused = None
                    while time.time() < deadline:
                        resp = self._ws.call(status_req())
                        paused = getattr(resp, "datain", {}).get("outputPaused", None)
                        if paused is None:
                            paused = getattr(resp, "outputPaused", None)
                        if paused is True:
                            return True
                        time.sleep(0.05)
                    if paused is False:
                        logger.warning(
                            "OBS PauseRecord command succeeded but outputPaused stayed False after verify timeout. "
                            "If OBS itself pauses successfully, increase CS2_INSIGHT_OBS_PAUSE_VERIFY_TIMEOUT_SEC. "
                            "Falling back to continuous recording for this clip."
                        )
                        return False
            except Exception as e:
                # GetRecordStatus unavailable on this OBS/plugin version — proceed optimistically
                logger.debug("GetRecordStatus check skipped: %s", e)
            return True

        def _obs_resume() -> None:
            if not self._ws:
                return
            try:
                req = getattr(obs_requests, "ResumeRecord", None)
                if req is None:
                    return
                self._ws.call(req())
            except Exception as e:
                logger.warning("OBS ResumeRecord failed: %s", e)

        try:
            if not self._ws:
                return {"clip_id": clip_id, "status": "obs_error"}
            # prepare 结束后到真正 StartRecord 之间要做 OBS/光标，期间若不 pause，Demo 会空转吃掉首杀前预滚
            pause_bracket = (
                sys.platform == "win32"
                and os.environ.get("CS2_INSIGHT_PAUSE_DEMO_BEFORE_START_RECORD", "1").strip().lower()
                not in ("0", "false", "no")
            )
            if pause_bracket:
                ok_dp0 = await asyncio.to_thread(
                    inject_console_sequence,
                    ["demo_pause"],
                    skip_console_toggle=True,
                    close_console=False,
                )
                if not ok_dp0:
                    logger.warning("demo_pause before StartRecord failed; pre-roll may be shortened")
                else:
                    await asyncio.sleep(0.06)

            self._obs_apply_hide_cursor_inputs()
            if os.environ.get("CS2_INSIGHT_HIDE_WIN_CURSOR", "1").strip().lower() not in (
                "0",
                "false",
                "no",
            ):
                cursor_bak = self._win_cursor_corner_backup()
                self._win_cursor_move_corner(cursor_bak)
            record_started_at_wall = time.time()
            self._ws.call(obs_requests.StartRecord())

            if pause_bracket:
                ok_dr0 = await asyncio.to_thread(
                    inject_console_sequence,
                    ["demo_resume"],
                    skip_console_toggle=True,
                    close_console=False,
                )
                if not ok_dr0:
                    logger.warning("demo_resume immediately after StartRecord failed")
                await asyncio.sleep(0.08)

            if not use_smart_jump:
                await self._sleep_abortable(legacy_duration)
            else:
                await self._sleep_abortable(post_start_seg0)
                jump_cut_active = True
                for si, (seg_start, seg_end) in enumerate(segments):
                    seg_dur = max(0.0, (seg_end - seg_start) / float(TICK_RATE))
                    if si == 0:
                        # seg_dur 已对齐 tick 区间；first_seg_extra 默认 0，仅 env 可选微垫
                        await self._sleep_abortable(seg_dur + first_seg_extra)
                        continue
                    if not jump_cut_active:
                        break
                    # 【顺序关键 —— 先 _obs_pause，再 demo_pause】
                    # 段间必须先让 OBS 暂停录制，再去开控制台注入 demo_pause。原因：
                    # ok_seg_pause 用的是 skip=False + close=True，内部会先按 `~` 打开
                    # 控制台 UI、注入命令、再用 hideconsole 关闭，整个过程控制台 UI 可见
                    # 约 0.3~0.4s。若此时 OBS 仍在录制（上一段 seg_dur 刚结束、仍 active），
                    # 这 0.3~0.4s 控制台会被实打实录进成片 —— 在每个 jump-cut 接缝处闪一下。
                    # 先 _obs_pause() 只是一个 websocket 调用（~100-200ms），且上一段
                    # seg_dur sleep 刚结束、demo tick 已到 seg_end，后面本不需要再录，
                    # 提前暂停对内容完整性无影响。POV 段不漏控制台就是因为外层「防结算」
                    # 已提前 OBS pause。
                    if not _obs_pause():
                        jump_cut_active = False
                        fatal_recording_error = (
                            "OBS recording pause is required for smart jump-cut, "
                            "but PauseRecord did not enter the paused state."
                        )
                        logger.error(
                            "%s clip_id=%s segment=%d/%d; stopping instead of recording a continuous tail",
                            fatal_recording_error,
                            clip_id,
                            si + 1,
                            len(segments),
                        )
                        break

                    skip_leading_pause = False
                    # 【demo_pause 必须 skip_console_toggle=False + close_console=True】
                    # 上一段 stage 5 用 hideconsole 关掉了控制台，这里若 skip=True 直接投
                    # WM_CHAR("demo_pause\r") 会被 CS2 主窗口丢弃（没有控制台 UI 接收）→
                    # demo 没有真正 pause → 紧随其后的 _prepare_clip_playback 要跑 6~7s
                    # （goto_delay + spec + hide + pre_record + 注入耗时），期间 demo 持续
                    # 以 1× 自由播放，等到最后 demo_resume + _obs_resume 时 demo 已越过
                    # seg_start 好几秒 → OBS 开录时击杀已经发生 → 整段录制跳过击杀瞬间。
                    # 让本次调用自己按 `~` 打开控制台、注入 demo_pause、再 hideconsole 关闭，
                    # 才能保证 demo 在 stage 1 demo_gototick 跳转前就停住、跳完仍保持暂停。
                    # （OBS 已在上面先 pause，此时开控制台不会录进成片。）
                    ok_seg_pause = await asyncio.to_thread(
                        inject_console_sequence,
                        ["demo_pause"],
                        skip_console_toggle=False,
                        close_console=True,
                    )
                    if ok_seg_pause:
                        skip_leading_pause = True
                        await asyncio.sleep(0.08)
                    else:
                        logger.warning(
                            "demo_pause at segment boundary failed; seek may rewind visually",
                        )
                    try:
                        # seek 提前 jc_burn_ticks：补偿 demo_resume→OBS_resume 期间 demo 的预播放量，
                        # 保证 OBS 恢复录制时 demo 恰好落在 seg_start（使击杀前缓冲完整可见）。
                        jc_seek_tick = max(0, seg_start - _jc_burn_ticks)
                        logger.info(
                            "jump_cut seg=%d seg_start=%d jc_burn=%d actual_seek=%d",
                            si, seg_start, _jc_burn_ticks, jc_seek_tick,
                        )
                        try:
                            await self._prepare_clip_playback(
                                demo_abs,
                                jc_seek_tick,
                                spectator_name,
                                spectator_user_id,
                                warmup=warmup,
                                inject_session_warmup_cvars=False,
                                jump_cut_seek=True,
                                jump_cut_skip_leading_demo_pause=skip_leading_pause,
                            )
                        except Exception as prep_e:
                            logger.error("prepare_clip_playback between segments failed: %s", prep_e)
                        # demo_resume 必须在 _obs_resume() 之前完成：
                        # 与 POV 段一致——先 skip=False 明确打开控制台、注入命令、关闭控制台，
                        # 再让 OBS 恢复录制，保证控制台不出现在成片里。
                        resume_demo = os.environ.get(
                            "CS2_INSIGHT_DEMO_RESUME_AFTER_SEEK", "1",
                        ).strip().lower() not in ("0", "false", "no")
                        if resume_demo:
                            ok_dr = await asyncio.to_thread(
                                inject_console_sequence,
                                ["demo_timescale 1", "demo_resume"],
                                skip_console_toggle=False,
                                close_console=True,
                            )
                            if not ok_dr:
                                logger.warning("demo_resume before OBS ResumeRecord failed (jump_cut)")
                            await self._sleep_abortable(
                                self._env_float("CS2_INSIGHT_POST_OBS_RESUME_DEMO_DELAY", "0.25"),
                            )
                        await self._sleep_abortable(settle_between)
                    finally:
                        _obs_resume()
                    await self._sleep_abortable(seg_dur)

            # ── 主录制结束后立即暂停 OBS + demo ───────────────────────────────
            # 最后一回合：clip_max_tick（= last_kill_tick + CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC*64）
            # 就是结算界面触发 tick。sleep(seg_dur) 结束时 demo 正好在该 tick 附近，
            # 只要再多播几十毫秒渲染器就被结算界面单向锁定，后续 POV 段倒退 seek 全部黑屏。
            #
            # 【时序关键 —— 必须先 OBS 暂停，再 demo 暂停】
            # "demo_pause" 注入自己就要 ~0.6s（开控制台 → 发字符+Enter → hideconsole）。
            # 若先注入 demo_pause 再 _obs_pause，这 0.6s 里 OBS 仍在录制，
            # demo 继续从 last_kill_tick 向后播 ~38 tick，结算界面会被录进主成片。
            # 所以这里先 _obs_pause()（一个 websocket 调用，仅 ~200ms），OBS 停后
            # demo 无论再滑多少 tick 都不会入镜；再慢条斯理地 demo_pause 让渲染器
            # 停在击杀帧附近，供后续 POV 段倒退 seek 使用。
            _clip_max_val = int(clip.get("clip_max_tick") or 0)
            _pre_pov_obs_paused = False
            if _clip_max_val > 0:
                # 1) OBS 先暂停：立刻切断主视频对结算画面的录入窗口。
                #    若 OBS 输出格式不支持 pause（MP4/部分硬编码），_obs_pause() 返回 False，
                #    此时退化到原行为（仅 demo_pause 兜底，主视频可能多录 0.6s 结算）。
                _pre_pov_obs_paused = _obs_pause()
                if _pre_pov_obs_paused:
                    await asyncio.sleep(0.05)  # 让 OBS 真正进入 PAUSED 再继续
                # 2) 再注入 demo_pause（skip=False + close=True：当前控制台已关，
                #    必须自己开/关控制台，否则 WM_CHAR 投不进控制台）。
                #    即便 OBS 已 pause，这步仍然必要：POV 段要倒退 seek，若 demo 此刻
                #    滑进结算界面渲染器会被锁定，倒退 seek 输出黑屏。
                _ok_post_pause = await asyncio.to_thread(
                    inject_console_sequence,
                    ["demo_pause"],
                    skip_console_toggle=False,
                    close_console=True,
                )
                if not _ok_post_pause:
                    logger.warning("demo_pause after main recording failed; POV seeks may hit settlement screen")
                else:
                    await asyncio.sleep(0.06)

            # ── 追加 POV 段落（受害者视角 / 击杀者视角） ────────────────────────
            # 高光片段：追加每位受害者死亡前后的视角；失误片段：追加击杀者视角。
            # 开关及独立时序参数均来自 clip.pacing_override（由队列抽屉写入）。
            _vpo = clip.get("pacing_override") or {}
            if bool(_vpo.get("victim_pov", False)) or bool(_vpo.get("killer_pov", False)):
                _clip_cat   = str(clip.get("category") or "")
                _is_fail_pov = _clip_cat == "fail"
                _default_pov_pre = self._env_float(
                    "CS2_INSIGHT_FAIL_POV_PRE_SEC" if _is_fail_pov else "CS2_INSIGHT_VICTIM_POV_PRE_SEC",
                    "3.0" if _is_fail_pov else "1.5",
                )
                _default_pov_post = self._env_float(
                    "CS2_INSIGHT_FAIL_POV_POST_SEC" if _is_fail_pov else "CS2_INSIGHT_VICTIM_POV_POST_SEC",
                    "1.5" if _is_fail_pov else "1.0",
                )
                _pre_vic = float(_vpo.get("victim_pov_pre_sec", _default_pov_pre))
                _post_vic = float(_vpo.get("victim_pov_post_sec", _default_pov_post))
                _want_victim_pov = bool(_vpo.get("victim_pov", False)) and _clip_cat != "fail"
                # Backward compatibility: the old victim_pov switch meant killer POV for fail clips.
                _want_killer_pov = bool(_vpo.get("killer_pov", False)) or (
                    bool(_vpo.get("victim_pov", False)) and _clip_cat == "fail"
                )
                # 每个 pair 形如 (name, kill_tick, next_kill_tick or None)；
                # next_kill_tick 用于把"中间受害者"的录制窗口提前关掉，
                # 避免同 killer 的下一颗子弹打死人触发 CS2 spec 镜头被抢到 killer 身上。
                _vic_pairs = []
                if _clip_cat == "fail":
                    # 击杀者视角：以玩家死亡帧为基准（单段，无后续 kill 联动）
                    _killer_name = str(clip.get("killer_name") or "").strip()
                    _death_t     = clip.get("death_tick")
                    if _want_killer_pov and _killer_name and _death_t is not None:
                        _vic_pairs.append((_killer_name, int(_death_t), None))
                else:
                    _vk_ticks  = _clip_kill_ticks_in_order(clip)
                    if _want_victim_pov:
                        # 受害者视角（高光/合集片段）：按 kill_ticks 顺序逐一追加
                        _vic_list  = clip.get("victims") or []
                        for _i, (_vn, _vt) in enumerate(zip(_vic_list, _vk_ticks)):
                            _nxt = int(_vk_ticks[_i + 1]) if _i + 1 < len(_vk_ticks) else None
                            _vic_pairs.append((_vn, int(_vt), _nxt))
                    if _want_killer_pov:
                        _killer_list = clip.get("killers") or []
                        if not _killer_list:
                            _fallback_killer = (
                                str(clip.get("_spec_name") or "").strip()
                                or str(clip.get("target_player") or "").strip()
                                or str(spectator_name or "").strip()
                            )
                            _killer_list = [_fallback_killer] * len(_vk_ticks)
                        for _kn, _kt in zip(_killer_list, _vk_ticks):
                            _vic_pairs.append((_kn, int(_kt), None))
                _pre_vic_t  = int(_pre_vic  * DEMO_TICK_RATE)
                _post_vic_t = int(_post_vic * DEMO_TICK_RATE)
                _clip_min   = max(0, int(clip.get("clip_min_tick") or 0))
                _clip_max   = int(clip.get("clip_max_tick") or 0)
                _pov_post_resume_delay = self._env_float("CS2_INSIGHT_POST_OBS_RESUME_DEMO_DELAY", "0.25")
                _pov_resume_inject_burn = self._env_float("CS2_INSIGHT_POV_RESUME_INJECT_BURN_SEC", "0.8")
                _pov_burn_sec = self._env_float(
                    "CS2_INSIGHT_POV_BURN_SEC",
                    str(max(0.0, settle_between + _pov_post_resume_delay + _pov_resume_inject_burn)),
                )
                _pov_burn_ticks = max(0, int(_pov_burn_sec * DEMO_TICK_RATE))
                _pov_clipmax_margin_ticks = max(
                    0,
                    int(self._env_float("CS2_INSIGHT_POV_CLIPMAX_MARGIN_SEC", "0.25") * DEMO_TICK_RATE),
                )
                # 中间受害者：clamp _vs_end 到下一次击杀 tick 前 N 秒，规避 CS2
                # 在同 killer 接续击杀时把 spectator 镜头从受害者身上抢到 killer 身上。
                # 设为 0 即关闭 clamp，恢复旧行为。
                _next_kill_safety_ticks = max(
                    0,
                    int(self._env_float("CS2_INSIGHT_POV_NEXT_KILL_SAFETY_SEC", "0.15") * DEMO_TICK_RATE),
                )

                for _vname, _vtick, _next_kill_tick in _vic_pairs:
                    if not _vname:
                        continue
                    _vs_start = max(_clip_min, _vtick - _pre_vic_t)
                    _vs_end   = _vtick + _post_vic_t
                    # 最后一回合结束后 CS2 进入结算界面，渲染单向锁定；
                    # 若 POV 锚点 tick 本身已超出安全上限，则倒退 seek 也无法恢复画面，直接跳过。
                    if _clip_max > 0 and _vs_start >= _clip_max:
                        logger.info(
                            "POV %s skipped: vs_start=%d >= clip_max_tick=%d (post-match screen)",
                            _vname, _vs_start, _clip_max,
                        )
                        continue
                    # 同时裁剪 POV 段落的结束时间，防止录入结算界面画面。
                    # 多留 0.3s 缓冲：sleep 结束 → _obs_pause 生效之间 OBS 仍在录，
                    # 若恰好卡在 clip_max tick 这 0.3s 就会录到结算界面首帧。
                    if _clip_max > 0:
                        _vs_end = min(_vs_end, _clip_max - _pov_clipmax_margin_ticks)
                    # ★ 中间受害者抢镜兜底：当 killer 紧接着又杀人时，CS2 的 spectator 镜头
                    #   会被新的 player_death 事件夺到 killer 身上（与 freezecam 时长无关，
                    #   是事件驱动）。把 _vs_end clamp 到下一次击杀前 N 秒，让本段在
                    #   killer 开下一枪之前就关录，规避抢镜窗口。
                    if _next_kill_tick is not None and _next_kill_safety_ticks >= 0:
                        _vs_end = min(_vs_end, int(_next_kill_tick) - _next_kill_safety_ticks)
                    if _vs_end <= _vs_start:
                        logger.info(
                            "POV %s skipped: empty safe window start=%d end=%d clip_max=%d",
                            _vname,
                            _vs_start,
                            _vs_end,
                            _clip_max,
                        )
                        continue

                    _pov_seek_tick = max(_clip_min, _vs_start - _pov_burn_ticks)
                    _estimated_record_start = _pov_seek_tick + _pov_burn_ticks
                    _pov_record_dur = max(
                        0.0,
                        (_vs_end - _estimated_record_start) / float(DEMO_TICK_RATE),
                    )
                    if _pov_record_dur <= 0:
                        logger.info(
                            "POV %s skipped: burn compensation passes safe end seek=%d est_start=%d end=%d",
                            _vname,
                            _pov_seek_tick,
                            _estimated_record_start,
                            _vs_end,
                        )
                        continue

                    # OBS 先暂停（seek 期间不录制）。
                    # demo 的 pause 由 _prepare_clip_playback 内部完整批次完成：
                    # ["demo_pause", "demo_timescale 1", "demo_gototick X"]
                    # 单独在外部 demo_pause 后再发孤立的 demo_gototick 会导致 CS2
                    # 将 seek 命令延迟到 demo_resume 之后才执行，造成 seek 失效。
                    #
                    # 首次进入 POV 循环时，主录制结束处已经 _obs_pause 过（防结算兜底），
                    # OBS 对已 paused 的输出再发 PauseRecord 会返回错误 → 误判为 pause 失败 →
                    # 整段 POV break。这里用 _pre_pov_obs_paused 复用那次 pause，避免重复调用。
                    if _pre_pov_obs_paused:
                        _pre_pov_obs_paused = False  # 仅首次复用
                    elif not _obs_pause():
                        logger.warning("OBS PauseRecord failed for POV append (%s); skipping", _vname)
                        break

                    _ok_vdr = False
                    try:
                        # skip_leading=False：内部完整注入 demo_pause + demo_timescale 1 + demo_gototick，
                        # 确保倒退 seek 在 demo_pause 状态下可靠触发。
                        # goto_delay_extra 应对倒退 seek（需从 keyframe 重扫）的较长耗时。
                        # 注意：jump_cut_seek=True 会跳过 stage-2 demo_resume，导致 stage-4 的
                        # spec_mode/spec_player 在 demo 暂停状态下发出 → CS2 静默忽略视角切换。
                        # 修正：将 spec 命令合入下方 demo_resume 注入批次，确保 demo 已恢复
                        # 播放时再切摄像机。
                        await self._prepare_clip_playback(
                            demo_abs,
                            max(0, _pov_seek_tick),
                            None,   # spec 由下方 demo_resume 批次完成
                            None,
                            warmup=warmup,
                            inject_session_warmup_cvars=False,
                            jump_cut_seek=True,
                            jump_cut_skip_leading_demo_pause=False,
                            goto_delay_extra=self._env_float("CS2_INSIGHT_POV_GOTO_DELAY_EXTRA", "3.5"),
                        )
                        # demo_resume 必须在 _obs_resume() 之前完成：
                        # skip=False 会用 ~ 打开控制台，若在 OBS 已开始录制后才打开，
                        # 控制台界面会录入成片。先 resume 并 close 控制台，再让 OBS 开录。
                        # 同时重置 demo_timescale 1 防止倒退 seek 后速度归零导致画面冻结。
                        # ★ spec_mode + spec_player 紧跟 demo_resume 发出（demo 已恢复播放），
                        #   避免 jump_cut_seek 路径下 spec 在 demo 暂停时发出被 CS2 静默忽略。
                        _raw_mode = (os.environ.get("CS2_SPEC_MODE") or "5").strip()
                        try:
                            _pov_mode = int(_raw_mode)
                        except ValueError:
                            _pov_mode = 5
                        _pov_slot = self._calibrated_spec_slot_for_name(demo_abs, _vname)
                        _pov_source = "gsi-calibrated" if _pov_slot is not None else None
                        if _pov_slot is None and _vname:
                            _pov_slot = self._parsed_spec_slot_for_name(demo_abs, max(0, _vs_start), _vname)
                            if _pov_slot is not None:
                                _pov_source = "parsed-fallback"
                                logger.warning(
                                    "POV spec calibration missed name=%r demo=%s; falling back to parsed slot=%s",
                                    _vname,
                                    demo_abs,
                                    _pov_slot,
                                )
                        _ok_vdr = await asyncio.to_thread(
                            inject_console_sequence,
                            ["demo_timescale 1", "demo_resume"],
                            skip_console_toggle=False,
                            close_console=True,
                        )
                        if _ok_vdr:
                            await self._sleep_abortable(
                                self._env_float("CS2_INSIGHT_POV_RESUME_TO_SPEC_DELAY", "0.18"),
                            )
                            if _pov_slot is not None:
                                _spec_cmds = [f"spec_mode {_pov_mode}", f"spec_player {int(_pov_slot)}"]
                                logger.info(
                                    "POV spec staged name=%r slot=%s source=%s",
                                    _vname,
                                    _pov_slot,
                                    _pov_source,
                                )
                            elif _vname:
                                logger.warning(
                                    "POV spec calibration missed name=%r demo=%s; skipping name-based spec_player fallback",
                                    _vname,
                                    demo_abs,
                                )
                                _spec_cmds = []
                            else:
                                _spec_cmds = []
                            if _spec_cmds:
                                _ok_vdr = await asyncio.to_thread(
                                    inject_console_sequence,
                                    _spec_cmds,
                                    skip_console_toggle=False,
                                    close_console=True,
                                )
                        if _ok_vdr:
                            await self._sleep_abortable(_pov_post_resume_delay)
                            await self._sleep_abortable(settle_between)
                    finally:
                        _obs_resume()

                    if not _ok_vdr:
                        logger.warning("POV resume/spec injection failed for %s; segment may be unstable", _vname)
                    await self._sleep_abortable(_pov_record_dur)

                # 最后一回合：POV 全部录完后立即 OBS 暂停 + demo_pause。
                # for 循环结束时 OBS 仍在录制，demo 仍在播放；Python 跑到外层 finally
                # StopRecord 中间有数百毫秒空窗，demo 会滑过 clip_max_tick 进入结算界面。
                # 先 pause OBS（~200ms 生效），再 pause demo，不给结算界面录入窗口。
                if _clip_max_val > 0:
                    _obs_pause()
                    await asyncio.sleep(0.05)
                    await asyncio.to_thread(
                        inject_console_sequence,
                        ["demo_pause"],
                        skip_console_toggle=False,
                        close_console=True,
                    )
            # ────────────────────────────────────────────────────────────────────
        finally:
            try:
                # OBS 在 PAUSED 状态下直接 StopRecord 会卡在"正在停止录制"：
                # OBS 需要先内部 resume 再封装文件，对混合 MP4 格式尤其明显。
                # 先发 ResumeRecord（若未暂停则 OBS 忽略），确保 OBS 处于 active
                # 再立即 StopRecord，可显著降低卡住概率。
                if self._ws:
                    try:
                        req_resume = getattr(obs_requests, "ResumeRecord", None)
                        if req_resume is not None:
                            self._ws.call(req_resume())
                    except Exception:
                        pass  # 未暂停时 OBS 可能返回错误，忽略即可
                    stop_resp = self._ws.call(obs_requests.StopRecord())
                    stop_record_output_path = self._obs_response_output_path(stop_resp)
            except Exception as se:
                logger.debug("StopRecord: %s", se)
            try:
                self._obs_restore_hide_cursor_inputs()
            except Exception as re:
                logger.debug("restore OBS cursor: %s", re)
            try:
                self._win_cursor_restore_pos(cursor_bak)
            except Exception as ce:
                logger.debug("restore cursor pos: %s", ce)
            if record_started_at_wall is not None or stop_record_output_path is not None:
                output_result = await self._finalize_obs_recording_rename(
                    stop_record_output_path,
                    clip,
                    demo_abs,
                    spectator_name,
                    record_started_at_wall,
                )

        self._set_state(DirectorState.STOPPING, clip_id)
        if fatal_recording_error:
            return {
                "clip_id": clip_id,
                "status": "error",
                "error": fatal_recording_error,
                "duration": planned_wall_seconds,
                "smart_jump_segments": len(segments) if use_smart_jump else 1,
                **output_result,
            }
        return {
            "clip_id": clip_id,
            "status": "recorded",
            "duration": planned_wall_seconds,
            "smart_jump_segments": len(segments) if use_smart_jump else 1,
            **output_result,
        }

    def _obs_apply_hide_cursor_inputs(self) -> None:
        """录制前关闭各输入源的「采集光标」（OBS 5 SetInputSettings capture_cursor）。"""
        if not self._ws:
            return
        if os.environ.get("CS2_INSIGHT_HIDE_OBS_CURSOR", "1").strip().lower() in ("0", "false", "no"):
            return
        self._obs_cursor_restore.clear()
        try:
            resp = self._ws.call(obs_requests.GetInputList())
            inputs = resp.datain.get("inputs") or []
        except Exception as e:
            logger.warning("OBS GetInputList failed: %s", e)
            return
        for it in inputs:
            name = it.get("inputName")
            if not name:
                continue
            try:
                gs = self._ws.call(obs_requests.GetInputSettings(inputName=name))
                settings = dict(gs.datain.get("inputSettings") or {})
            except Exception:
                continue
            if "capture_cursor" not in settings:
                continue
            prev = bool(settings["capture_cursor"])
            if not prev:
                continue
            try:
                self._ws.call(
                    obs_requests.SetInputSettings(
                        inputName=name,
                        inputSettings={"capture_cursor": False},
                        overlay=True,
                    )
                )
                self._obs_cursor_restore.append((name, prev))
                logger.info("OBS input %r: capture_cursor false", name)
            except Exception as e:
                logger.warning("OBS SetInputSettings %r: %s", name, e)

    def _obs_restore_hide_cursor_inputs(self) -> None:
        if not self._ws:
            self._obs_cursor_restore.clear()
            return
        for name, prev in self._obs_cursor_restore:
            try:
                self._ws.call(
                    obs_requests.SetInputSettings(
                        inputName=name,
                        inputSettings={"capture_cursor": prev},
                        overlay=True,
                    )
                )
            except Exception as e:
                logger.warning("OBS restore capture_cursor %r: %s", name, e)
        self._obs_cursor_restore.clear()

    @staticmethod
    def _win_cursor_corner_backup() -> Optional[Tuple[int, int, int, int]]:
        """返回 (cursor_x, cursor_y, smx, smy)，失败则 None。"""
        if sys.platform != "win32":
            return None
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        pt = POINT()
        if not user32.GetCursorPos(ctypes.byref(pt)):
            return None
        smx = user32.GetSystemMetrics(0)
        smy = user32.GetSystemMetrics(1)
        return (int(pt.x), int(pt.y), int(smx), int(smy))

    @staticmethod
    def _win_cursor_move_corner(bak: Optional[Tuple[int, int, int, int]]) -> None:
        if not bak or sys.platform != "win32":
            return
        import ctypes

        _, _, smx, smy = bak
        ctypes.windll.user32.SetCursorPos(max(0, smx - 3), max(0, smy - 3))

    @staticmethod
    def _win_cursor_restore_pos(bak: Optional[Tuple[int, int, int, int]]) -> None:
        if not bak or sys.platform != "win32":
            return
        import ctypes

        x, y, _, _ = bak
        ctypes.windll.user32.SetCursorPos(x, y)

    async def execute_recording_pipeline(
        self,
        demo_abs: Path,
        clips: list[dict],
        spectator_name: Optional[str] = None,
        spectator_user_id: Optional[int] = None,
        warmup: Optional[RecordingWarmupExtras] = None,
    ) -> list[dict]:
        """
        Full pipeline: copy demo -> game/csgo, launch CS2 +playdemo -> OBS record -> cleanup.
        若提供 ``spectator_user_id``，控制台使用 ``spec_player <id>``；否则用 ``spectator_name``。
        Returns updated clips with recording status.
        """
        results: list[dict] = []

        try:
            self._launch_cs2(demo_abs, warmup)
            self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
            await self._await_gsi_startup_gate()

            if not self.connect_obs():
                self._set_state(DirectorState.ERROR, "Cannot connect to OBS")
                return [{"clip_id": c["clip_id"], "status": "obs_error"} for c in clips]

            self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
            load_ok = False
            try:
                await self._sleep_abortable(8.0)
                await self._await_cs2_window(40.0)
                await self._calibrate_spec_players_for_demo(demo_abs)
                load_ok = True
            except RecordingAborted:
                logger.info("Recording aborted by user (pre-clip)")
                await self._run_cleanup_step("OBS StopRecord after abort", self._safe_stop_obs_recording, timeout=10.0)
                for c in clips:
                    results.append({"clip_id": c["clip_id"], "status": "aborted"})

            if load_ok:
                for clip_idx, clip in enumerate(clips):
                    clip_id = clip["clip_id"]
                    try:
                        self._check_abort()
                        one = await self._execute_single_clip_recording(
                            clip,
                            demo_abs,
                            spectator_name,
                            spectator_user_id,
                            clip_idx=clip_idx,
                            warmup=warmup,
                        )
                        results.append(one)
                    except RecordingAborted:
                        logger.info("Recording aborted by user at clip %s", clip_id)
                        await self._run_cleanup_step(
                            "OBS StopRecord after abort",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        results.append({"clip_id": clip_id, "status": "aborted"})
                        for c in clips[clip_idx + 1:]:
                            results.append({"clip_id": c["clip_id"], "status": "aborted"})
                        break
                    except Exception as e:
                        logger.error("Recording failed for %s: %s", clip_id, e)
                        try:
                            self._obs_restore_hide_cursor_inputs()
                        except Exception:
                            pass
                        results.append({"clip_id": clip_id, "status": "error", "error": str(e)})

        except RecordingAborted:
            self._set_state(DirectorState.STOPPING, "aborted")
        except Exception as e:
            self._set_state(DirectorState.ERROR, str(e))
            raise
        finally:
            await self._cleanup_recording_session()
            self._set_state(DirectorState.COMPLETED)

        return results

    async def execute_batch_recording(
        self,
        demo_jobs: list[tuple[Path, list[dict], Optional[str], Optional[int]]],
        warmup: Optional[RecordingWarmupExtras] = None,
    ) -> list[dict]:
        """
        多 Demo 批量录制：OBS 全程保持连接；每个 Demo 启动 CS2 → 录完该 Demo 全部片段 → 关闭游戏，再下一个。
        ``demo_jobs`` 每项为 ``(demo_abs, clips, spectator_name, spectator_user_id)``。
        返回扁平结果列表，每条含 ``demo_filename`` 便于前端对照。
        """
        all_results: list[dict] = []

        if not demo_jobs:
            return all_results

        try:
            if not self.connect_obs():
                self._set_state(DirectorState.ERROR, "Cannot connect to OBS")
                for dem_path, clips, _, _ in demo_jobs:
                    df = dem_path.name
                    for c in clips:
                        all_results.append(
                            {"clip_id": c["clip_id"], "status": "obs_error", "demo_filename": df},
                        )
                return all_results

            batch_aborted = False
            for job_idx, (demo_abs, clips, spectator_name, spectator_uid) in enumerate(demo_jobs):
                if batch_aborted:
                    break
                if not clips:
                    continue
                demo_name = demo_abs.name
                self._set_state(DirectorState.LAUNCHING_CS2, f"batch job {job_idx + 1}/{len(demo_jobs)} {demo_name}")
                try:
                    self._launch_cs2(demo_abs, warmup)
                    self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
                    await self._await_gsi_startup_gate()
                except CS2AlreadyRunningError:
                    raise
                except CS2NotReadyError:
                    # GSI 超时：必须在收尾后把异常一路抛回 FastAPI，让 main.py 翻译成 HTTP 409，
                    # 否则被下面 ``except Exception`` 兜底变成 per-clip "error" 列表 + 200 OK，
                    # 前端的 409 对话框逻辑收不到。
                    logger.error("Batch: GSI not ready for %s; aborting batch", demo_name)
                    await self._run_cleanup_step("CS2 shutdown after GSI timeout", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step(
                        "CS2 artifact cleanup after GSI timeout",
                        self._cleanup_cs2_artifacts,
                        timeout=8.0,
                    )
                    raise
                except Exception as e:
                    logger.error("Batch: launch CS2 failed for %s: %s", demo_name, e)
                    for c in clips:
                        all_results.append(
                            {
                                "clip_id": c["clip_id"],
                                "status": "error",
                                "error": str(e),
                                "demo_filename": demo_name,
                            },
                        )
                    await self._run_cleanup_step("CS2 shutdown after launch failure", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step(
                        "CS2 artifact cleanup after launch failure",
                        self._cleanup_cs2_artifacts,
                        timeout=8.0,
                    )
                    continue

                self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
                try:
                    await self._sleep_abortable(8.0)
                    await self._await_cs2_window(40.0)
                    if job_idx > 0:
                        batch_settle = self._env_float("CS2_INSIGHT_BATCH_NEW_DEMO_SETTLE_SEC", "9.0")
                        if batch_settle > 0:
                            logger.info(
                                "Batch: extra %.1fs after window ready before first clip (demo job %s/%s)",
                                batch_settle,
                                job_idx + 1,
                                len(demo_jobs),
                            )
                            await self._sleep_abortable(batch_settle)
                    await self._calibrate_spec_players_for_demo(demo_abs)
                except RecordingAborted:
                    logger.info("Batch recording aborted by user (pre-clip) for %s", demo_name)
                    await self._run_cleanup_step("OBS StopRecord after abort", self._safe_stop_obs_recording, timeout=10.0)
                    OBSDirector._append_aborted_results_for_tail(demo_jobs, job_idx, -1, all_results)
                    await self._run_cleanup_step("CS2 shutdown after abort", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step(
                        "CS2 artifact cleanup after abort",
                        self._cleanup_cs2_artifacts,
                        timeout=8.0,
                    )
                    batch_aborted = True
                    break

                for clip_idx, clip in enumerate(clips):
                    if batch_aborted:
                        break
                    clip_id = clip["clip_id"]
                    try:
                        self._check_abort()
                        one = await self._execute_single_clip_recording(
                            clip,
                            demo_abs,
                            spectator_name,
                            spectator_uid,
                            clip_idx=clip_idx,
                            warmup=warmup,
                            batch_new_demo_first_clip=(job_idx > 0 and clip_idx == 0),
                        )
                        one["demo_filename"] = demo_name
                        all_results.append(one)
                    except RecordingAborted:
                        logger.info("Batch recording aborted by user at clip %s", clip_id)
                        await self._run_cleanup_step(
                            "OBS StopRecord after abort",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        all_results.append(
                            {"clip_id": clip_id, "status": "aborted", "demo_filename": demo_name},
                        )
                        OBSDirector._append_aborted_results_for_tail(demo_jobs, job_idx, clip_idx, all_results)
                        await self._run_cleanup_step("CS2 shutdown after abort", self._kill_cs2, timeout=30.0)
                        await self._run_cleanup_step(
                            "CS2 artifact cleanup after abort",
                            self._cleanup_cs2_artifacts,
                            timeout=8.0,
                        )
                        batch_aborted = True
                        break
                    except Exception as e:
                        logger.error("Batch recording failed for %s: %s", clip_id, e)
                        try:
                            self._obs_restore_hide_cursor_inputs()
                        except Exception:
                            pass
                        all_results.append(
                            {"clip_id": clip_id, "status": "error", "error": str(e), "demo_filename": demo_name},
                        )

                if batch_aborted:
                    break

                await self._run_cleanup_step("CS2 shutdown after batch job", self._kill_cs2, timeout=30.0)
                await self._run_cleanup_step(
                    "CS2 artifact cleanup after batch job",
                    self._cleanup_cs2_artifacts,
                    timeout=8.0,
                )

        except RecordingAborted:
            self._set_state(DirectorState.STOPPING, "aborted")
        except Exception as e:
            self._set_state(DirectorState.ERROR, str(e))
            raise
        finally:
            await self._cleanup_recording_session()
            self._set_state(DirectorState.COMPLETED)

        return all_results
