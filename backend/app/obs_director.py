"""自动化导播控制 - OBS 录制 & CS2 Demo 回放控制"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import struct
import sys
import shutil
import shlex
import subprocess
import time
import unicodedata
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, List, Literal, Optional, Tuple

import websocket
from obswebsocket import exceptions as obs_ws_exceptions
from obswebsocket import obsws, requests as obs_requests
from obswebsocket.core import RecvThread, ReconnectThread

from .demo_parse_isolation import IsolatedParseError, get_demo_match_summary_isolated
from .demo_parser import (
    BUFFER_SECONDS_AFTER,
    BUFFER_SECONDS_BEFORE,
    TICK_RATE as DEMO_TICK_RATE,
    compute_spec_player_slot_one_based,
    get_demo_spec_calibration_tick,
    get_player_list,
    spec_player_extra_offset_for_gsi_failure,
)
from .cs2_config_backup import (
    _atomic_write_bytes,
    is_cs2_running,
    is_restore_required,
    restore_latest_user_config_backup,
    write_persistent_backup_from_snap,
)
from .env_utils import OBSConfig, SpecPlayerVerifyConfig, _steam_install_from_registry as _get_steam_install_root
from .gsi_ready import gsi_status, is_gsi_ready, reset_gsi_ready, wait_gsi_payload_after
from .pov_constants import POV_CORE_FORCED_COMMANDS, pov_tail_commands
from .win_cs2_console import ensure_cs2_foreground, find_cs2_hwnd, inject_console_sequence, send_cs2_space_taps

logger = logging.getLogger(__name__)


class _ObswsBoundedHandshake(obsws):
    """与 obsws 相同，但对 ``WebSocket.connect`` 传入 ``timeout``，避免无服务时长时间阻塞。"""

    def __init__(
        self,
        host: str = "localhost",
        port: int | str = 4444,
        password: str = "",
        *,
        handshake_timeout_sec: float = 4.0,
        legacy=None,
        timeout: int = 60,
        authreconnect: int = 0,
        on_connect: Optional[Callable] = None,
        on_disconnect: Optional[Callable] = None,
    ):
        self._obs_handshake_timeout_sec = max(0.5, float(handshake_timeout_sec))
        super().__init__(
            host,
            port,
            password,
            legacy=legacy,
            timeout=timeout,
            authreconnect=authreconnect,
            on_connect=on_connect,
            on_disconnect=on_disconnect,
        )

    def connect(self):
        try:
            self.ws = websocket.WebSocket()
            url = "ws://{}:{}".format(self.host, self.port)
            logger.info(
                "Connecting to %s (handshake timeout=%ss)...",
                url,
                self._obs_handshake_timeout_sec,
            )
            self.ws.connect(url, timeout=self._obs_handshake_timeout_sec)
            logger.info("Connected to OBS WebSocket")
            if self.legacy:
                self._auth_legacy()
            else:
                self._auth()

            if self.thread_recv is not None:
                self.thread_recv.running = False
            self.thread_recv = RecvThread(self)
            self.thread_recv.daemon = True
            self.thread_recv.start()
            if self.on_connect:
                self.on_connect(self)
        except socket.error as e:
            if self.authreconnect:
                if not self.thread_reco:
                    logger.warning(
                        "Connection failed, reconnecting in %s second(s).",
                        self.authreconnect,
                    )
                    self.thread_reco = ReconnectThread(self)
                    self.thread_reco.daemon = True
                    self.thread_reco.start()
                else:
                    logger.warning("Connection failed, but reconnect timer already running.")
            else:
                raise obs_ws_exceptions.ConnectionFailure(str(e)) from e


def _friendly_obs_websocket_test_error(exc: BaseException) -> str:
    """将连接异常写成玩家可读说明，避免直接展示 WinError 等技术串。"""
    raw = str(exc)
    low = raw.lower()
    if "auth" in low or "password" in low or ("invalid" in low and "secret" in low):
        return (
            "WebSocket 密码验证失败。请在 OBS「工具 → WebSocket 服务器设置」中核对密码，并与本页填写一致。"
        )
    if (
        "10061" in raw
        or "积极拒绝" in raw
        or "connection refused" in low
        or "拒绝连接" in raw
        or isinstance(exc, ConnectionRefusedError)
    ):
        return (
            "无法连接到 OBS（连接被拒绝）。请确认：① OBS 已启动；② 已在 OBS「工具 → WebSocket 服务器设置」中"
            "勾选「启用 WebSocket 服务器」；③ 端口号与本页一致（默认通常为 4455）。"
        )
    if "10060" in raw or "timed out" in low or ("超时" in raw and "连接" in raw):
        return (
            "连接 OBS 超时。请确认主机填写为 localhost 或 127.0.0.1，OBS 已运行，且防火墙未拦截该端口。"
        )
    if "gaierror" in low or "getaddrinfo" in low or "name or service not known" in low or "不知道这样的主机" in raw:
        return "主机地址无效或无法解析。在本机使用时请填写 localhost 或 127.0.0.1。"
    if "10054" in raw or "远程主机强迫关闭" in raw or "connection reset" in low:
        return "连接被中断。请重启 OBS，并确认 WebSocket 服务器仍处于启用状态。"
    if "10013" in raw or "访问权限" in raw and "套接字" in raw:
        return "当前环境不允许使用该端口，可能被防火墙或安全软件拦截，请检查后重试。"
    return (
        "无法连接 OBS WebSocket。请先启动 OBS，在「工具 → WebSocket 服务器设置」中启用服务器，"
        "再核对端口与密码是否与本页一致。"
    )


# 写入录制结果 / recorded_clips.clip_meta，供合辑工作台展示回合、比分、标签等
_RECORDING_RESULT_CLIP_META_KEYS: tuple[str, ...] = (
    "category",
    "compilation_kind",
    "round",
    "round_won",
    "score_own",
    "score_opp",
    "context_tags",
    "kill_count",
    "weapon_used",
    "killer_name",
    "victims",
    "killers",
    "ai_score",
    "ai_commentary",
    "start_tick",
    "end_tick",
    "map_name",
    "target_steam_id",
    "steamid",
    "record_start_tick",
    "record_end_tick",
    "demo_tick_rate",
    "source_ticks",
    "source_rounds",
    "source_round_ends",
    "fixed_segment_pacing",
    "freeze_to_death_round_filter",
    "freeze_to_death_round_windows",
    "obs_recording_markers",
    "planned_segments",
    "pov_player_name",
    "pov_steamid64",
    "timeline_source",
    "timeline_event_id",
    "pov_hud_enabled",
    "recording_perspective",
    "victim_pov_segments",
    "death_tick",
    "kill_ticks",
)


def merge_clip_metadata_into_recording_result(out: dict[str, Any], clip: dict[str, Any]) -> dict[str, Any]:
    """把解析阶段 clip 字典中的展示字段合并进单次录制 API 结果。"""
    for k in _RECORDING_RESULT_CLIP_META_KEYS:
        if k not in clip:
            continue
        v = clip[k]
        out[k] = v
    return out


def _recording_basic_clip_meta_fields(
    *,
    meta_record_start_tick: int,
    meta_record_end_tick: int,
) -> dict[str, Any]:
    """新录制写入的 tick 元数据（已移除后期雷达 overlay 同步字段）。"""
    return {
        "demo_tick_rate": float(TICK_RATE),
        "record_start_tick": int(meta_record_start_tick),
        "record_end_tick": int(meta_record_end_tick),
    }


def _source_round_per_demo_segment(clip: dict, segments: list[tuple[int, int]]) -> list[Optional[int]]:
    raw = clip.get("source_ticks") or []
    if not raw or str(clip.get("category") or "").strip() != "compilation":
        return [None] * len(segments)
    rounds_raw = clip.get("source_rounds") or []
    spans: list[tuple[int, int, Optional[int]]] = []
    for idx, item in enumerate(raw):
        try:
            ss = int(item[0])
            ee = int(item[1])
        except (TypeError, ValueError, IndexError):
            continue
        ss = max(0, ss)
        ee = max(ss + 1, ee)
        try:
            rn = int(rounds_raw[idx]) if idx < len(rounds_raw) else None
        except (TypeError, ValueError):
            rn = None
        spans.append((ss, ee, rn))
    out: list[Optional[int]] = []
    for seg_ss, seg_ee in segments:
        best_rn: Optional[int] = None
        best_ov = -1
        for ss, ee, rn in spans:
            lo = max(seg_ss, ss)
            hi = min(seg_ee, ee)
            ov = hi - lo
            if ov > best_ov:
                best_ov = ov
                best_rn = rn
        out.append(best_rn)
    return out


def _build_planned_segments_for_recording_meta(
    clip: dict[str, Any],
    main_segments: list[tuple[int, int]],
    pov_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """录制计划段：仅 demo tick 范围与段语义，不含视频时间轴 / 雷达同步字段。"""
    if not main_segments:
        return []
    source_rounds = _source_round_per_demo_segment(clip, main_segments)
    out: list[dict[str, Any]] = []
    idx = 0
    for si, (ss, ee) in enumerate(main_segments):
        ss_i, ee_i = int(ss), int(ee)
        if ee_i <= ss_i:
            ee_i = ss_i + 1
        row: dict[str, Any] = {
            "segment_index": idx,
            "kind": "main",
            "demo_start_tick": ss_i,
            "demo_end_tick": ee_i,
        }
        if si < len(source_rounds) and source_rounds[si] is not None:
            row["source_round"] = int(source_rounds[si])
        out.append(row)
        idx += 1
    for prow in pov_rows:
        kind_raw = str(prow.get("kind") or "victim_pov")
        kind = kind_raw if kind_raw in ("victim_pov", "killer_pov") else "victim_pov"
        try:
            d0 = int(prow["demo_start_tick"])
            d1 = int(prow["demo_end_tick"])
        except (KeyError, TypeError, ValueError):
            continue
        if d1 <= d0:
            d1 = d0 + 1
        item: dict[str, Any] = {
            "segment_index": idx,
            "kind": kind,
            "demo_start_tick": d0,
            "demo_end_tick": d1,
        }
        tpn = prow.get("target_player_name")
        if tpn is not None and str(tpn).strip():
            item["target_player_name"] = str(tpn).strip()
        out.append(item)
        idx += 1
    return out


def _ffprobe_duration_sec(video_path: Path) -> Optional[float]:
    """读取成片实际时长（秒），供录制调试日志核对 mux 结果。"""
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    try:
        proc = subprocess.run(
            [
                probe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=duration",
                "-of",
                "default=nokey=1:noprint_wrappers=1",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    if proc.returncode != 0:
        return None
    raw = (proc.stdout or "").strip()
    if not raw:
        return None
    try:
        d = float(raw)
    except (TypeError, ValueError):
        return None
    return d if d > 0 else None


def _recording_debug_log_obs_marker_chain(clip_id: str, markers: list[dict[str, Any]]) -> None:
    """OBS Start/Pause/Resume/Stop 单调节拍时间线（仅调试 Pause/Resume 与成片时长，不作雷达同步）。"""
    if not markers:
        logger.info("[recording-debug] clip=%s obs_marker_chain=empty", clip_id)
        return
    t0 = float(markers[0]["mono"])
    chunks: list[str] = []
    prev = t0
    for m in markers:
        mono = float(m["mono"])
        op = str(m.get("op", "?"))
        chunks.append(f"{op}+{mono - t0:.3f}s(d{mono - prev:+.3f})")
        prev = mono
    logger.info("[recording-debug] clip=%s obs_marker_chain=%s", clip_id, " ".join(chunks))


def _recording_debug_log_probe_summary(
    clip_id: str,
    *,
    ffprobe_sec: Optional[float],
    obs_marker_count: int,
) -> None:
    _ff = (
        f"{float(ffprobe_sec):.6f}"
        if isinstance(ffprobe_sec, (int, float)) and ffprobe_sec is not None
        else repr(ffprobe_sec)
    )
    logger.info(
        "[recording-debug] clip=%s ffprobe_sec=%s obs_marker_count=%d",
        clip_id,
        _ff,
        int(obs_marker_count),
    )


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


class _SpecVerifyAbort(Exception):
    """spec_player GSI 验证耗尽所有重试次数，中止当前录制 pipeline。"""


CS2_RUNNING_MESSAGE = "检测到 CS2 正在运行。为避免踢出对局或污染设置，请先手动退出 CS2 后再开始录制。"


class CS2AlreadyRunningError(RuntimeError):
    """Raised when recording would have to take over a user-owned CS2 session."""


class CS2NotReadyError(RuntimeError):
    """Raised when CS2 fails to enter an in-game state (GSI never ready) within the
    recording startup timeout window. Surfaced to frontend as HTTP 409 so the user
    sees the same warning-dialog style as the "CS2 already running" case instead
    of being silently kicked back to the queue with no feedback.
    """


TICK_RATE = 64
PRE_ROLL_TICKS = 300  # ~5 seconds of pre-roll（无 kill_ticks 时的传统 seek）
# 智能跳跃分段阈值见 ``build_smart_jump_segments`` 内 _env_int 默认值。

# 仅随录制预热（首次 seek 前、与 Space 后控制台批次）注入，段间 jump_cut 不再重复执行
_WARMUP_FIXED_CONSOLE_LINES: tuple[str, ...] = (
    "cl_hud_telemetry_frametime_show 0",
    "engine_no_focus_sleep 0",
    "cl_demo_predict 0",
    "fps_max 0",
    "cl_trueview_show_status 0",
)


def _warmup_console_cvar_name(line: str) -> str:
    s = str(line).strip()
    if not s or s.startswith("//"):
        return ""
    return s.split()[0].lower()


def _merge_recording_warmup_console_cmds(user_cmds: list[str]) -> list[str]:
    """前端传入 console_cmds 时仍补齐全部固定预热 cvar（旧逻辑只保证首条）。"""
    fixed_names = {_warmup_console_cvar_name(x) for x in _WARMUP_FIXED_CONSOLE_LINES}
    fixed_names.discard("")
    out: list[str] = list(_WARMUP_FIXED_CONSOLE_LINES)
    for cmd in user_cmds:
        cvar = _warmup_console_cvar_name(cmd)
        if cvar and cvar in fixed_names:
            continue
        out.append(cmd)
    return out
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
    "unbind alt",
)
_RECORDING_VIDEO_EXTENSIONS = {".mkv", ".mp4", ".mov", ".flv", ".ts", ".m2ts", ".avi"}


# 用户配置磁盘备份 / ``recording_state.json`` 见 ``cs2_config_backup`` 模块；
# 运行期仍靠 ``_user_config_snapshot`` 在 taskkill 后配合 manifest 恢复。

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


def _as_int_tick(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        t = int(value)
    except (TypeError, ValueError):
        return None
    return t if t >= 0 else None


def _extract_kill_ticks_for_segment(clip: dict) -> list[int]:
    """高光 / 时间线击杀 / 合集等：收集可用于锚定录制窗的击杀 tick（升序去重）。"""
    ticks: set[int] = set(_clip_kill_ticks_sorted(clip))

    raw_kills = clip.get("kills")
    if isinstance(raw_kills, list):
        for kill in raw_kills:
            if isinstance(kill, dict):
                tick = _as_int_tick(
                    kill.get("tick")
                    or kill.get("event_tick")
                    or kill.get("kill_tick")
                    or kill.get("demo_tick")
                )
                if tick is not None:
                    ticks.add(tick)

    raw_events = clip.get("events")
    if isinstance(raw_events, list):
        for event in raw_events:
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or event.get("event_type") or "").lower()
            if "kill" not in event_type:
                continue
            tick = _as_int_tick(
                event.get("tick")
                or event.get("event_tick")
                or event.get("kill_tick")
                or event.get("demo_tick")
            )
            if tick is not None:
                ticks.add(tick)

    return sorted(ticks)


def _extract_death_tick_for_segment(clip: dict) -> Optional[int]:
    for key in ("death_tick", "died_tick", "victim_death_tick"):
        tick = _as_int_tick(clip.get(key))
        if tick is not None:
            return tick

    raw_events = clip.get("events")
    if isinstance(raw_events, list):
        for event in raw_events:
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or event.get("event_type") or "").lower()
            if "death" not in event_type:
                continue
            tick = _as_int_tick(
                event.get("tick")
                or event.get("event_tick")
                or event.get("death_tick")
                or event.get("demo_tick")
            )
            if tick is not None:
                return tick

    return None


def _has_event_anchor_ticks(clip: dict) -> bool:
    return bool(_extract_kill_ticks_for_segment(clip)) or _extract_death_tick_for_segment(clip) is not None


def _is_timeline_event_clip(clip: dict) -> bool:
    """时间线相关片段（含整回合时间线）；用于 burn 等宽判。"""
    value_candidates = [
        clip.get("timeline_source"),
        clip.get("source"),
        clip.get("clip_type"),
        clip.get("type"),
        clip.get("category"),
    ]
    joined = " ".join(str(v or "").lower() for v in value_candidates)
    return "timeline" in joined or "round_timeline" in joined


def _is_round_timeline_event_clip(clip: dict) -> bool:
    """时间轴上单事件入队（非整回合固定窗）；前后预留 / trim 等按此收紧。"""
    return str(clip.get("timeline_source") or "").strip() == "round_timeline_event"


def _build_pov_pairs_for_clip(
    clip: dict,
    *,
    want_victim_pov: bool,
    want_killer_pov: bool,
    spectator_name: Optional[str],
) -> list[dict[str, Any]]:
    """从 clip 生成 POV 锚点；next_kill_tick 仅用于 POV 段 clamp，不影响主段 segment。"""
    pairs: list[dict[str, Any]] = []

    kill_ticks = _extract_kill_ticks_for_segment(clip)
    victims = clip.get("victims") or []
    if not isinstance(victims, list):
        victims = []

    if want_victim_pov and kill_ticks and victims and str(clip.get("category") or "").strip() != "fail":
        for index, victim_name in enumerate(victims):
            vn = str(victim_name or "").strip()
            if not vn:
                continue
            tick_index = min(index, len(kill_ticks) - 1)
            event_tick = int(kill_ticks[tick_index])
            next_kill_tick: Optional[int] = None
            if tick_index + 1 < len(kill_ticks):
                next_kill_tick = int(kill_ticks[tick_index + 1])
            pairs.append(
                {
                    "player_name": vn,
                    "tick": event_tick,
                    "kind": "victim",
                    "next_kill_tick": next_kill_tick,
                }
            )

    death_tick = _extract_death_tick_for_segment(clip)
    killer_name = str(clip.get("killer_name") or "").strip()

    if (
        want_killer_pov
        and death_tick is not None
        and killer_name
        and str(clip.get("category") or "").strip() == "fail"
    ):
        pairs.append(
            {
                "player_name": killer_name,
                "tick": int(death_tick),
                "kind": "killer",
                "next_kill_tick": None,
            }
        )

    if want_killer_pov and kill_ticks and str(clip.get("category") or "").strip() != "fail":
        killer_list = clip.get("killers") or []
        if not killer_list:
            _fb = (
                str(clip.get("_spec_name") or "").strip()
                or str(clip.get("target_player") or "").strip()
                or str(spectator_name or "").strip()
            )
            killer_list = [_fb] * len(kill_ticks) if _fb else []
        for _kn, _kt in zip(killer_list, kill_ticks):
            kn = str(_kn or "").strip()
            if not kn:
                continue
            pairs.append(
                {
                    "player_name": kn,
                    "tick": int(_kt),
                    "kind": "killer",
                    "next_kill_tick": None,
                }
            )

    return pairs


def _cluster_ticks_by_gap(ticks: list[int], max_gap_ticks: int) -> list[list[int]]:
    gap = max(0, int(max_gap_ticks))
    clean_ticks = sorted({int(t) for t in ticks if _as_int_tick(t) is not None})
    if not clean_ticks:
        return []

    clusters: list[list[int]] = []
    for tick in clean_ticks:
        if not clusters:
            clusters.append([tick])
            continue
        if tick - clusters[-1][-1] <= gap:
            clusters[-1].append(tick)
        else:
            clusters.append([tick])

    return clusters


def _build_event_anchor_segments(
    *,
    clip: dict,
    pre_ticks: int,
    post_ticks: int,
    max_gap_ticks: int,
    clip_min_start_tick: int,
    clip_max_end_tick: int,
    kill_ticks_override: Optional[list[int]] = None,
) -> list[tuple[int, int]]:
    """用户显式 pacing 下：多杀先按 max_gap 聚类，再逐簇套 pre/post；死亡单段。"""
    if kill_ticks_override:
        kill_ticks = sorted({int(t) for t in kill_ticks_override if _as_int_tick(t) is not None})
    else:
        kill_ticks = _extract_kill_ticks_for_segment(clip)

    out: list[tuple[int, int]] = []

    if kill_ticks:
        clusters = _cluster_ticks_by_gap(kill_ticks, max_gap_ticks)
        for ci, cluster in enumerate(clusters):
            start_tick = max(0, int(cluster[0]) - int(pre_ticks))
            if ci == 0 and clip_min_start_tick > 0:
                start_tick = max(start_tick, int(clip_min_start_tick))
            end_tick = int(cluster[-1]) + int(post_ticks)
            if clip_max_end_tick > 0:
                end_tick = min(end_tick, int(clip_max_end_tick))
            if end_tick > start_tick:
                out.append((start_tick, end_tick))
        return out

    death_tick = _extract_death_tick_for_segment(clip)
    if death_tick is None:
        return []

    start_tick = max(0, int(death_tick) - int(pre_ticks))
    if clip_min_start_tick > 0:
        start_tick = max(start_tick, int(clip_min_start_tick))
    end_tick = int(death_tick) + int(post_ticks)
    if clip_max_end_tick > 0:
        end_tick = min(end_tick, int(clip_max_end_tick))
    if end_tick > start_tick:
        out.append((start_tick, end_tick))
    return out


def _log_segment_pacing_debug_clusters(
    clip: dict,
    segments: list[tuple[int, int]],
    tick_rate: int,
    *,
    pre_sec: float,
    post_sec: float,
    max_gap_ticks: int,
) -> None:
    kill_ticks = _extract_kill_ticks_for_segment(clip)
    death_tick = _extract_death_tick_for_segment(clip)
    clip_id = clip.get("clip_id") or clip.get("id")

    if kill_ticks:
        clusters = _cluster_ticks_by_gap(kill_ticks, max_gap_ticks)
        if clusters and len(clusters) == len(segments):
            for index, cluster in enumerate(clusters):
                seg_start, seg_end = segments[index]
                actual_pre = (cluster[0] - seg_start) / float(tick_rate)
                actual_post = (seg_end - cluster[-1]) / float(tick_rate)
                logger.info(
                    "[segment-debug-pacing] clip_id=%s segment=%s expected_pre=%s expected_post=%s "
                    "actual_pre=%.3f actual_post=%.3f cluster=%s segment_ticks=%s",
                    clip_id,
                    index,
                    pre_sec,
                    post_sec,
                    actual_pre,
                    actual_post,
                    cluster,
                    (seg_start, seg_end),
                )
            return

    if death_tick is not None and segments:
        seg_start, seg_end = segments[0]
        actual_pre = (int(death_tick) - seg_start) / float(tick_rate)
        actual_post = (seg_end - int(death_tick)) / float(tick_rate)
        logger.info(
            "[segment-debug-pacing] clip_id=%s death expected_pre=%s expected_post=%s "
            "actual_pre=%.3f actual_post=%.3f death_tick=%s segment_ticks=%s",
            clip_id,
            pre_sec,
            post_sec,
            actual_pre,
            actual_post,
            death_tick,
            (seg_start, seg_end),
        )


def _log_smart_jump_segment_debug(
    clip: dict,
    segments: list[tuple[int, int]],
    override: dict,
    *,
    pre_sec: float,
    post_sec: float,
    max_gap_sec: float,
    tick_rate: int,
    has_user_pacing: bool,
    max_gap_ticks: int,
) -> None:
    kill_ticks = _extract_kill_ticks_for_segment(clip)
    death_tick = _extract_death_tick_for_segment(clip)
    clip_id = clip.get("clip_id") or clip.get("id")
    logger.info(
        "[segment-debug] clip_id=%s category=%s type=%s timeline_source=%s "
        "has_user_pacing=%s pre_sec=%s post_sec=%s max_gap_sec=%s "
        "kill_ticks=%s death_tick=%s clip_start=%s clip_end=%s "
        "source_ticks=%s final_segments=%s",
        clip_id,
        clip.get("category"),
        clip.get("type") or clip.get("clip_type"),
        clip.get("timeline_source"),
        has_user_pacing,
        pre_sec,
        post_sec,
        max_gap_sec,
        kill_ticks,
        death_tick,
        clip.get("start_tick"),
        clip.get("end_tick"),
        clip.get("source_ticks"),
        segments,
    )
    if segments:
        _log_segment_pacing_debug_clusters(
            clip,
            segments,
            tick_rate,
            pre_sec=pre_sec,
            post_sec=post_sec,
            max_gap_ticks=max_gap_ticks,
        )


def _pacing_pre_first_sec_effective(clip: dict) -> float:
    """与 ``build_smart_jump_segments`` 内 ``pre_first_sec`` 解析一致（秒）。

    须基于 ``clip.pacing_override`` 原文：录制流程里若对 pacing 做「固定分段」类清空，
    会与解析分段用的击杀前预留脱节，导致关键帧补偿用错目标、片头偏短。"""
    raw = clip.get("pacing_override")
    if isinstance(raw, dict):
        v = raw.get("pre_first_sec")
        if v is not None and str(v).strip():
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                pass
    ticks = _env_int("CS2_INSIGHT_SMART_PRE_FIRST_TICKS", int(float(DEMO_TICK_RATE) * 2))
    return max(0.0, float(ticks)) / float(DEMO_TICK_RATE)


def _pacing_post_last_sec_effective(clip: dict) -> float:
    """与 ``build_smart_jump_segments`` 内 ``post_last_sec`` 解析一致（秒）。"""
    raw = clip.get("pacing_override")
    if isinstance(raw, dict):
        v = raw.get("post_last_sec")
        if v is not None and str(v).strip():
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                pass
    ticks = _env_int("CS2_INSIGHT_SMART_POST_LAST_TICKS", int(float(DEMO_TICK_RATE) * 1))
    return max(0.0, float(ticks)) / float(DEMO_TICK_RATE)


def _extract_kill_tick_and_round(item: Any) -> tuple[Optional[int], Any]:
    """从多种 kill 条目结构中解析 (tick, round)；tick 无效时返回 (None, None)。"""
    try:
        if isinstance(item, dict):
            tick = (
                item.get("kill_tick")
                or item.get("tick")
                or item.get("event_tick")
                or item.get("demo_tick")
            )
            round_no = (
                item.get("round_number")
                or item.get("round")
                or item.get("round_num")
            )
            if tick is None:
                return None, None
            return int(tick), round_no

        if isinstance(item, (list, tuple)):
            if not item:
                return None, None
            tick = int(item[0])
            round_no = item[1] if len(item) > 1 else None
            return tick, round_no

        return int(item), None
    except (TypeError, ValueError):
        return None, None


def _build_all_kills_windows(
    kill_items: list[Any],
    pre_first_sec: float,
    post_last_sec: float,
    demo_tick_rate: int,
    merge_gap_ticks: Optional[int] = None,
    max_gap_ticks: Optional[int] = None,
) -> list[tuple[int, int]]:
    """all_kills：每杀 [kill-pre, kill+post]；合并条件（同回合）：

    1) 窗口重叠或间隔 ≤ merge_gap_ticks（防抖）；
    2) 或相邻击杀 tick 差 ≤ max_gap_ticks（尊重 pacing 的 max_gap_sec / 智能跳剪阈值）。
    """
    pre_ticks = max(0, int(float(pre_first_sec or 0) * demo_tick_rate))
    post_ticks = max(0, int(float(post_last_sec or 0) * demo_tick_rate))

    if merge_gap_ticks is None:
        try:
            merge_gap_sec = float(os.getenv("CS2_INSIGHT_ALL_KILLS_WINDOW_MERGE_GAP_SEC", "0.15"))
        except (TypeError, ValueError):
            merge_gap_sec = 0.15
        merge_gap_ticks = max(0, int(merge_gap_sec * demo_tick_rate))

    windows: list[dict[str, Any]] = []

    for item in kill_items or []:
        kill_tick, round_no = _extract_kill_tick_and_round(item)
        if kill_tick is None:
            continue

        start_tick = max(0, kill_tick - pre_ticks)
        end_tick = max(start_tick + 1, kill_tick + post_ticks)

        windows.append(
            {
                "round_number": round_no,
                "kill_tick": kill_tick,
                "start_tick": start_tick,
                "end_tick": end_tick,
            }
        )

    def _sort_key(w: dict[str, Any]) -> tuple[int, int]:
        rn = w.get("round_number")
        try:
            rn_key = int(rn) if rn is not None else -1
        except (TypeError, ValueError):
            rn_key = -1
        return (rn_key, int(w["kill_tick"]))

    windows.sort(key=_sort_key)

    merged: list[dict[str, Any]] = []

    for w in windows:
        if not merged:
            w.setdefault("last_kill_tick", int(w["kill_tick"]))
            merged.append(w)
            continue

        cur = merged[-1]

        cur_round = cur.get("round_number")
        next_round = w.get("round_number")

        if cur_round is not None and next_round is not None:
            same_round = str(cur_round) == str(next_round)
        else:
            same_round = True

        overlap_merge = int(w["start_tick"]) <= int(cur["end_tick"]) + merge_gap_ticks
        gap_merge = False
        if max_gap_ticks is not None and int(max_gap_ticks) > 0:
            try:
                cur_last = int(cur.get("last_kill_tick", cur["kill_tick"]))
                gap_merge = (int(w["kill_tick"]) - cur_last) <= int(max_gap_ticks)
            except (TypeError, ValueError):
                gap_merge = False

        should_merge = same_round and (overlap_merge or gap_merge)

        if should_merge:
            cur["end_tick"] = max(int(cur["end_tick"]), int(w["end_tick"]))
            cur["last_kill_tick"] = int(w["kill_tick"])
        else:
            w.setdefault("last_kill_tick", int(w["kill_tick"]))
            merged.append(w)

    out: list[tuple[int, int]] = []
    for w in merged:
        s, e = int(w["start_tick"]), int(w["end_tick"])
        if e > s:
            out.append((s, e))
    return out


def _is_freeze_to_death_clip(clip: dict) -> bool:
    """回合冻结→死亡合集：录制窗已由 ``source_ticks`` 完整表达，导播应原样分段。"""
    kind = str(
        clip.get("compilation_kind")
        or clip.get("source_kind")
        or clip.get("type")
        or clip.get("clip_type")
        or ""
    ).strip().lower()
    if kind in {"freeze_to_death", "freeze-to-death", "round_freeze_to_death"}:
        return True
    if clip.get("freeze_to_death_round_windows"):
        return True
    return False


def _is_death_compilation(clip: dict) -> bool:
    """死亡合集：主段必须以 death_tick（及同类锚点）为准，不能信任解析器 baked 的 source_ticks 窗。"""
    kind = str(clip.get("compilation_kind") or "").strip().lower()
    category = str(clip.get("category") or "").strip().lower()
    recording_perspective = str(clip.get("recording_perspective") or "").strip().lower()

    if category != "compilation":
        return False

    # freeze_to_death：``build_smart_jump_segments`` 最前即按 ``source_ticks`` 早退，不走死亡点窗重写。
    death_like_kinds = {
        "all_deaths",
        "deaths",
        "death_compilation",
        "player_deaths",
        "victim_deaths",
        "nemesis_deaths",
    }

    if kind in death_like_kinds:
        return True

    if clip.get("death_tick") is not None and not _clip_kill_ticks_in_order(clip):
        return True

    if recording_perspective in {"victim", "victim_pov", "death", "death_pov"} and clip.get("death_tick") is not None:
        return True

    return False


def _build_death_compilation_windows(
    clip: dict,
    source_records: list[tuple[int, int, int, int]],
    *,
    pre_ticks: int,
    post_ticks: int,
    clip_min_start_tick: int,
    clip_max_tick: int,
) -> list[tuple[int, int]]:
    """以死亡 tick 为锚生成主段；同回合仅允许极小间隙合并，不按 max_gap 合并。"""
    kill_order = _clip_kill_ticks_in_order(clip)
    events: list[tuple[int, int]] = []

    if kill_order and len(kill_order) == len(source_records):
        for kt, (_ss, _ee, _kt2, rn) in zip(kill_order, source_records):
            try:
                t = int(kt)
            except (TypeError, ValueError):
                continue
            if t < 0:
                continue
            try:
                rni = int(rn)
            except (TypeError, ValueError):
                rni = 0
            events.append((t, rni))
    else:
        raw_death_ticks = clip.get("death_ticks")
        source_rounds = clip.get("source_rounds") or []
        if isinstance(raw_death_ticks, list):
            for i, x in enumerate(raw_death_ticks):
                try:
                    t = int(x)
                except (TypeError, ValueError):
                    continue
                if t < 0:
                    continue
                try:
                    rni = int(source_rounds[i]) if i < len(source_rounds) else 0
                except (TypeError, ValueError):
                    rni = 0
                events.append((t, rni))

        dt = _clip_death_tick(clip)
        if dt is not None and not events:
            rn_guess = 0
            for ss, ee, kt, rn in source_records:
                try:
                    iss, iee, ikt, irn = int(ss), int(ee), int(kt), int(rn)
                except (TypeError, ValueError):
                    continue
                if ikt == int(dt) or (iss <= int(dt) <= iee):
                    rn_guess = irn
                    break
            events.append((int(dt), rn_guess))

        if not events:
            for ss, ee, kt, rn in source_records:
                try:
                    iss, t, rni = int(ss), int(kt), int(rn)
                except (TypeError, ValueError):
                    continue
                if t < 0 or t == iss:
                    continue
                events.append((t, rni))

    by_tick: dict[int, int] = {}
    for t, rn in events:
        if t not in by_tick:
            by_tick[t] = rn
    if not by_tick:
        return []

    ordered = sorted(by_tick.items(), key=lambda it: (it[1], it[0]))

    merge_gap_ticks = _env_int(
        "CS2_INSIGHT_DEATH_WINDOW_MERGE_GAP_TICKS",
        int(float(DEMO_TICK_RATE) * 0.15),
    )

    windows: list[tuple[int, int, int]] = []
    for t, rn in ordered:
        s = max(0, t - pre_ticks)
        if clip_min_start_tick > 0:
            s = max(s, clip_min_start_tick)

        e = t + post_ticks
        if clip_max_tick > 0:
            e = min(e, clip_max_tick)

        if e <= s:
            e = s + 1

        windows.append((s, e, rn))

    merged: list[tuple[int, int, int]] = []
    for s, e, rn in windows:
        if not merged:
            merged.append((s, e, rn))
            continue

        ps, pe, prn = merged[-1]
        if rn == prn and s <= pe + merge_gap_ticks:
            merged[-1] = (ps, max(pe, e), prn)
        else:
            merged.append((s, e, rn))

    return [(s, e) for s, e, rn in merged]


def build_smart_jump_segments(clip: dict) -> list[tuple[int, int]]:
    """智能跳剪 / 单段墙钟所依据的 ``[(seg_start, seg_end), ...]``。

    **入口统一在本函数**，但按 clip 形态分 **三套算法**（先匹配者先返回），与「是否都叫 pacing_override」无关：

    1. **合集 + ``source_ticks``**（``category == compilation`` 且 ``source_ticks`` 非空）
       - **``freeze_to_death``** 且 ``fixed_segment_pacing``：仅信任 ``source_ticks`` 硬窗，
         不因 ``kill_ticks`` / ``death_tick`` / pacing 重算（见 ``_is_freeze_to_death_clip`` 早退）。
       - **死亡类合集**（``_is_death_compilation``）：``_build_death_compilation_windows``，
         按死亡点 + 回合合并窗；pre/post 读 ``pacing_override`` / ``CS2_INSIGHT_SMART_*``。
       - **``compilation_kind == all_kills``**：``_build_all_kills_windows``，
         每杀 ``[kill−pre, kill+post]`` 再按重叠与 ``max_gap`` 合并；**不是**高光那种「锚点 tick 聚类」。
       - **其它合集**：直接用 ``source_ticks`` 的 ``(ss, ee)``，不在此函数里按 pre/post 重算窗。

    2. **无 ``kill_ticks``**（纯死亡锚点、时间线死亡等）：单段 ``death_tick ± pre/post``，
       其中 ``round_timeline_event`` 且未写 ``post_last_sec`` 时死后留白默认走
       ``CS2_INSIGHT_TIMELINE_DEATH_POST_TICKS``（默认 2s）。

    3. **高光 / 时间线击杀 / 多杀非合集**（默认）：``kill_ticks`` 按 ``MAX_GAP`` 聚类，
       每簇 ``首杀−PRE_FIRST`` … ``末杀+POST_LAST``，并可能按 ``clip.start/end_tick`` 扩窗。

    若 ``pacing_override`` 显式包含 ``pre_first_sec`` / ``post_last_sec``，且存在击杀或死亡锚点 tick，
    则先按 ``max_gap_sec`` 对击杀 tick 聚类，再对每簇 ``首杀−PRE_FIRST`` … ``末杀+POST_LAST`` 生成 segment；
    死亡仍为单段。``round_timeline_event`` 且用户 pacing 时不再叠加 ``clip_min_guard`` 以免吃掉前预留。
    不再用 ``clip.start_tick/end_tick`` 或 ``source_ticks`` 的解析器默认 buffer 回扩。

    整回合 ``round_timeline_round`` 主段通常 ``fixed_segment_pacing``，不依赖本函数分段。
    """
    start_tick = max(0, int(clip.get("start_tick") or 0))
    end_tick = max(start_tick, int(clip.get("end_tick") or 0))

    override = clip.get("pacing_override") or {}
    if not isinstance(override, dict):
        override = {}
    has_user_pacing = "pre_first_sec" in override or "post_last_sec" in override

    def _get_override_ticks(key: str, default_env_key: str, default_sec: float) -> int:
        val = override.get(key)
        if val is not None and str(val).strip():
            return max(0, int(float(val) * DEMO_TICK_RATE))
        return _env_int(default_env_key, int(DEMO_TICK_RATE * default_sec))

    PRE_FIRST = _get_override_ticks("pre_first_sec", "CS2_INSIGHT_SMART_PRE_FIRST_TICKS", 2.0)
    POST_LAST = _get_override_ticks("post_last_sec", "CS2_INSIGHT_SMART_POST_LAST_TICKS", 1.0)
    MAX_GAP = max(1, _get_override_ticks("max_gap_sec", "CS2_INSIGHT_SMART_MAX_GAP_TICKS", 12.0))

    clip_min_tick = max(0, int(clip.get("clip_min_tick") or 0))
    clip_min_guard_ticks = _get_override_ticks(
        "clip_min_guard_sec",
        "CS2_INSIGHT_SMART_CLIP_MIN_GUARD_TICKS",
        0.35,
    )
    clip_min_start_tick = clip_min_tick + clip_min_guard_ticks if clip_min_tick > 0 else 0
    _cmt_raw = clip.get("clip_max_tick")
    clip_max_tick = int(_cmt_raw) if _cmt_raw else 0

    pre_first_sec_eff = PRE_FIRST / float(DEMO_TICK_RATE)
    post_last_sec_eff = POST_LAST / float(DEMO_TICK_RATE)
    max_gap_sec_eff = MAX_GAP / float(DEMO_TICK_RATE)
    _max_gap_ticks_i = max(1, int(MAX_GAP))

    raw_source_ticks = clip.get("source_ticks") or []
    if str(clip.get("category") or "").strip() == "compilation" and raw_source_ticks:
        if _is_freeze_to_death_clip(clip) and bool(clip.get("fixed_segment_pacing")):
            ftd_segments: list[tuple[int, int]] = []
            for item in raw_source_ticks:
                try:
                    ss = int(item[0])
                    ee = int(item[1])
                except (TypeError, ValueError, IndexError):
                    continue
                ss = max(0, ss)
                if ee <= ss:
                    continue
                ftd_segments.append((ss, ee))
            ftd_segments.sort(key=lambda seg: seg[0])
            if ftd_segments:
                fixed_ftd: list[tuple[int, int]] = []
                for i, (ss, ee) in enumerate(ftd_segments):
                    s_i = max(0, int(ss))
                    e_i = int(ee)
                    if i + 1 < len(ftd_segments):
                        next_s = int(ftd_segments[i + 1][0])
                        e_i = min(e_i, max(s_i + 1, next_s - 1))
                    if e_i > s_i:
                        fixed_ftd.append((s_i, e_i))
                ftd_segments = fixed_ftd
                if ftd_segments:
                    _cid = clip.get("clip_id") or clip.get("id")
                    logger.info(
                        "[freeze-to-death-segments] clip_id=%s source_rounds=%s source_round_ends=%s "
                        "source_ticks=%s final_segments=%s kill_ticks=%s death_tick=%s",
                        _cid,
                        clip.get("source_rounds"),
                        clip.get("source_round_ends"),
                        raw_source_ticks,
                        ftd_segments,
                        clip.get("kill_ticks"),
                        clip.get("death_tick"),
                    )
                    _log_smart_jump_segment_debug(
                        clip,
                        ftd_segments,
                        override,
                        pre_sec=float(pre_first_sec_eff),
                        post_sec=float(post_last_sec_eff),
                        max_gap_sec=float(max_gap_sec_eff),
                        tick_rate=DEMO_TICK_RATE,
                        has_user_pacing=has_user_pacing,
                        max_gap_ticks=_max_gap_ticks_i,
                    )
                    return ftd_segments

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
        if _is_death_compilation(clip) and source_records:
            source_override = clip.get("pacing_override") or {}
            if not isinstance(source_override, dict):
                source_override = {}

            def _death_comp_ov_ticks(key: str, default_env_key: str, default_sec: float) -> int:
                raw = source_override.get(key)
                if raw is not None and str(raw).strip():
                    try:
                        return max(0, int(float(raw) * DEMO_TICK_RATE))
                    except (TypeError, ValueError):
                        pass
                return _env_int(default_env_key, int(float(DEMO_TICK_RATE) * float(default_sec)))

            pre_ticks = _death_comp_ov_ticks(
                "pre_first_sec",
                "CS2_INSIGHT_SMART_PRE_FIRST_TICKS",
                2.0,
            )
            post_ticks = _death_comp_ov_ticks(
                "post_last_sec",
                "CS2_INSIGHT_SMART_POST_LAST_TICKS",
                1.0,
            )

            _comp_min_tick = max(0, int(clip.get("clip_min_tick") or 0))
            _comp_min_start = (
                _comp_min_tick + max(0, int(0.35 * DEMO_TICK_RATE)) if _comp_min_tick > 0 else 0
            )
            _comp_max_tick_raw = clip.get("clip_max_tick")
            _comp_max_tick = int(_comp_max_tick_raw) if _comp_max_tick_raw else 0

            death_segments = _build_death_compilation_windows(
                clip,
                source_records,
                pre_ticks=pre_ticks,
                post_ticks=post_ticks,
                clip_min_start_tick=_comp_min_start,
                clip_max_tick=_comp_max_tick,
            )

            if death_segments:
                logger.info(
                    "[build_segments] death_compilation_window clip_id=%s death_tick=%s override=%s segments=%s",
                    clip.get("clip_id"),
                    clip.get("death_tick"),
                    source_override,
                    death_segments,
                )
                _log_smart_jump_segment_debug(
                    clip,
                    death_segments,
                    source_override,
                    pre_sec=pre_ticks / float(DEMO_TICK_RATE),
                    post_sec=post_ticks / float(DEMO_TICK_RATE),
                    max_gap_sec=max_gap_sec_eff,
                    tick_rate=DEMO_TICK_RATE,
                    has_user_pacing=has_user_pacing,
                    max_gap_ticks=_max_gap_ticks_i,
                )
                return death_segments

        if str(clip.get("compilation_kind") or "") == "all_kills" and source_records:
            source_override = clip.get("pacing_override") or {}
            if not isinstance(source_override, dict):
                source_override = {}
            # clip_min_start_tick / clip_max_tick：与下方通用路径一致，compilation 早退前需本地计算
            _comp_min_tick = max(0, int(clip.get("clip_min_tick") or 0))
            _comp_min_start = (
                _comp_min_tick + max(0, int(0.35 * DEMO_TICK_RATE)) if _comp_min_tick > 0 else 0
            )
            _comp_max_tick_raw = clip.get("clip_max_tick")
            _comp_max_tick = int(_comp_max_tick_raw) if _comp_max_tick_raw else 0

            def _all_kills_ov_ticks(key: str, default_env_key: str, default_sec: float) -> int:
                val = source_override.get(key)
                if val is not None and str(val).strip():
                    try:
                        return max(0, int(float(val) * DEMO_TICK_RATE))
                    except (TypeError, ValueError):
                        pass
                return _env_int(default_env_key, int(DEMO_TICK_RATE * default_sec))

            pre_first_ticks = _all_kills_ov_ticks(
                "pre_first_sec", "CS2_INSIGHT_SMART_PRE_FIRST_TICKS", 2.0
            )
            post_last_ticks = _all_kills_ov_ticks(
                "post_last_sec", "CS2_INSIGHT_SMART_POST_LAST_TICKS", 1.0
            )
            pre_first_sec = pre_first_ticks / float(DEMO_TICK_RATE)
            post_last_sec = post_last_ticks / float(DEMO_TICK_RATE)

            try:
                merge_gap_sec = float(os.getenv("CS2_INSIGHT_ALL_KILLS_WINDOW_MERGE_GAP_SEC", "0.15"))
            except (TypeError, ValueError):
                merge_gap_sec = 0.15
            merge_gap_ticks = max(0, int(merge_gap_sec * DEMO_TICK_RATE))

            raw_gap = source_override.get("max_gap_sec") if isinstance(source_override, dict) else None
            if raw_gap is not None and str(raw_gap).strip():
                try:
                    all_kills_max_gap_ticks = max(0, int(float(raw_gap) * DEMO_TICK_RATE))
                except (TypeError, ValueError):
                    all_kills_max_gap_ticks = _env_int(
                        "CS2_INSIGHT_SMART_MAX_GAP_TICKS", int(float(DEMO_TICK_RATE) * 12.0)
                    )
            else:
                all_kills_max_gap_ticks = _env_int(
                    "CS2_INSIGHT_SMART_MAX_GAP_TICKS", int(float(DEMO_TICK_RATE) * 12.0)
                )

            # 与 source_ticks 索引对齐的击杀 + 回合（source_rounds）；优于仅 clip.kill_ticks 整数列表
            kill_items = [(int(kt), int(rn)) for _ss, _ee, kt, rn in source_records]

            clip_id = clip.get("clip_id") or clip.get("id")

            logger.info(
                "[all_kills_windows] input clip_id=%s kills=%s pre=%.3fs post=%.3fs merge_gap_ticks=%s max_gap_ticks=%s",
                clip_id,
                len(kill_items or []),
                float(pre_first_sec or 0),
                float(post_last_sec or 0),
                merge_gap_ticks,
                all_kills_max_gap_ticks,
            )

            raw_segments = _build_all_kills_windows(
                kill_items,
                pre_first_sec,
                post_last_sec,
                DEMO_TICK_RATE,
                merge_gap_ticks=merge_gap_ticks,
                max_gap_ticks=all_kills_max_gap_ticks,
            )

            for seg_s, seg_e in raw_segments:
                s = max(0, int(seg_s))
                if _comp_min_start > 0:
                    s = max(s, _comp_min_start)
                e = max(s + 1, int(seg_e))
                if _comp_max_tick > 0:
                    e = min(e, _comp_max_tick)
                if e > s:
                    source_segments.append((s, e))

            logger.info(
                "[all_kills_windows] output clip_id=%s segments=%s",
                clip_id,
                source_segments[:20],
            )
            logger.info(
                "[build_segments] all_kills kill-window segments clip_id=%s pre=%.3fs post=%.3fs count=%s segments=%s",
                clip_id,
                float(pre_first_sec or 0),
                float(post_last_sec or 0),
                len(source_segments),
                source_segments[:20],
            )
            if source_segments:
                _log_smart_jump_segment_debug(
                    clip,
                    source_segments,
                    source_override,
                    pre_sec=float(pre_first_sec or 0),
                    post_sec=float(post_last_sec or 0),
                    max_gap_sec=all_kills_max_gap_ticks / float(DEMO_TICK_RATE),
                    tick_rate=DEMO_TICK_RATE,
                    has_user_pacing=has_user_pacing,
                    max_gap_ticks=max(1, int(all_kills_max_gap_ticks)),
                )
                logger.info(
                    "[build_segments] compilation source_ticks clip_id=%s segments=%s",
                    clip.get("clip_id"),
                    source_segments,
                )
                return source_segments
        else:
            if has_user_pacing and _has_event_anchor_ticks(clip):
                source_segments = []
            else:
                source_segments = [(ss, ee) for ss, ee, _kt, _rn in source_records]
        if source_segments:
            logger.info(
                "[build_segments] compilation source_ticks clip_id=%s segments=%s",
                clip.get("clip_id"),
                source_segments,
            )
            _log_smart_jump_segment_debug(
                clip,
                source_segments,
                override,
                pre_sec=pre_first_sec_eff,
                post_sec=post_last_sec_eff,
                max_gap_sec=max_gap_sec_eff,
                tick_rate=DEMO_TICK_RATE,
                has_user_pacing=has_user_pacing,
                max_gap_ticks=_max_gap_ticks_i,
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

    logger.info(
        "[build_segments] clip_id=%s round=%s clip_max_tick=%s kills=%s override=%s",
        clip.get("clip_id"),
        clip.get("round"),
        clip_max_tick,
        kills,
        override,
    )

    clip_min_start_for_user_anchor = (
        clip_min_tick if (has_user_pacing and _is_round_timeline_event_clip(clip)) else clip_min_start_tick
    )

    if has_user_pacing:
        post_for_anchor = POST_LAST
        if (
            not kills
            and str(clip.get("timeline_source") or "").strip() == "round_timeline_event"
            and "post_last_sec" not in override
        ):
            post_for_anchor = _env_int(
                "CS2_INSIGHT_TIMELINE_DEATH_POST_TICKS",
                int(DEMO_TICK_RATE * 2.0),
            )
        post_sec_for_log = post_for_anchor / float(DEMO_TICK_RATE)
        merged_anchor = _build_event_anchor_segments(
            clip=clip,
            pre_ticks=PRE_FIRST,
            post_ticks=post_for_anchor,
            max_gap_ticks=_max_gap_ticks_i,
            clip_min_start_tick=clip_min_start_for_user_anchor,
            clip_max_end_tick=clip_max_tick,
            kill_ticks_override=kills if kills else None,
        )
        if merged_anchor:
            _log_smart_jump_segment_debug(
                clip,
                merged_anchor,
                override,
                pre_sec=pre_first_sec_eff,
                post_sec=post_sec_for_log,
                max_gap_sec=max_gap_sec_eff,
                tick_rate=DEMO_TICK_RATE,
                has_user_pacing=True,
                max_gap_ticks=_max_gap_ticks_i,
            )
            logger.info(
                "[build_segments] final_segments clip_id=%s segments=%s",
                clip.get("clip_id"),
                merged_anchor,
            )
            return merged_anchor

    if not kills:
        has_single_segment_override = isinstance(override, dict) and any(
            k in override for k in ("pre_first_sec", "post_last_sec")
        )
        # 纯死亡锚点（含回合时间线 death 事件）：必须压在 death_tick 附近结束。
        # 若沿用片段整体 end_tick（建议窗 often 为死亡 +4s），CS2 死亡视角约 2s 后会把观战切到
        # 他人，后半段录到的已不是目标画面。
        clip_min_floor = (
            clip_min_tick
            if (has_single_segment_override and _is_round_timeline_event_clip(clip))
            else clip_min_start_tick
        )
        dt_only = _clip_death_tick(clip)
        if dt_only is not None:
            anchor_tick = int(dt_only)
            seg_start = max(0, anchor_tick - PRE_FIRST)
            if clip_min_floor > 0:
                seg_start = max(seg_start, clip_min_floor)
            val_po = override.get("post_last_sec")
            if val_po is not None and str(val_po).strip():
                post_ticks = max(0, int(float(val_po) * DEMO_TICK_RATE))
            else:
                # round_timeline_event 死亡：与高光同源走本函数，但未显式 post_last 时死后留白默认 2s
                # （CS2_INSIGHT_TIMELINE_DEATH_POST_TICKS，观战易在 ~2s 内切走）；其它纯死亡锚点用 POST_LAST。
                if str(clip.get("timeline_source") or "").strip() == "round_timeline_event":
                    post_ticks = _env_int(
                        "CS2_INSIGHT_TIMELINE_DEATH_POST_TICKS",
                        int(DEMO_TICK_RATE * 2.0),
                    )
                else:
                    post_ticks = POST_LAST
            seg_end = anchor_tick + post_ticks
            if clip_max_tick > 0:
                seg_end = min(seg_end, clip_max_tick)
            if seg_end <= seg_start:
                seg_end = seg_start + 1
            segment = (seg_start, seg_end)
            logger.info(
                "[build_segments] death_only_anchor clip_id=%s anchor=%s segment=%s",
                clip.get("clip_id"),
                anchor_tick,
                segment,
            )
            _log_smart_jump_segment_debug(
                clip,
                [segment],
                override,
                pre_sec=pre_first_sec_eff,
                post_sec=post_ticks / float(DEMO_TICK_RATE),
                max_gap_sec=max_gap_sec_eff,
                tick_rate=DEMO_TICK_RATE,
                has_user_pacing=has_user_pacing,
                max_gap_ticks=_max_gap_ticks_i,
            )
            return [segment]

        if not has_single_segment_override:
            out = [(start_tick, end_tick)]
            _log_smart_jump_segment_debug(
                clip,
                out,
                override,
                pre_sec=pre_first_sec_eff,
                post_sec=post_last_sec_eff,
                max_gap_sec=max_gap_sec_eff,
                tick_rate=DEMO_TICK_RATE,
                has_user_pacing=has_user_pacing,
                max_gap_ticks=_max_gap_ticks_i,
            )
            return out

        anchor_tick = None
        if _death_tick_raw is not None and str(_death_tick_raw).strip():
            try:
                anchor_tick = int(_death_tick_raw)
            except Exception:
                anchor_tick = None
        if anchor_tick is None:
            anchor_tick = min(end_tick, start_tick + PRE_ROLL_TICKS)

        seg_start = max(0, anchor_tick - PRE_FIRST)
        if clip_min_floor > 0:
            seg_start = max(seg_start, clip_min_floor)
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
        _log_smart_jump_segment_debug(
            clip,
            [segment],
            override,
            pre_sec=pre_first_sec_eff,
            post_sec=post_last_sec_eff,
            max_gap_sec=max_gap_sec_eff,
            tick_rate=DEMO_TICK_RATE,
            has_user_pacing=has_user_pacing,
            max_gap_ticks=_max_gap_ticks_i,
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

    segments: list[tuple[int, int]] = []
    for ci, cl in enumerate(clusters):
        pre = PRE_FIRST
        raw_start = max(0, cl[0] - pre)
        # 对第一段强制不早于 round_freeze_end_tick 后一点点，避免把回合刚开始的杂帧录进去。
        if ci == 0 and clip_min_start_tick > 0:
            raw_start = max(raw_start, clip_min_start_tick)
        seg_start = raw_start
        seg_end = cl[-1] + POST_LAST
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

    # 扩展最后一段以覆盖 clip.end_tick（极限拆包等：末段需长于「末杀 + post_last」）。
    # 若 end_tick 仅落在解析器为高光写的「末杀 + BUFFER_SECONDS_AFTER」典型窗内，而用户已通过 pacing
    # 把 post_last 缩得比该窗更短，则不得再拉长。注意：典型窗必须与 demo_parser 的 BUFFER_SECONDS_AFTER
    # 一致，且不得复用 CS2_INSIGHT_SMART_POST_LAST_TICKS 环境变量 —— 否则用户把 env 调小后
    # end_tick <= last_kill + env_ticks 恒为假，会误判为「拆包」而再次拉长到 clip.end_tick（约 3s）。
    _parser_default_tail_ticks = int(float(BUFFER_SECONDS_AFTER) * float(DEMO_TICK_RATE))
    _parser_default_head_ticks = int(float(BUFFER_SECONDS_BEFORE) * float(DEMO_TICK_RATE))
    if not has_user_pacing and merged and end_tick > 0:
        ls, le = merged[-1]
        if end_tick > le:
            le_ext = min(end_tick, clip_max_tick) if clip_max_tick > 0 else end_tick
            if le_ext > le:
                last_kill = kills[-1]
                default_parser_tail_end = last_kill + _parser_default_tail_ticks
                user_tightened_post = POST_LAST < _parser_default_tail_ticks
                end_within_typical_parser_tail = end_tick <= default_parser_tail_end
                if not (user_tightened_post and end_within_typical_parser_tail):
                    merged[-1] = (ls, le_ext)

    # 扩展第一段以覆盖 clip.start_tick（极限拆包等：段首需早于「首杀 − pre_first」）。
    # 若 start_tick 仅落在解析器为高光写的「首杀 − BUFFER_SECONDS_BEFORE」典型窗内，而用户已通过 pacing
    # 把 pre_first 缩得比该窗更短，则不得再拉长。否则成片 pre 会变成解析器蜡制窗 + pacing 叠层（观感 ~5s+）。
    if not has_user_pacing and merged and start_tick > 0 and kills:
        fs, fe = merged[0]
        if start_tick < fs:
            fs_ext = max(start_tick, clip_min_start_tick) if clip_min_start_tick > 0 else start_tick
            if fs_ext < fs:
                first_kill = int(kills[0])
                default_parser_head_start = max(0, first_kill - _parser_default_head_ticks)
                user_tightened_pre = PRE_FIRST < _parser_default_head_ticks
                start_within_typical_parser_head = start_tick >= default_parser_head_start
                if not (user_tightened_pre and start_within_typical_parser_head):
                    merged[0] = (fs_ext, fe)

    logger.info("[build_segments] final_segments clip_id=%s segments=%s", clip.get("clip_id"), merged)
    _log_smart_jump_segment_debug(
        clip,
        merged,
        override,
        pre_sec=pre_first_sec_eff,
        post_sec=post_last_sec_eff,
        max_gap_sec=max_gap_sec_eff,
        tick_rate=DEMO_TICK_RATE,
        has_user_pacing=has_user_pacing,
        max_gap_ticks=_max_gap_ticks_i,
    )
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
    # Demo 观战闪光弹亮度；None 表示不注入。POV HUD 录制时由 pov_constants 强制 1.0
    spectator_flashbang_opacity: Optional[float] = None
    # "mute"=全部静音, "open"=所有玩家, "team"=只听主角队伍, "enemy"=只听对方队伍, "off"=不注入
    voice_filter: str = "mute"
    # Demo 底部时间轴 / 回放控制条：社区常用需先 sv_cheats 1 再 demoui false
    hide_demo_playback_ui: bool = True
    # 投掷物抛物线 + 画中窗预览
    hide_grenade_trajectory_pip: bool = True
    # 与 cs2_video.txt / video.cfg 中 setting.aspectratiomode 一致：0=4:3，1=16:9，2=16:10
    aspect_ratio: Optional[Literal["4:3", "16:9", "16:10"]] = None
    # 若前端传入非空列表，则优先使用该顺序注入（须已含各 cvar）；否则由静态方法从布尔字段拼装
    console_cmds: Optional[tuple[str, ...]] = None
    # 实验性 POV：与 pov_tail_commands 对应（仅 pov_enabled 时注入末尾）
    pov_radar_mode: int = 0  # cl_drawhud_force_radar：-1 隐藏，0 显示
    pov_teamcounter_numeric: bool = False  # cl_teamcounter_playercount_instead_of_avatars
    # RecordingV3 queue: enable POV HUD lifecycle (install vpk + patch gameinfo.gi)
    pov_hud_enabled: bool = False


# CS2 视频设置「宽高比」下拉与 setting.aspectratiomode 枚举（社区常用映射）。
_ASPECT_RATIO_VIDEOCFG_MODE: dict[str, int] = {"4:3": 0, "16:9": 1, "16:10": 2}


def _parse_cs2_extra_launch_argv(raw: str) -> tuple[str, ...]:
    """前端按「一条一行」写入；旧配置可为单行整段 shlex。每行单独 shlex 后拼成 argv。"""
    text = raw or ""
    out: list[str] = []
    if "\n" in text or "\r" in text:
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            try:
                parts = shlex.split(s, posix=False)
            except ValueError:
                logger.warning("cs2_extra_launch_args line shlex failed, skip: %r", s[:120])
                continue
            for p in parts:
                t = str(p).strip()
                if t:
                    out.append(t)
                if len(out) >= 48:
                    return tuple(out)
        return tuple(out)
    s = text.strip()
    if not s:
        return ()
    try:
        parts = shlex.split(s, posix=False)
    except ValueError:
        logger.warning("cs2_extra_launch_args shlex parse failed, ignoring: %r", s[:160])
        return ()
    for p in parts:
        t = str(p).strip()
        if t:
            out.append(t)
        if len(out) >= 48:
            break
    return tuple(out)


def _parse_record_inject_console_lines(raw: str) -> tuple[str, ...]:
    lines: list[str] = []
    for line in (raw or "").splitlines():
        s = line.strip()
        if not s or s.startswith("//") or s.startswith("#"):
            continue
        lines.append(s[:800])
        if len(lines) >= 60:
            break
    return tuple(lines)


class OBSDirector:
    """Controls OBS recording and CS2 demo playback for automated clip capture."""

    def __init__(
        self,
        obs_config: OBSConfig,
        cs2_path: str,
        on_state_change: Optional[Callable[[DirectorState, str], None]] = None,
        abort_event: Optional[asyncio.Event] = None,
        *,
        cs2_extra_launch_args: str = "",
        record_inject_console_lines: str = "",
        spec_player_verify: Optional[SpecPlayerVerifyConfig] = None,
    ):
        self.obs_config = obs_config
        self.cs2_path = cs2_path
        self._extra_launch_argv = _parse_cs2_extra_launch_argv(cs2_extra_launch_args)
        self._extra_warmup_console_lines = _parse_record_inject_console_lines(record_inject_console_lines)
        self._spec_player_verify = spec_player_verify or SpecPlayerVerifyConfig()
        self._ws: Optional[obsws] = None
        self._cs2_process: Optional[subprocess.Popen] = None
        self._on_state_change = on_state_change
        self._state = DirectorState.IDLE
        self._copied_demo: Optional[Path] = None
        self._copied_cfg: Optional[Path] = None
        self._copied_gsi_cfg: Optional[Path] = None
        self._spec_calibration_by_demo: dict[str, dict[str, int]] = {}
        self._spec_parse_fallback_offset_by_demo: dict[str, int] = {}
        self._demo_steam_by_name_cache: dict[str, dict[str, str]] = {}
        self._abort_event = abort_event
        # 实验性 POV：在首次片段预热注入末尾追加强制 cvar
        self._pov_enabled = False
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

    @property
    def state(self) -> DirectorState:
        return self._state

    @property
    def obs_ws(self) -> Optional[obsws]:
        """当前 OBS WebSocket 客户端（未连接时为 ``None``）。供 OBS 配置中心等模块复用连接。"""
        return self._ws

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

    def disconnect_obs(self):
        if self._ws:
            try:
                self._ws.disconnect()
            except Exception:
                pass
            self._ws = None

    def test_obs_connection(self, *, handshake_timeout_sec: Optional[float] = None) -> dict:
        """Quick connection test — returns version info or error.

        handshake_timeout_sec:
            传入时对 TCP + WebSocket 握手使用 ``websocket`` 的 ``connect(..., timeout=)``，
            供 ``/api/status/setup`` 等场景避免无 OBS 时阻塞过久。录制与「测试连接」接口不传，沿用库默认。
        """
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
            return {"ok": True}
        except Exception as e:
            logger.warning("OBS WebSocket test failed: %s", e, exc_info=True)
            return {"ok": False, "error": _friendly_obs_websocket_test_error(e)}
        finally:
            self._ws = prev_ws

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

    def _launch_cs2(
        self,
        demo_abs: Path,
        warmup: Optional[RecordingWarmupExtras] = None,
    ) -> None:
        """
        将 Demo 复制到 CS2 的 game/csgo/ 下再以 +playdemo 启动。
        Source 2 对 Temp 等目录的绝对路径 +playdemo 常无效；工作目录需为 game/。
        """
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
        self._clear_voice_ban_files()

        # CS2 读取 video.txt 的优先级高于 -w/-h 启动参数，在快照后立即 patch
        # 磁盘文件，确保录制分辨率真正生效；结束后由 _restore_user_configs 还原。
        if warmup is not None:
            _w, _h = warmup.resolution_width, warmup.resolution_height
            if _w is not None and _h is not None and int(_w) > 0 and int(_h) > 0:
                _arm = warmup.aspect_ratio
                _mode = _ASPECT_RATIO_VIDEOCFG_MODE.get(_arm) if _arm else None
                self._patch_video_configs_for_resolution(int(_w), int(_h), _mode)

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
        console_toggle_key = (os.environ.get("CS2_INSIGHT_CONSOLE_TOGGLE_KEY") or "F10").strip().upper()
        if console_toggle_key in {"~", "OEM_3"}:
            console_toggle_key = "`"
        elif console_toggle_key not in {"`", *{f"F{i}" for i in range(1, 13)}}:
            console_toggle_key = "F10"
        console_bind_lines = [f'bind "{console_toggle_key}" "toggleconsole"']
        if console_toggle_key != "F10":
            console_bind_lines.append('bind "F10" "toggleconsole"')
        cfg_lines = [
            "cl_spec_show_bindings 0",
            "con_enable 1",
            *console_bind_lines,
            "unbind alt",
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
            '  "buffer" "0.0"',
            '  "throttle" "0.1"',
            '  "heartbeat" "1.0"',
            '  "data"',
            "  {",
            '    "provider" "1"',
            '    "map" "1"',
            '    "round" "1"',
            '    "player_id" "1"',
            '    "player_state" "1"',
            '    "player_position" "1"',
            '    "allplayers_id" "1"',
            '    "allplayers_state" "1"',
            '    "allplayers_position" "1"',
            '    "allplayers_team" "1"',
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
        # 默认继承玩家当前的视频模式，不强制切到独占全屏；否则会把原本的
        # 「全屏窗口 / 窗口化」录制会话硬改成 fullscreen，并可能被 CS2 持久化。
        # 若调用方确实想强制独占全屏，可经 cs2_extra_launch_args 显式追加。
        argv: List[str] = [
            str(cs2),
            "-console", "-novid", "-insecure", "-worldwide", "-allow_third_party_software",
        ]

        if warmup is not None:
            w, h = warmup.resolution_width, warmup.resolution_height
            if w is not None and h is not None and int(w) > 0 and int(h) > 0:
                argv.extend(["-w", str(int(w)), "-h", str(int(h))])
                arm = warmup.aspect_ratio
                mode = _ASPECT_RATIO_VIDEOCFG_MODE.get(arm) if arm else None
                if mode is not None:
                    argv.extend(["+setting.aspectratiomode", str(mode)])

        if self._extra_launch_argv:
            argv.extend(self._extra_launch_argv)

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

    async def _spec_player_with_gsi_verify(
        self,
        demo_abs: Path,
        target_steam64: str,
        initial_slot: int,
        mode: int = 5,
        *,
        max_retries: int = 4,
        per_retry_timeout: float = 0.6,
        settle: float = 0.12,
        skip_console_toggle: bool = True,
        close_console: bool = False,
    ) -> Optional[int]:
        """注入 spec_mode+spec_player 并通过 GSI player.steamid 验证是否切准目标玩家。

        若 steamid 不符，slot+1 重试，最多 max_retries 次。
        成功返回已确认的 slot 编号，全部重试耗尽返回 None。
        """
        norm_target = self._norm_steam_id(target_steam64)
        if not norm_target:
            logger.warning(
                "spec_verify: invalid target_steam64=%r, skip verify demo=%s",
                target_steam64,
                demo_abs.name,
            )
            return initial_slot

        known_steams: set[str] = {norm_target}
        slot = int(initial_slot)
        for attempt in range(max_retries):
            self._check_abort()
            before = float((gsi_status() or {}).get("last_payload_at") or 0.0)
            ok = await asyncio.to_thread(
                inject_console_sequence,
                [f"spec_mode {mode}", f"spec_player {slot}"],
                skip_console_toggle=skip_console_toggle,
                close_console=close_console,
            )
            if not ok:
                logger.warning(
                    "spec_verify: inject failed slot=%d attempt=%d/%d demo=%s",
                    slot, attempt + 1, max_retries, demo_abs.name,
                )
                slot += 1
                continue
            if settle > 0:
                await self._sleep_abortable(settle)
            sid = await self._await_gsi_steam_after(before, known_steams, per_retry_timeout)
            if sid:
                logger.info(
                    "spec_verify: confirmed steam=%s slot=%d attempt=%d/%d demo=%s",
                    sid, slot, attempt + 1, max_retries, demo_abs.name,
                )
                return slot
            payload = (gsi_status() or {}).get("last_payload") or {}
            got_sid = self._gsi_current_player_steam_id(payload if isinstance(payload, dict) else {})
            logger.warning(
                "spec_verify: slot=%d target=%s got=%s attempt=%d/%d; retrying slot+1 demo=%s",
                slot, norm_target, got_sid, attempt + 1, max_retries, demo_abs.name,
            )
            slot += 1
        logger.error(
            "spec_verify: all %d retries exhausted for steam=%s initial_slot=%d demo=%s",
            max_retries, norm_target, initial_slot, demo_abs.name,
        )
        return None

    def _pov_goto_delay_extra_sec(self, clip: dict, *, pov_seek_tick: int, clip_max_tick: int) -> float:
        """主段结束后 OBS 暂停期间，POV ``demo_gototick`` 的额外等待（叠在 jump_cut 基础 GOTO 上）。

        过长会整段写入成片为「击杀后定格」。优先读 ``pacing_override.pov_goto_delay_extra_sec``，
        其次 ``spec_player_verify.pov_goto_delay_extra_sec``；均为 None 时按倒退 tick 距离自适应。
        """
        vpo = clip.get("pacing_override")
        if isinstance(vpo, dict) and vpo.get("pov_goto_delay_extra_sec") is not None:
            try:
                return max(0.0, min(20.0, float(vpo["pov_goto_delay_extra_sec"])))
            except (TypeError, ValueError):
                pass
        forced = self._spec_player_verify.pov_goto_delay_extra_sec
        if forced is not None:
            return max(0.0, min(20.0, float(forced)))
        if clip_max_tick <= 0:
            return 1.0
        back_delta = max(0, int(clip_max_tick) - int(pov_seek_tick))
        if back_delta < 2048:
            return 0.35
        if back_delta < 10240:
            return 1.0
        return 2.5

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
        # -worldwide 会把区域选择偏好写入此文件；录制后需还原，否则玩家自己
        # 通过 Steam 启动时永远不再弹选服窗口。
        "localconfig.vdf",
    )
    _USER_CONFIG_GLOB_PATTERNS: tuple[str, ...] = (
        "user_convars_0_slot*.vcfg",
        "cs2_user_convars_0_slot*.vcfg",
        "cs2_user_keys*.vcfg",
        "*.vcfg_lastclouded",
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
        # game/bin/win64/cs2.exe → parents[6] = Steam 根（仅在默认库时正确）
        # 额外通过注册表获取真正的 Steam 安装目录，覆盖 CS2 装在副库盘的情况。
        steam_root_candidates: list[Path] = []
        try:
            steam_root_candidates.append(cs2.parents[6])
        except IndexError:
            pass
        reg_root = _get_steam_install_root()
        if reg_root is not None and reg_root not in steam_root_candidates:
            steam_root_candidates.append(reg_root)
        seen_userdata: set[str] = set()
        for steam_root in steam_root_candidates:
            userdata = steam_root / "userdata"
            try:
                ud_str = str(userdata.resolve())
            except OSError:
                ud_str = str(userdata)
            if ud_str in seen_userdata:
                continue
            seen_userdata.add(ud_str)
            if userdata.is_dir():
                try:
                    for uid in userdata.iterdir():
                        candidate = uid / "730" / "local" / "cfg"
                        if candidate.is_dir() and candidate not in dirs:
                            dirs.append(candidate)
                        # localconfig.vdf 在 <steamid>/config/，-worldwide 会写入此处
                        cfg_dir = uid / "config"
                        if cfg_dir.is_dir() and cfg_dir not in dirs:
                            dirs.append(cfg_dir)
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
            # 同步把磁盘上的玩家配置原样拷到 ``<repo>/data/.cs2_config_backup/``，每次录制
            # 启动会清空目录再重写，项目里只保留"最近一次录制前"的玩家原始 cfg。
            # 玩家事后可以在该目录翻出 config.cfg / video.txt 自行覆盖回去。
            try:
                write_persistent_backup_from_snap(snap)
            except Exception as e:  # noqa: BLE001
                logger.warning("Persistent disk backup failed (in-memory still active): %s", e)

    def _restore_user_configs(self) -> None:
        """强杀 CS2 后：若 ``recording_state`` 为 ``recording`` 则按 manifest 原子恢复；
        否则回退为内存快照对比（例如持久化备份未写入 state 的边缘情况）。"""
        snap = self._user_config_snapshot
        if is_restore_required():
            try:
                res = restore_latest_user_config_backup(skip_cs2_running_check=True)
                if res.get("ok"):
                    self._user_config_snapshot = {}
                    return
                logger.warning("Manifest restore failed post-kill: %s", res)
            except Exception as e:  # noqa: BLE001
                logger.warning("Manifest restore raised: %s", e)
        if not snap:
            self._user_config_snapshot = {}
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
            logger.info("Restored %d user config file(s) post-kill (memory snapshot)", restored)
        self._user_config_snapshot = {}

    def _voice_ban_paths(self) -> list[Path]:
        """返回所有 Steam 账号的 ``userdata/<id>/730/voice_ban.dt`` 路径。"""
        paths: list[Path] = []
        seen: set[str] = set()
        for cfg_dir in self._candidate_user_config_dirs():
            try:
                parent_730 = cfg_dir.parents[2]
            except IndexError:
                continue
            if parent_730.name != "730":
                continue
            candidate = parent_730 / "voice_ban.dt"
            key = str(candidate)
            if key not in seen:
                seen.add(key)
                paths.append(candidate)
        return paths

    def _clear_voice_ban_files(self) -> None:
        """CS2 启动前将 voice_ban.dt 清空（count=0），确保无人被静音。
        tv_listen_voice_indices 在 demo 层做队伍过滤，dt 文件仅需保持全开。
        结束后由 _restore_user_configs 自动还原原始文件。
        """
        data = struct.pack("<I", 0)  # count=0，无屏蔽名单
        for p in self._voice_ban_paths():
            try:
                if p not in self._user_config_snapshot:
                    self._user_config_snapshot[p] = p.read_bytes() if p.is_file() else None
                current = p.read_bytes() if p.is_file() else None
                if current == data:
                    continue
                _atomic_write_bytes(p, data)
                logger.info("voice_ban.dt cleared: %s", p)
            except OSError as e:
                logger.warning("Clear voice_ban.dt failed for %s: %s", p, e)

    def _patch_video_configs_for_resolution(
        self,
        width: int,
        height: int,
        aspect_ratio_mode: Optional[int] = None,
    ) -> None:
        """CS2 启动前把快照中的 video.txt / cs2_video.txt 改为录制分辨率。

        CS2 读取 video.txt 的优先级高于 -w/-h 命令行参数，所以仅靠启动参数
        不足以改变渲染分辨率。这里直接 patch 磁盘文件；录制结束后
        _restore_user_configs 会把文件还原为玩家原始内容。
        """
        patched = 0
        for p, original in self._user_config_snapshot.items():
            if p.name not in ("video.txt", "cs2_video.txt"):
                continue
            if original is None:
                continue  # 文件原本不存在，跳过
            try:
                text = original.decode("utf-8", errors="replace")
                text = re.sub(
                    r'"setting\.defaultres"\s+"[^"]*"',
                    f'"setting.defaultres"\t\t"{width}"',
                    text,
                )
                text = re.sub(
                    r'"setting\.defaultresheight"\s+"[^"]*"',
                    f'"setting.defaultresheight"\t\t"{height}"',
                    text,
                )
                if aspect_ratio_mode is not None:
                    text = re.sub(
                        r'"setting\.aspectratiomode"\s+"[^"]*"',
                        f'"setting.aspectratiomode"\t\t"{aspect_ratio_mode}"',
                        text,
                    )
                p.write_text(text, encoding="utf-8")
                patched += 1
                logger.info(
                    "Patched %s for recording resolution %dx%d (aspectratiomode=%s)",
                    p.name, width, height, aspect_ratio_mode,
                )
            except (OSError, UnicodeDecodeError) as e:
                logger.warning("Failed to patch video config %s: %s", p, e)
        if patched:
            logger.info("Patched %d video config file(s) for %dx%d recording", patched, width, height)
        else:
            logger.warning(
                "No video.txt / cs2_video.txt found in snapshot to patch for %dx%d "
                "(snapshot keys: %s)",
                width, height,
                [p.name for p in self._user_config_snapshot],
            )

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

                # hwnd / 进程均已消失，但 Windows 内核还可能短暂持有 cfg 文件句柄
                # （CS2 exit autosave、Steam Cloud 初始上传），等待释放再恢复。
                time.sleep(1.5)
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
        # 成片文件名常见形如 player_de_dust2_R1_2K_xxx；在 IGNORECASE 下 [a-z0-9_]+ 会把 _R1… 吃进地图名
        stem = re.split(r"_R\d+", stem, maxsplit=1, flags=re.IGNORECASE)[0]
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
        if category == "compilation" and compilation_kind in {"nemesis_deaths", "all_deaths", "freeze_to_death"}:
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
        jcx = clip.get("_stem_jumpcut_part")
        if jcx is not None and str(jcx).strip():
            try:
                ji = int(jcx)
            except (TypeError, ValueError):
                ji = 0
            if ji > 0:
                parts.append(f"jc{ji}")
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

    async def _rename_recording_output(
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
        for attempt in range(5):
            try:
                if not source.is_file():
                    raise FileNotFoundError("OBS output file not found")
                stem = self._build_clip_recording_stem(clip, demo_abs, spectator_name)
                target = self._unique_recording_target(source, stem)
                if target != source:
                    await asyncio.to_thread(source.rename, target)
                    logger.info("Renamed OBS recording %s -> %s", source, target)
                return {
                    "original_output_path": original,
                    "output_path": str(target),
                    "output_filename": target.name,
                }
            except Exception as e:  # noqa: BLE001
                if attempt < 4:
                    await asyncio.sleep(0.5)
                else:
                    logger.warning("Could not rename OBS recording %s after 5 attempts: %s", original, e)
                    return {"original_output_path": original, "rename_error": str(e)}

    def _append_config_warmup_console_lines(self, lines: list[str]) -> list[str]:
        if not self._extra_warmup_console_lines:
            return lines
        return [*lines, *self._extra_warmup_console_lines]

    def _recording_warmup_console_lines(self, w: RecordingWarmupExtras) -> list[str]:
        """录制会话首次 seek 前注入的观战 cvar（与空格预热后的控制台批次合并）。

        在所有 cvar 之前注入 ``unbindall`` + 一组最小默认绑定，把玩家自定义
        按键统一恢复为安全默认；用户原 ``config.cfg`` / ``cs2_user_keys.cfg`` 等
        已被 ``_snapshot_user_configs`` 落盘，录制结束 / 进程崩溃后都能完整还原。
        ``unbindall`` 必须在第一行：避免玩家把 toggleconsole 改绑到非常规键时，
        我们 SendInput 投到默认 F10 / ``~`` 失效。
        """
        if w.console_cmds:
            cmds = [str(x).strip() for x in w.console_cmds if str(x).strip()]
            merged = _merge_recording_warmup_console_cmds(cmds)
            return self._append_config_warmup_console_lines(
                [*_RECORDING_KEYBIND_RESET_LINES, *merged]
            )
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
        _fb = getattr(w, "spectator_flashbang_opacity", None)
        if _fb is not None and not getattr(w, "pov_hud_enabled", False):
            try:
                _fb_f = float(_fb)
            except (TypeError, ValueError):
                _fb_f = 0.6
            _fb_f = max(0.2, min(1.0, _fb_f))
            lines.append(f"r_spectator_flashbang_opacity {_fb_f:g}")
        _vf = getattr(w, "voice_filter", "mute")
        if _vf in ("mute", "all"):  # "all" 为旧值向后兼容
            lines.append("snd_voipvolume 0")
        elif _vf == "open":
            lines.append("snd_voipvolume 1")
            lines.append("tv_listen_voice_indices -1")
        elif _vf == "off":
            pass  # 不注入任何语音指令
        else:  # "team" or "enemy" — 先打开全员基线，per-segment 再收窄到掩码
            # all_players 为空时以"全部可听"降级，而不是静音
            lines.append("snd_voipvolume 1")
            lines.append("tv_listen_voice_indices -1")
        if w.hide_grenade_trajectory_pip:
            lines.append("sv_grenade_trajectory 0")
            lines.append("sv_grenade_trajectory_prac_pipreview 0")
            lines.append("cl_grenadepreview 0")
            lines.append("sv_grenade_trajectory_time_spectator 0")
        return self._append_config_warmup_console_lines(lines)

    async def execute_plan_queue(
        self,
        requests: "list",
        warmup: "Optional[RecordingWarmupExtras]" = None,
        fade_controller=None,
    ) -> "list[dict]":
        """
        [RecordingV3] Execute a list of RecordingRequestDTOs using the new
        build_plan → RecordingExecutor pipeline. CS2 launch/GSI/cleanup are
        handled by the same battle-tested OBSDirector infrastructure as the
        legacy pipeline; only the per-segment recording loop is new.
        """
        from .recording.plan_builder import build_plan
        from .recording.executor.recording_executor import RecordingExecutor
        from .recording.executor.obs_client import OBSClient, OBSConnectionError
        from .recording.normalizer import NormalizationError
        from .pov_hud_manager import PovHudManager, PovHudError, pov_hud_effective_map_name
        from .pov_constants import POV_CORE_FORCED_COMMANDS, pov_tail_commands

        logger.info("[RecordingV3] execute_plan_queue: %d requests", len(requests))

        all_results: list[dict] = []
        if not requests:
            return all_results

        # Group requests by demo path so each unique demo = one CS2 session.
        demo_groups: dict[str, list] = {}
        demo_abs_map: dict[str, Path] = {}
        for dto in requests:
            key = dto.demo.demo_path or dto.demo.demo_filename
            demo_groups.setdefault(key, []).append(dto)
            if key not in demo_abs_map:
                demo_abs_map[key] = Path(dto.demo.demo_path or dto.demo.demo_filename)

        _first_demo_key = next(iter(demo_groups))
        _first_demo_reqs = demo_groups[_first_demo_key]
        _first_demo_abs = demo_abs_map[_first_demo_key]
        _d0demo = _first_demo_reqs[0].demo if _first_demo_reqs else None
        _pov_first_map = pov_hud_effective_map_name(
            _d0demo.map_name if _d0demo else None,
            str(_first_demo_abs),
        )

        # OBSClient is created here but connected lazily (right before the executor starts)
        # so the WebSocket receive thread does not die during the ~60s CS2 warmup window.
        obs_client = OBSClient(self.obs_config)

        pov_mgr_v3: "Optional[PovHudManager]" = None
        pov_on_v3 = bool(warmup and getattr(warmup, "pov_hud_enabled", False))

        try:
            # ── POV HUD install (before first CS2 launch) ─────────────────────
            if pov_on_v3:
                try:
                    from .env_utils import load_config as _load_cfg
                    _app_cfg = _load_cfg()
                    pov_mgr_v3 = PovHudManager(_app_cfg)
                    logger.info(
                        "[RecordingV3][POV] install pov.vpk (map=%s)",
                        _pov_first_map or "default",
                    )
                    pov_mgr_v3.install(_pov_first_map)
                    logger.info("[RecordingV3][POV] patch gameinfo.gi")
                    self._pov_enabled = True
                except PovHudError as _pov_e:
                    logger.error("[RecordingV3][POV] install failed: %s; continuing without POV HUD", _pov_e)
                    pov_on_v3 = False

            batch_aborted = False
            for job_idx, (demo_key, demo_requests) in enumerate(demo_groups.items()):
                if batch_aborted:
                    break

                demo_abs = demo_abs_map[demo_key]
                demo_name = demo_abs.name
                logger.info("[RecordingV3] Job %d/%d: %s (%d requests)",
                            job_idx + 1, len(demo_groups), demo_name, len(demo_requests))

                if pov_on_v3 and pov_mgr_v3 is not None and job_idx > 0:
                    _d_cur = demo_requests[0].demo if demo_requests else None
                    _pov_map_cur = pov_hud_effective_map_name(
                        _d_cur.map_name if _d_cur else None,
                        str(demo_abs),
                    )
                    try:
                        logger.info(
                            "[RecordingV3][POV] replace pov.vpk for map=%s",
                            _pov_map_cur or "default",
                        )
                        pov_mgr_v3.replace_pov_vpk_for_map(_pov_map_cur)
                    except PovHudError as _pov_sw:
                        logger.error(
                            "[RecordingV3][POV] replace_pov_vpk_for_map failed: %s",
                            _pov_sw,
                        )

                # ── CS2 launch ────────────────────────────────────────────────
                try:
                    self._launch_cs2(demo_abs, warmup)
                except CS2AlreadyRunningError:
                    raise
                except CS2NotReadyError:
                    raise
                except Exception as e:
                    logger.error("[RecordingV3] CS2 launch failed for %s: %s", demo_name, e)
                    for dto in demo_requests:
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": f"CS2 launch failed: {e}", "segment_results": [], "warnings": [],
                        })
                    await self._run_cleanup_step("CS2 shutdown after launch failure", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step("CS2 artifact cleanup", self._cleanup_cs2_artifacts, timeout=8.0)
                    continue

                # ── Wait for GSI ready ────────────────────────────────────────
                try:
                    self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
                    await self._await_gsi_startup_gate()
                    await self._sleep_abortable(8.0)
                    await self._await_cs2_window(40.0)
                    if job_idx > 0:
                        settle = self._env_float("CS2_INSIGHT_BATCH_NEW_DEMO_SETTLE_SEC", "9.0")
                        if settle > 0:
                            await self._sleep_abortable(settle)
                except CS2NotReadyError:
                    logger.error("[RecordingV3] GSI not ready for %s; aborting", demo_name)
                    await self._run_cleanup_step("CS2 shutdown after GSI timeout", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step("CS2 artifact cleanup after GSI timeout", self._cleanup_cs2_artifacts, timeout=8.0)
                    raise

                # ── Inject warmup console commands (+ POV HUD commands if enabled)
                # Order: generic warmup first, then V3 demo-control key bindings,
                # then POV HUD forced commands last (so POV overrides any conflicting warmup cvars).
                # KP_5/KP_6 are bound here so that demo_pause_silent/demo_resume_silent
                # can send a keypress instead of opening the console during recording.
                _V3_DEMO_KEY_BINDINGS = ["bind KP_5 demo_pause", "bind KP_6 demo_resume"]
                if warmup is not None:
                    warmup_cmds = self._recording_warmup_console_lines(warmup)
                    warmup_cmds = [*warmup_cmds, *_V3_DEMO_KEY_BINDINGS]
                    if self._pov_enabled:
                        pov_cmds = [
                            *POV_CORE_FORCED_COMMANDS,
                            *pov_tail_commands(
                                teamcounter_numeric=warmup.pov_teamcounter_numeric,
                                radar_mode=warmup.pov_radar_mode,
                            ),
                        ]
                        warmup_cmds = [*warmup_cmds, *pov_cmds]
                    if warmup_cmds:
                        logger.info("[RecordingV3] applying warmup console commands: %d", len(warmup_cmds))
                        if self._pov_enabled:
                            logger.info("[RecordingV3][POV] applying POV HUD commands after warmup")
                            for _cmd in pov_cmds:
                                logger.info("[RecordingV3][POV] inject command: %s", _cmd)
                        try:
                            await asyncio.to_thread(inject_console_sequence, warmup_cmds)
                        except Exception as _wce:
                            logger.warning("[RecordingV3] warmup console inject failed: %s", _wce)
                else:
                    # No warmup object — still inject the demo control key bindings.
                    try:
                        await asyncio.to_thread(inject_console_sequence, list(_V3_DEMO_KEY_BINDINGS))
                    except Exception as _wce:
                        logger.warning("[RecordingV3] demo key bindings inject failed: %s", _wce)

                # ── Connect OBS right before recording (fresh connection avoids dead recv thread)
                if obs_client.is_connected():
                    try:
                        await asyncio.to_thread(obs_client.disconnect)
                    except Exception:
                        pass
                try:
                    await asyncio.to_thread(obs_client.connect)
                except OBSConnectionError as e:
                    logger.error("[RecordingV3] OBS connect failed for %s: %s", demo_name, e)
                    for dto in demo_requests:
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": f"OBS connection failed: {e}", "segment_results": [], "warnings": [],
                        })
                    await self._run_cleanup_step("CS2 shutdown after OBS failure", self._kill_cs2, timeout=30.0)
                    await self._run_cleanup_step("CS2 artifact cleanup after OBS failure", self._cleanup_cs2_artifacts, timeout=8.0)
                    continue

                # ── Execute each DTO through build_plan + RecordingExecutor ───
                executor = RecordingExecutor(obs_client, abort_event=self._abort_event, fade_controller=fade_controller)
                for dto in demo_requests:
                    if self._abort_requested():
                        logger.info("[RecordingV3] Abort requested, skipping remaining requests")
                        batch_aborted = True
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": "aborted", "segment_results": [], "warnings": [],
                        })
                        continue

                    logger.info("[RecordingV3] build plan: request_id=%s type=%s",
                                dto.request_id, dto.request_type.value)
                    try:
                        plan = build_plan(dto)
                    except NormalizationError as e:
                        logger.warning("[RecordingV3] Normalization failed: %s", e)
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": str(e), "segment_results": [], "warnings": [],
                        })
                        continue
                    except Exception as e:
                        logger.error("[RecordingV3] build_plan error: %s", e)
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": str(e), "segment_results": [], "warnings": [],
                        })
                        continue

                    # ── kb_track: 为 overlay 填充逐 tick 按键状态（请求参数优先，否则读全局配置）────
                    _kb_overlay_req = dto.options.kb_overlay_enabled if dto.options else None
                    logger.info("[kb_overlay] dto.options.kb_overlay_enabled=%s", _kb_overlay_req)
                    if _kb_overlay_req is None:
                        from .env_utils import load_config as _load_cfg
                        _kb_overlay_req = _load_cfg().kb_overlay_enabled
                        logger.info("[kb_overlay] fallback to config: kb_overlay_enabled=%s", _kb_overlay_req)
                    if _kb_overlay_req:
                        from .parser.input_track import extract_input_track as _extract_kb
                        for _seg in plan.segments:
                            try:
                                _frames = _extract_kb(
                                    plan.demo_path,
                                    steamid=_seg.target_steamid64,
                                    player_name=_seg.target_player_name,
                                    start_tick=_seg.start_tick,
                                    end_tick=_seg.end_tick,
                                )
                                _seg.metadata["kb_track"] = _frames
                                logger.info(
                                    "[kb_overlay] seg=%d extracted %d frames (ticks %d-%d steamid=%s)",
                                    _seg.segment_index, len(_frames),
                                    _seg.start_tick, _seg.end_tick, _seg.target_steamid64,
                                )
                            except Exception as _kb_e:
                                logger.warning(
                                    "[RecordingV3] kb_track extraction failed seg=%d: %s",
                                    _seg.segment_index, _kb_e,
                                )
                                _seg.metadata["kb_track"] = []
                    else:
                        logger.info("[kb_overlay] kb_overlay disabled, skipping extraction")

                    # ── voice_filter: patch segment masks before execution ────────
                    _vf = getattr(warmup, "voice_filter", "mute") if warmup else "mute"
                    if _vf in ("off", "open", "mute", "all"):
                        for _seg in plan.segments:
                            _seg.voice_listen_mask = None
                    elif _vf == "enemy":
                        for _seg in plan.segments:
                            _seg.voice_listen_mask = _seg.voice_listen_mask_enemy

                    logger.info("[RecordingV3] execute plan: %d active segments", len(plan.segments))
                    _pre_execute_wall = time.time()
                    try:
                        result = await executor.execute(plan)
                    except Exception as e:
                        logger.error("[RecordingV3] executor error: %s", e)
                        all_results.append({
                            "request_id": dto.request_id, "success": False,
                            "error": str(e), "segment_results": [], "warnings": [],
                        })
                        continue

                    # ── Rename output file using legacy naming convention ──────
                    # recording_started_at from executor (set just before StartRecord) is
                    # more accurate than _pre_execute_wall (which includes CS2 wait etc.).
                    _started_at = result.recording_started_at or _pre_execute_wall
                    _stopped_at = result.recording_stopped_at
                    _clip_dict = _v3_clip_dict_for_rename(dto)
                    _player = dto.target_player.name if dto.target_player.name else None

                    final_output_path = result.output_path
                    rename_meta: dict = {}
                    rename_status: str = "skipped"
                    resolved_path: Optional[Path] = None

                    if result.output_path:
                        resolved_path = Path(result.output_path)
                        rename_status = "from_executor"
                    else:
                        # Fallback: scan the OBS record directory for the newest video
                        # written since recording started.
                        # Use obs_record_directory from executor (fetched via GetRecordDirectory
                        # on the live V3 OBSClient).
                        _obs_dir: Optional[Path] = None
                        if result.obs_record_directory:
                            _obs_dir = Path(result.obs_record_directory)
                        if _obs_dir and _obs_dir.is_dir():
                            logger.info(
                                "[RecordingV3] scanning OBS dir for output (started_at=%.1f, stopped_at=%s): %s",
                                _started_at,
                                f"{_stopped_at:.1f}" if _stopped_at else "N/A",
                                _obs_dir,
                            )
                            # Give OBS up to 6s to close/finalize the output file.
                            _cutoff = _started_at - 3.0
                            for _scan_attempt in range(6):
                                _candidates: list[tuple[float, Path]] = []
                                try:
                                    for _p in _obs_dir.iterdir():
                                        if not _p.is_file() or _p.suffix.lower() not in _RECORDING_VIDEO_EXTENSIONS:
                                            continue
                                        try:
                                            _st = _p.stat()
                                        except OSError:
                                            continue
                                        if _st.st_mtime >= _cutoff:
                                            _candidates.append((_st.st_mtime, _p))
                                except OSError as _scan_e:
                                    logger.warning("[RecordingV3] dir scan error: %s", _scan_e)
                                    break

                                if _candidates:
                                    _candidates.sort(key=lambda x: x[0], reverse=True)
                                    _candidate = _candidates[0][1]
                                    # Wait for file size to stabilize (OBS finalizing).
                                    try:
                                        _sz1 = _candidate.stat().st_size
                                        await asyncio.sleep(1.5)
                                        _sz2 = _candidate.stat().st_size
                                    except OSError:
                                        _sz1, _sz2 = -1, -2  # force retry
                                    if _sz1 == _sz2 and _sz2 > 0:
                                        resolved_path = _candidate
                                        logger.info(
                                            "[RecordingV3] resolved output via scan (attempt %d): %s (size=%d)",
                                            _scan_attempt + 1, resolved_path, _sz2,
                                        )
                                        break
                                    else:
                                        logger.debug(
                                            "[RecordingV3] file still growing (sz %d→%d), retry %d",
                                            _sz1, _sz2, _scan_attempt + 1,
                                        )
                                else:
                                    logger.debug("[RecordingV3] scan attempt %d: no candidates yet", _scan_attempt + 1)

                                await asyncio.sleep(1.0)

                            if resolved_path:
                                rename_status = "from_scan"
                            else:
                                logger.warning(
                                    "[RecordingV3] scan found nothing in %s "
                                    "(cutoff=%.1f, %d candidate dir(s))",
                                    _obs_dir, _cutoff,
                                    len(_candidates) if "_candidates" in dir() else 0,
                                )
                                rename_status = "not_found"
                        else:
                            logger.warning(
                                "[RecordingV3] OBS record directory not available; "
                                "obs_record_directory=%r, legacy fallback=%r",
                                result.obs_record_directory, _obs_dir,
                            )
                            rename_status = "not_found"

                    if resolved_path:
                        rename_meta = await self._rename_recording_output(
                            resolved_path, _clip_dict, demo_abs, _player,
                        )
                        if rename_meta.get("output_path"):
                            final_output_path = rename_meta["output_path"]
                            rename_status = "renamed"
                            logger.info("[RecordingV3] renamed output: %s", final_output_path)
                        elif rename_meta.get("rename_error"):
                            logger.warning("[RecordingV3] rename failed: %s", rename_meta["rename_error"])
                            rename_status = "rename_error"
                            final_output_path = str(resolved_path)

                    _victim_segs_v3 = [
                        {
                            "player_name": s.target_player_name,
                            "perspective_type": "victim",
                        }
                        for s in plan.segments
                        if str(getattr(s.perspective, "value", s.perspective)) == "victim"
                        and not s.disabled
                    ]
                    all_results.append({
                        "request_id": result.request_id,
                        "success": result.success,
                        "output_path": final_output_path,
                        "original_output_path": rename_meta.get("original_output_path") or (
                            str(resolved_path) if resolved_path else result.output_path
                        ),
                        "resolved_output_path": str(resolved_path) if resolved_path else None,
                        "output_filename": rename_meta.get("output_filename"),
                        "rename_status": rename_status,
                        "rename_error": rename_meta.get("rename_error"),
                        "recording_started_at": _started_at,
                        "recording_stopped_at": _stopped_at,
                        "obs_record_directory": result.obs_record_directory,
                        "error": result.error,
                        "warnings": result.warnings,
                        "pov_hud_enabled": pov_on_v3,
                        "recording_perspective": (
                            "pov_hud" if pov_on_v3
                            else "player_follow" if (dto.target_player and dto.target_player.name)
                            else "spectator"
                        ),
                        "victim_pov_segments": _victim_segs_v3,
                        "segment_results": [
                            {
                                "segment_index": s.segment_index,
                                "status": s.status,
                                "output_path": s.output_path,
                                "error": s.error,
                            }
                            for s in result.segment_results
                        ],
                        "planned_segments": [
                            {
                                "segment_index": s.segment_index,
                                "kind": str(s.source_type.value if hasattr(s.source_type, "value") else s.source_type),
                                "source_type": str(s.source_type.value if hasattr(s.source_type, "value") else s.source_type),
                                "perspective": str(s.perspective.value if hasattr(s.perspective, "value") else s.perspective),
                                "demo_start_tick": s.start_tick,
                                "demo_end_tick": s.end_tick,
                                "target_player_name": s.target_player_name,
                                "target_steamid64": s.target_steamid64,
                                "round": s.round,
                                "anchor_ticks": s.anchor_ticks,
                            }
                            for s in plan.segments
                        ],
                    })

                # ── Kill CS2 after this demo group ────────────────────────────
                # Always kill CS2 and restore user configs, even when aborted;
                # _kill_cs2 calls _restore_user_configs internally.
                await self._run_cleanup_step("CS2 shutdown after plan queue job", self._kill_cs2, timeout=30.0)
                await self._run_cleanup_step("CS2 artifact cleanup after plan queue job", self._cleanup_cs2_artifacts, timeout=8.0)

        except (CS2AlreadyRunningError, CS2NotReadyError):
            raise
        except Exception as e:
            self._set_state(DirectorState.ERROR, str(e))
            raise
        finally:
            # Force-stop OBS via a fresh connection in case the hot client's recv
            # thread is dead or StartRecord/ResumeRecord left OBS in an unknown state.
            from .recording.executor.obs_recording_controller import OBSRecordingController
            _final_ctrl = OBSRecordingController(obs_client.config, obs_client)
            try:
                await _final_ctrl.force_stop_recording()
            except Exception as _fse:
                logger.warning("[RecordingV3] finally force_stop_recording failed: %s", _fse)
            try:
                await asyncio.to_thread(obs_client.disconnect)
            except Exception:
                pass
            if pov_mgr_v3 is not None:
                try:
                    logger.info("[RecordingV3][POV] restore gameinfo.gi")
                    pov_mgr_v3.restore()
                except Exception as _pov_restore_e:
                    logger.error("[RecordingV3][POV] restore failed: %s", _pov_restore_e)
            self._pov_enabled = False
            self._set_state(DirectorState.COMPLETED)

        logger.info("[RecordingV3] execute_plan_queue done: %d results", len(all_results))
        return all_results


def _v3_clip_dict_for_rename(dto: "Any") -> dict:
    """Build a minimal clip-like dict from a RecordingRequestDTO for use with
    _build_clip_recording_stem so V3 recordings get the same naming as the legacy pipeline."""
    events = getattr(dto, "events", None) or []
    target = getattr(dto, "target_player", None)
    player_name = (target.name if target else None) or ""
    if not player_name and events:
        first = events[0]
        killer = getattr(first, "killer", None)
        player_name = (killer.name if killer else None) or ""

    kill_events = [e for e in events if getattr(getattr(e, "event_type", None), "value", None) == "kill"]
    kill_count = len(kill_events)
    round_no = events[0].round if events else None
    request_type = getattr(getattr(dto, "request_type", None), "value", None) or "clip"
    request_id = str(getattr(dto, "request_id", None) or "")
    demo = getattr(dto, "demo", None)
    map_name = (demo.map_name if demo else None) or ""

    return {
        "killer_name": player_name,
        "target_player": player_name,
        "category": request_type,
        "round": round_no,
        "kill_count": kill_count,
        "clip_id": request_id[:12] if request_id else "clip",
        "map_name": map_name,
    }
