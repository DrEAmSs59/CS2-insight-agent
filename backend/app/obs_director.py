"""自动化导播控制 - OBS 录制 & CS2 Demo 回放控制"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
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

from .demo_parser import (
    BUFFER_SECONDS_AFTER,
    TICK_RATE as DEMO_TICK_RATE,
    compute_spec_player_slot_one_based,
    get_demo_spec_calibration_tick,
    get_player_list,
    spec_player_extra_offset_for_gsi_failure,
)
from .cs2_config_backup import (
    is_cs2_running,
    is_restore_required,
    restore_latest_user_config_backup,
    write_persistent_backup_from_snap,
)
from .env_utils import OBSConfig, SpecPlayerVerifyConfig
from .gsi_ready import gsi_status, is_gsi_ready, reset_gsi_ready, wait_gsi_payload_after
from .pov_constants import POV_CORE_FORCED_COMMANDS, pov_tail_commands
from .win_cs2_console import ensure_cs2_foreground, find_cs2_hwnd, inject_console_sequence, send_cs2_space_taps
from .radar.radar_data_extractor import _normalize_record_segments

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
    "anchor_tick",
    "pre_roll_sec",
    "post_roll_sec",
    "demo_tick_rate",
    "radar_sync_offset_sec",
    "source_ticks",
    "source_rounds",
    "source_round_ends",
    "fixed_segment_pacing",
    "freeze_to_death_round_filter",
    "freeze_to_death_round_windows",
    "record_segments",
    "radar_timing",
    "obs_recording_markers",
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
        if k == "record_segments":
            prev = out.get("record_segments")
            if isinstance(prev, list) and len(prev) > 0:
                if not (isinstance(v, list) and len(v) > 0):
                    continue
        out[k] = v
    return out


def _clip_radar_anchor_tick(clip: dict) -> int:
    kills = _clip_kill_ticks_sorted(clip)
    if kills:
        return int(kills[len(kills) // 2])
    dt = _clip_death_tick(clip)
    if dt is not None:
        return int(dt)
    st = max(0, int(clip.get("start_tick") or 0))
    et = max(st, int(clip.get("end_tick") or 0))
    return int((st + et) // 2)


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


def _radar_record_segments_wall_plan(
    segments: list[tuple[int, int]],
    *,
    post_start_seg0: float,
    first_seg_extra: float,
    post_obs_resume_sec: float,
    settle_between: float,
    tick_rate: float,
    source_rounds_per_seg: list[Optional[int]],
) -> list[dict[str, Any]]:
    """与 smart-jump 录制 sleep 结构一致的「成片视频时间 → demo tick 段」元数据（供雷达采样）。"""
    tr = max(float(tick_rate), 0.001)
    video_t = 0.0
    out: list[dict[str, Any]] = []
    for si, (ss, ee) in enumerate(segments):
        seg_dur_demo = max(0.0, (int(ee) - int(ss)) / tr)
        if si == 0:
            pre_hold = float(post_start_seg0)
            dur_video = pre_hold + seg_dur_demo + float(first_seg_extra)
        else:
            pre_hold = 0.0
            dur_video = float(post_obs_resume_sec) + float(settle_between) + seg_dur_demo
        dur_video = max(0.0, dur_video)
        item: dict[str, Any] = {
            "start_tick": int(ss),
            "end_tick": int(ee),
            "video_start_sec": float(video_t),
            "duration_sec": float(dur_video),
            "pre_hold_sec": float(pre_hold),
        }
        if si < len(source_rounds_per_seg):
            rn = source_rounds_per_seg[si]
            if rn is not None:
                item["source_round"] = int(rn)
        out.append(item)
        video_t += dur_video
    return out


def _recording_radar_clip_meta_fields(
    clip: dict,
    *,
    use_smart_jump: bool,
    segments: list[tuple[int, int]],
    meta_record_start_tick: int,
    meta_record_end_tick: int,
    post_start_seg0: float,
    first_seg_extra: float,
    settle_between: float,
    director: Any,
) -> dict[str, Any]:
    tick_rate = float(TICK_RATE)
    try:
        sync_off = float((os.environ.get("CS2_INSIGHT_RADAR_TIMELINE_OFFSET_SEC") or "0").strip() or 0.0)
    except (TypeError, ValueError):
        sync_off = 0.0
    anchor = _clip_radar_anchor_tick(clip)
    pre_roll = max(0.0, (int(anchor) - int(meta_record_start_tick)) / tick_rate)
    post_roll = max(0.0, (int(meta_record_end_tick) - int(anchor)) / tick_rate)
    fields: dict[str, Any] = {
        "demo_tick_rate": tick_rate,
        "radar_sync_offset_sec": float(sync_off),
        "anchor_tick": int(anchor),
        "pre_roll_sec": float(pre_roll),
        "post_roll_sec": float(post_roll),
    }
    if use_smart_jump and segments:
        post_obs = float(director._env_float("CS2_INSIGHT_POST_OBS_RESUME_DEMO_DELAY", "0.25"))
        rnds = _source_round_per_demo_segment(clip, segments)
        fields["record_segments"] = _radar_record_segments_wall_plan(
            segments,
            post_start_seg0=float(post_start_seg0),
            first_seg_extra=float(first_seg_extra),
            post_obs_resume_sec=post_obs,
            settle_between=float(settle_between),
            tick_rate=tick_rate,
            source_rounds_per_seg=rnds,
        )
    else:
        fields["record_segments"] = []
    return fields


def _ffprobe_duration_sec(video_path: Path) -> Optional[float]:
    """读取成片实际时长（秒），供 radar_timing 与视频时间轴对齐。"""
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


def _build_radar_timing_payload(
    *,
    record_segments: list[dict[str, Any]],
    meta_record_start_tick: int,
    meta_record_end_tick: int,
    anchor_tick: int,
    tick_rate: float,
    actual_duration_sec: float,
) -> dict[str, Any]:
    """
    用 ffprobe 实际时长生成 clip_meta.radar_timing，将 video_time 仿射映射到 demo tick。
    多段 smart-jump 时按各段 planned 时长比例缩放 wall 时间轴以贴合真实成片长度。
    """
    tr = max(float(tick_rate), 0.001)
    norm = _normalize_record_segments(record_segments, tr)
    actual = max(0.01, float(actual_duration_sec))

    segs_out: list[dict[str, Any]] = []

    if norm:
        planned_ends: list[float] = []
        for s in norm:
            vs = float(s["video_start_sec"])
            dur = float(s.get("duration_sec", 0.0) or 0.0)
            planned_ends.append(vs + max(0.0, dur))
        planned_total = max(planned_ends) if planned_ends else 0.0
        scale = actual / max(planned_total, 0.001)

        for i, s in enumerate(norm):
            vs_base = float(s["video_start_sec"]) * scale
            ve_base = (float(s["video_start_sec"]) + float(s.get("duration_sec", 0.0) or 0.0)) * scale
            if ve_base <= vs_base:
                continue
            pre_hold = float(s.get("pre_hold_sec", 0.0) or 0.0) * scale
            if pre_hold > 0.005 and ve_base > vs_base + pre_hold + 0.001:
                # demo 暂停阶段（OBS 已在录制，demo 尚未开始推进）
                segs_out.append({
                    "segment_index": i,
                    "video_start_sec": float(vs_base),
                    "video_end_sec": float(vs_base + pre_hold),
                    "type": "gap",
                    "sync_method": "hold_or_empty",
                })
                vs_affine = vs_base + pre_hold
            else:
                vs_affine = vs_base
            item: dict[str, Any] = {
                "segment_index": i,
                "video_start_sec": float(vs_affine),
                "video_end_sec": float(ve_base),
                "demo_start_tick": int(s["start_tick"]),
                "demo_end_tick": int(s["end_tick"]),
                "sync_method": "affine",
            }
            try:
                rn = s.get("source_round")
                if rn is not None:
                    item["source_round"] = int(rn)
            except (TypeError, ValueError):
                pass
            segs_out.append(item)
        if segs_out:
            return {
                "version": 1,
                "mode": "segments_affine",
                "tick_rate_hint": float(tick_rate),
                "segments": segs_out,
            }

    anchor = int(anchor_tick)
    anchor_video_sec: Optional[float] = None
    try:
        if meta_record_end_tick > meta_record_start_tick:
            anchor_video_sec = max(0.0, (anchor - int(meta_record_start_tick)) / tr)
    except Exception:
        anchor_video_sec = None
    segs_out = [
        {
            "segment_index": 0,
            "video_start_sec": 0.0,
            "video_end_sec": float(actual),
            "demo_start_tick": int(meta_record_start_tick),
            "demo_end_tick": int(meta_record_end_tick),
            "anchor_tick": anchor,
            "anchor_video_sec": anchor_video_sec,
            "sync_method": "affine",
        },
    ]

    return {
        "version": 1,
        "mode": "segments_affine",
        "tick_rate_hint": float(tick_rate),
        "segments": segs_out,
    }


def _active_video_intervals_from_obs_markers(
    markers: list[dict[str, Any]],
) -> tuple[list[tuple[float, float]], float]:
    """
    将 OBS Start/Pause/Resume/Stop 边界（monotonic 时间戳）解析为成片内连续的视频时长区间。
    仅在 outputPaused=false 时累积时长；Pause 期间成片时间轴不前进。
    """
    if not markers:
        return [], 0.0
    intervals: list[tuple[float, float]] = []
    cum = 0.0
    active_start: Optional[float] = None
    for m in markers:
        op = str(m.get("op") or "")
        try:
            t = float(m["mono"])
        except (KeyError, TypeError, ValueError):
            continue
        if op == "start":
            active_start = t
        elif op == "resume":
            active_start = t
        elif op == "pause":
            if active_start is not None:
                dur = max(0.0, t - active_start)
                intervals.append((cum, cum + dur))
                cum += dur
                active_start = None
        elif op == "stop":
            if active_start is not None:
                dur = max(0.0, t - active_start)
                intervals.append((cum, cum + dur))
                cum += dur
                active_start = None
    return intervals, cum


def _build_radar_timing_from_obs_markers(
    *,
    markers: list[dict[str, Any]],
    segments: list[tuple[int, int]],
    pov_demo_spans: list[tuple[int, int]],
    use_smart_jump: bool,
    meta_record_start_tick: int,
    meta_record_end_tick: int,
    tick_rate: float,
    actual_duration_sec: float,
) -> Optional[dict[str, Any]]:
    """
    严格按 OBS 边界打点构造 radar_timing，不做 buffer 推算。
    若标记与 demo 段数量无法对齐则返回 None，由调用方回退到旧版仿射推算。
    """
    raw_intervals, model_total = _active_video_intervals_from_obs_markers(markers)
    if not raw_intervals or model_total <= 1e-9:
        return None

    tr = max(float(tick_rate), 0.001)
    tick_rows: list[tuple[int, int]] = []
    if use_smart_jump and segments:
        tick_rows = [(int(ss), int(ee)) for ss, ee in segments]
        tick_rows.extend([(int(a), int(b)) for a, b in pov_demo_spans])
    else:
        tick_rows = [(int(meta_record_start_tick), int(meta_record_end_tick))]
        tick_rows.extend([(int(a), int(b)) for a, b in pov_demo_spans])

    primary_n = len(tick_rows)
    if primary_n <= 0:
        return None

    lengths = [max(0.0, b - a) for a, b in raw_intervals]
    total_len = sum(lengths)
    if total_len <= 1e-9:
        return None

    actual = max(0.01, float(actual_duration_sec))
    scale = actual / total_len

    scaled: list[tuple[float, float, float]] = []
    cum_v = 0.0
    for L in lengths:
        Ls = L * scale
        scaled.append((cum_v, cum_v + Ls, Ls))
        cum_v += Ls

    segs_out: list[dict[str, Any]] = []
    for idx in range(primary_n):
        if idx >= len(scaled):
            logger.warning(
                "obs_markers radar_timing: interval shortage idx=%d need=%d have=%d",
                idx,
                primary_n,
                len(scaled),
            )
            return None
        vs, ve, _ = scaled[idx]
        ss, ee = tick_rows[idx]
        if ee <= ss:
            return None
        segs_out.append(
            {
                "segment_index": idx,
                "video_start_sec": float(vs),
                "video_end_sec": float(ve),
                "demo_start_tick": int(ss),
                "demo_end_tick": int(ee),
                "sync_method": "affine",
            },
        )

    for idx in range(primary_n, len(scaled)):
        vs, ve, _ = scaled[idx]
        segs_out.append(
            {
                "segment_index": idx,
                "video_start_sec": float(vs),
                "video_end_sec": float(ve),
                "type": "gap",
                "sync_method": "hold_or_empty",
            },
        )

    return {
        "version": 2,
        "mode": "obs_markers",
        "tick_rate_hint": float(tr),
        "segments": segs_out,
        "obs_model_duration_sec": float(model_total),
        "uniform_scale": float(scale),
    }


def _video_align_log_obs_marker_chain(clip_id: str, markers: list[dict[str, Any]]) -> None:
    """Mono timeline of OBS start/pause/resume/stop for correlating wall gaps vs muxed timeline."""
    if not markers:
        logger.info("[video-align] clip=%s obs_marker_chain=empty", clip_id)
        return
    t0 = float(markers[0]["mono"])
    chunks: list[str] = []
    prev = t0
    for m in markers:
        mono = float(m["mono"])
        op = str(m.get("op", "?"))
        chunks.append(f"{op}+{mono - t0:.3f}s(d{mono - prev:+.3f})")
        prev = mono
    logger.info("[video-align] clip=%s obs_marker_chain=%s", clip_id, " ".join(chunks))


def _video_align_log_radar_summary(
    clip_id: str,
    *,
    radar: Any,
    ffprobe_sec: Optional[float],
) -> None:
    if not radar or not isinstance(radar, dict):
        logger.info(
            "[video-align] clip=%s ffprobe_sec=%s radar_timing=null",
            clip_id,
            f"{float(ffprobe_sec):.6f}" if isinstance(ffprobe_sec, (int, float)) else repr(ffprobe_sec),
        )
        return
    segs = radar.get("segments")
    if not isinstance(segs, list) or not segs:
        logger.info(
            "[video-align] clip=%s ffprobe_sec=%s radar=no_segments mode=%r",
            clip_id,
            f"{float(ffprobe_sec):.6f}" if isinstance(ffprobe_sec, (int, float)) else repr(ffprobe_sec),
            radar.get("mode"),
        )
        return
    parts: list[str] = []
    for i, s in enumerate(segs[:12]):
        if not isinstance(s, dict):
            continue
        typ = str(s.get("type") or ("main" if i == 0 else "seg"))
        vs, ve = s.get("video_start_sec"), s.get("video_end_sec")
        ds, de = s.get("demo_start_tick"), s.get("demo_end_tick")
        try:
            vsa = float(vs) if vs is not None else float("nan")
            vea = float(ve) if ve is not None else float("nan")
        except (TypeError, ValueError):
            vsa = vea = float("nan")
        parts.append(f"[{i}]{typ}v{vsa:.3f}-{vea:.3f}t{ds}-{de}")
    _ff = (
        f"{float(ffprobe_sec):.6f}"
        if isinstance(ffprobe_sec, (int, float)) and ffprobe_sec is not None
        else repr(ffprobe_sec)
    )
    logger.info(
        "[video-align] clip=%s ffprobe_sec=%s radar_mode=%r model_sec=%s scale=%s segs=%s",
        clip_id,
        _ff,
        radar.get("mode"),
        radar.get("obs_model_duration_sec"),
        radar.get("uniform_scale"),
        " | ".join(parts),
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
    # 击杀后预留（POST_LAST）：每段末杀后的缓冲；智能跳剪中段与末段相同。需足够长以保证 gototick 后击杀动画可见。
    POST_LAST = _get_override_ticks("post_last_sec", "CS2_INSIGHT_SMART_POST_LAST_TICKS", 3.0)
    MAX_GAP = max(1, _get_override_ticks("max_gap_sec", "CS2_INSIGHT_SMART_MAX_GAP_TICKS", 12.0))

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
        has_single_segment_override = isinstance(override, dict) and any(
            k in override for k in ("pre_first_sec", "post_last_sec")
        )
        # 纯死亡锚点（含回合时间线 death 事件）：必须压在 death_tick 附近结束。
        # 若沿用片段整体 end_tick（建议窗 often 为死亡 +4s），CS2 死亡视角约 2s 后会把观战切到
        # 他人，后半段录到的已不是目标画面。
        dt_only = _clip_death_tick(clip) if not has_single_segment_override else None
        if dt_only is not None:
            anchor_tick = int(dt_only)
            seg_start = max(0, anchor_tick - PRE_FIRST)
            if clip_min_start_tick > 0:
                seg_start = max(seg_start, clip_min_start_tick)
            val_po = override.get("post_last_sec")
            if val_po is not None and str(val_po).strip():
                post_ticks = max(0, int(float(val_po) * DEMO_TICK_RATE))
            elif str(clip.get("timeline_source") or "").strip() == "round_timeline_event":
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
            return [segment]

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
    if merged and end_tick > 0:
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
    # 实验性 POV：与 pov_tail_commands 对应（仅 pov_enabled 时注入末尾）
    pov_radar_mode: int = -1  # cl_drawhud_force_radar：-1 隐藏，0 显示
    pov_teamcounter_numeric: bool = True  # cl_teamcounter_playercount_instead_of_avatars


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
        cs2_fps_max: int = 240,
        *,
        cs2_extra_launch_args: str = "",
        record_inject_console_lines: str = "",
        spec_player_verify: Optional[SpecPlayerVerifyConfig] = None,
    ):
        self.obs_config = obs_config
        self.cs2_path = cs2_path
        self._cs2_fps_max: int = max(0, min(int(cs2_fps_max), 9999))
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
        self._obs_cursor_restore: list[tuple[str, bool]] = []
        self._obs_managed_scene_ready = False
        self._obs_managed_input_ready = False
        self._spec_calibration_by_demo: dict[str, dict[str, int]] = {}
        self._spec_parse_fallback_offset_by_demo: dict[str, int] = {}
        self._demo_steam_by_name_cache: dict[str, dict[str, str]] = {}
        self._abort_event = abort_event
        # 实验性 POV：在首次片段预热注入末尾追加强制 cvar
        self._pov_enabled = False
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
            all_results.append(
                {
                    "clip_id": c["clip_id"],
                    "status": "aborted",
                    "demo_path": str(dem_path),
                    "demo_filename": demo_name,
                },
            )
        for j in range(job_idx + 1, len(demo_jobs)):
            dp, cls, _, _ = demo_jobs[j]
            n = dp.name
            for c in cls:
                all_results.append(
                    {
                        "clip_id": c["clip_id"],
                        "status": "aborted",
                        "demo_path": str(dp),
                        "demo_filename": n,
                    },
                )

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
            logger.warning("OBS WebSocket test failed: %s", e, exc_info=True)
            return {"ok": False, "error": _friendly_obs_websocket_test_error(e)}

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
            self._obs_apply_managed_game_capture_transform(scene_name, input_name, scene_item_id=None)
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
                cs_resp = self._ws.call(obs_requests.CreateSceneItem(sceneName=scene_name, sourceName=input_name))
                link_sid = self._obs_scene_item_id_from_response(cs_resp)
                if not getattr(cs_resp, "status", False):
                    logger.warning(
                        "OBS CreateSceneItem %r -> %r failed (status=false): %s",
                        input_name,
                        scene_name,
                        getattr(cs_resp, "datain", {}),
                    )
                    return False
                self._obs_apply_managed_game_capture_settings(input_name)
                self._obs_apply_managed_game_capture_transform(scene_name, input_name, scene_item_id=link_sid)
                self._obs_managed_input_ready = True
                logger.info("OBS managed game capture linked into scene: %s", input_name)
                return True
            except Exception as e:
                logger.warning("OBS CreateSceneItem %r -> %r failed: %s", input_name, scene_name, e)
                return False

        settings = self._obs_managed_game_capture_settings()
        try:
            ci_resp = self._ws.call(
                obs_requests.CreateInput(
                    sceneName=scene_name,
                    inputName=input_name,
                    inputKind=os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_KIND", "game_capture").strip()
                    or "game_capture",
                    inputSettings=settings,
                    sceneItemEnabled=True,
                )
            )
            new_sid = self._obs_scene_item_id_from_response(ci_resp)
            if not getattr(ci_resp, "status", False):
                logger.warning(
                    "OBS CreateInput game capture %r failed (status=false): %s",
                    input_name,
                    getattr(ci_resp, "datain", {}),
                )
                return False
            self._obs_apply_managed_game_capture_transform(scene_name, input_name, scene_item_id=new_sid)
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

    @staticmethod
    def _obs_scene_item_id_from_response(resp: Any) -> Optional[int]:
        """Parse ``sceneItemId`` from CreateInput / CreateSceneItem response when successful."""
        if not getattr(resp, "status", False):
            return None
        raw = (getattr(resp, "datain", {}) or {}).get("sceneItemId")
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    def _obs_apply_managed_game_capture_transform(
        self,
        scene_name: str,
        input_name: str,
        scene_item_id: Optional[int] = None,
    ) -> bool:
        """Stretch the managed game capture source to the OBS canvas."""
        if not self._ws:
            return False
        if os.environ.get("CS2_INSIGHT_OBS_STRETCH_GAME_CAPTURE", "1").strip().lower() in (
            "0",
            "false",
            "no",
        ):
            return False

        resolved_id = scene_item_id
        if resolved_id is None:
            for attempt in range(18):
                resolved_id = self._obs_find_scene_item_id(scene_name, input_name)
                if resolved_id is not None:
                    break
                time.sleep(0.05)
        if resolved_id is None:
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
            "positionX": 0.0,
            "positionY": 0.0,
            "rotation": 0.0,
            "scaleX": 1.0,
            "scaleY": 1.0,
            "cropTop": 0.0,
            "cropBottom": 0.0,
            "cropLeft": 0.0,
            "cropRight": 0.0,
            "boundsType": os.environ.get("CS2_INSIGHT_OBS_BOUNDS_TYPE", "OBS_BOUNDS_STRETCH").strip()
            or "OBS_BOUNDS_STRETCH",
            "boundsAlignment": 5,
            "boundsWidth": float(base_width),
            "boundsHeight": float(base_height),
            "alignment": 5,
        }
        try:
            set_resp = self._ws.call(
                obs_requests.SetSceneItemTransform(
                    sceneName=scene_name,
                    sceneItemId=resolved_id,
                    sceneItemTransform=transform,
                )
            )
            if not getattr(set_resp, "status", False):
                logger.warning(
                    "OBS SetSceneItemTransform failed for %r in %r: %s",
                    input_name,
                    scene_name,
                    getattr(set_resp, "datain", {}),
                )
                return False
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

    def _obs_snapshot_record_dir_video_paths(self) -> set[str]:
        """录制开始前 OBS 输出目录中已有视频路径集合，用于 StopRecord 后兜底匹配新文件。"""
        record_dir = self._obs_record_directory_path()
        if not record_dir or not record_dir.is_dir():
            return set()
        out: set[str] = set()
        try:
            for p in record_dir.iterdir():
                if not p.is_file() or p.suffix.lower() not in _RECORDING_VIDEO_EXTENSIONS:
                    continue
                try:
                    out.add(str(p.resolve()))
                except OSError:
                    out.add(str(p))
        except OSError as e:
            logger.debug("Snapshot OBS record dir failed: %s", e)
        return out

    def _pick_new_recording_path_after_snapshot(
        self,
        before_paths: set[str],
        started_at_wall: Optional[float],
    ) -> Optional[Path]:
        if started_at_wall is None:
            return None
        record_dir = self._obs_record_directory_path()
        if not record_dir or not record_dir.is_dir():
            return None
        cutoff = float(started_at_wall) - 2.0
        candidates: list[tuple[float, Path]] = []
        try:
            for p in record_dir.iterdir():
                if not p.is_file() or p.suffix.lower() not in _RECORDING_VIDEO_EXTENSIONS:
                    continue
                try:
                    key = str(p.resolve())
                except OSError:
                    key = str(p)
                if key in before_paths:
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                if st.st_mtime >= cutoff:
                    candidates.append((st.st_mtime, p))
        except OSError as e:
            logger.debug("Pick new recording file failed: %s", e)
            return None
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

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

    async def _finalize_obs_recording_rename(
        self,
        stop_path: Optional[Path],
        clip: dict,
        demo_abs: Path,
        spectator_name: Optional[str],
        record_started_at_wall: Optional[float],
        pre_record_video_paths: Optional[set[str]] = None,
    ) -> dict:
        """StopRecord 后对 OBS 输出文件改名：无固定前置等待；最多 5 次尝试，间隔 0.5s，成功即返回。

        WebSocket 已给出 ``outputPath`` 时各轮只尝试该路径（避免录制目录内误选其它成片）；
        仅当 StopRecord 未返回路径时先按录制前目录快照匹配新文件，再按 mtime 扫描兜底。
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
                path = None
                if pre_record_video_paths is not None:
                    path = self._pick_new_recording_path_after_snapshot(
                        pre_record_video_paths,
                        record_started_at_wall,
                    )
                if path is None:
                    path = self._locate_recent_recording_output(record_started_at_wall)
            result = await self._rename_recording_output(path, clip, demo_abs, spectator_name)
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
            fix0 = _WARMUP_FIXED_CONSOLE_LINES[0]
            if cmds and cmds[0].strip() == fix0.strip():
                return self._append_config_warmup_console_lines([*_RECORDING_KEYBIND_RESET_LINES, *cmds])
            return self._append_config_warmup_console_lines([*_RECORDING_KEYBIND_RESET_LINES, fix0, *cmds])
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
        return self._append_config_warmup_console_lines(lines)

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
    ) -> Optional[bool]:
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
            if self._pov_enabled:
                session_lines = [
                    *session_lines,
                    *POV_CORE_FORCED_COMMANDS,
                    *pov_tail_commands(
                        teamcounter_numeric=warmup.pov_teamcounter_numeric,
                        radar_mode=warmup.pov_radar_mode,
                    ),
                ]
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
        _spec_verify_ok = True
        if spec_cmd is not None:
            # 尝试从 spec_cmd 解析初始槽位，并通过 GSI 验证是否切准目标玩家
            _target_steam64: Optional[str] = None
            if demo_abs.is_file() and pname:
                _target_steam64 = self._demo_steam_by_name(demo_abs).get(pname.lower())
            try:
                _initial_slot = int(spec_cmd.split()[-1])
            except (IndexError, ValueError):
                _initial_slot = 0

            if _target_steam64 and _initial_slot > 0 and not jump_cut_seek:
                # ★ 核心路径：GSI 验证 + +1 重试（参数见配置 spec_player_verify）
                # jump_cut_seek=True 时 demo 处于暂停状态，spec_player 被 CS2 静默忽略，
                # 玩家视角不会切换（仍是上一段的正确视角），跳过 GSI 验证。
                _spv = self._spec_player_verify
                _max_retries = max(1, int(_spv.max_retries))
                _per_retry_t = float(_spv.per_retry_timeout_sec)
                _verify_settle = float(_spv.settle_sec)
                verified_slot = await self._spec_player_with_gsi_verify(
                    demo_abs,
                    _target_steam64,
                    _initial_slot,
                    mode,
                    max_retries=_max_retries,
                    per_retry_timeout=_per_retry_t,
                    settle=_verify_settle,
                    skip_console_toggle=True,
                    close_console=False,
                )
                if verified_slot is None:
                    _spec_verify_ok = False
                    ok4 = False
                    logger.error(
                        "Stage 4 spec_verify failed: name=%r steam=%s initial_slot=%s source=%s demo=%s",
                        pname, _target_steam64, _initial_slot, spec_source, demo_abs.name,
                    )
                else:
                    ok4 = True
                    logger.info(
                        "Stage 4 spec_verify OK: mode=%s slot=%d (initial=%d) steam=%s source=%s demo=%s",
                        mode, verified_slot, _initial_slot, _target_steam64, spec_source, demo_abs.name,
                    )
            else:
                # 无 steam64 或无有效槽位时退化为单次注入（不验证）
                ok4 = await asyncio.to_thread(
                    _inj,
                    [f"spec_mode {mode}", spec_cmd],
                    skip=True,
                    close=False,
                )
                if ok4:
                    logger.info("Injected stage 4 (no-verify): spec_mode %s + %s", mode, spec_cmd)
                else:
                    logger.warning("Console inject failed stage 4: spec_mode + %s", spec_cmd)
                await self._sleep_abortable(spec_settle)

        ok5 = await asyncio.to_thread(_inj, [close_cmd], skip=True, close=False)
        if ok5:
            logger.info("Injected stage 5: %s", close_cmd)
        else:
            logger.warning("Console inject failed stage 5: %s", close_cmd)

        # POV 倒退 seek（jump_cut + 不切主视角 spec）时 OBS 常处于 PauseRecord：此处长 sleep
        # 会直接变成成片里的「定格秒数」，与 post_last 无关；只保留极短尾部。
        if jump_cut_seek and spec_cmd is None:
            await self._sleep_abortable(0.05)
            await self._sleep_abortable(0.05)
        else:
            await self._sleep_abortable(self._env_float("CS2_INSIGHT_POST_HIDE_DELAY", "0.55"))
            await self._sleep_abortable(self._env_float("CS2_INSIGHT_PRE_RECORD_DELAY", "0.35"))
        if not _spec_verify_ok:
            return None
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
        player_name_for_db = (spectator_name or "").strip() or None

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
        if clip.get("fixed_segment_pacing"):
            _pacing_override = {}
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

        # CS2 Demo 关键帧对齐补偿：demo_gototick 会跳到目标 tick 前最近的关键帧（非精确 tick），
        # 若 pre_first_sec 比默认值小，seek 目标更靠近击杀帧，但仍落在同一个关键帧上，
        # 导致录制起点固定在约 5.5s 前，与用户设定无关。
        # 修复：demo_pause 后先 demo_resume，等待多余的预滚走完，再 StartRecord。
        # delay = max(0, calibrated_default_pre - target_pre_first)
        _KEYFRAME_PRE_FIRST_SEC = self._env_float("CS2_INSIGHT_KEYFRAME_PRE_FIRST_SEC", "5.5")
        _pre_first_override_val = (
            _pacing_override.get("pre_first_sec") if isinstance(_pacing_override, dict) else None
        )
        _target_pre_first_sec = (
            float(_pre_first_override_val) if _pre_first_override_val is not None else _KEYFRAME_PRE_FIRST_SEC
        )
        _apply_kf_delay = (
            (has_kill_timeline or has_single_segment_override or has_death_timeline)
            and not clip.get("fixed_segment_pacing")
        )
        delay_pre_sec = (
            max(0.0, _KEYFRAME_PRE_FIRST_SEC - _target_pre_first_sec) if _apply_kf_delay else 0.0
        )

        def _estimated_record_start_tick(seek: int) -> int:
            return max(0, int(seek)) + max(0, int(engine_burn_ticks))

        if use_smart_jump:
            # 补偿：往前多跳 engine_burn_ticks，确保 OBS 开始录制时刚好到达逻辑起点
            seek_tick = max(0, segments[0][0] - engine_burn_ticks)
            meta_record_start_tick = _estimated_record_start_tick(seek_tick)
            meta_record_end_tick = int(segments[-1][1])
            planned_wall_seconds = post_start_seg0 + first_seg_extra + sum(
                max(0.0, (ee - ss) / float(TICK_RATE)) for ss, ee in segments
            )
        elif has_kill_timeline or has_single_segment_override or has_death_timeline:
            ss0, ee0 = segments[0]
            seek_tick = max(0, ss0 - engine_burn_ticks)
            meta_record_start_tick = _estimated_record_start_tick(seek_tick)
            meta_record_end_tick = int(ee0)
            # 末杀 + post_last_sec 对应 ee0；主段 sleep 满此墙钟后立刻 PauseRecord，不再追加尾垫
            # （旧 +0.2s 会在预留窗后又多录一截再暂停，与「击杀后预留结束即暂停」语义不一致）。
            legacy_duration = max(0.0, (ee0 - meta_record_start_tick) / float(TICK_RATE))
            planned_wall_seconds = legacy_duration
        else:
            seek_tick = max(0, start_tick - PRE_ROLL_TICKS - engine_burn_ticks)
            tail = 0.2
            meta_record_start_tick = _estimated_record_start_tick(seek_tick)
            meta_record_end_tick = int(end_tick)
            legacy_duration = max(0.0, (end_tick - meta_record_start_tick) / float(TICK_RATE)) + tail
            if str(clip.get("timeline_source") or "").strip() == "round_timeline_round":
                # 整回合固定 tick 窗口：墙钟略长于纯 tick 换算，抵消准备阶段少量漂移（常量，不读环境变量）。
                legacy_duration += 0.35
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
        _prep_result = await self._prepare_clip_playback(
            demo_abs,
            seek_tick,
            spectator_name,
            spectator_user_id,
            warmup=warmup,
            inject_session_warmup_cvars=(clip_idx == 0),
            goto_delay_extra=goto_extra,
        )
        if _prep_result is None:
            raise _SpecVerifyAbort(clip_id)

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
        pre_record_video_paths: set[str] = set()
        stop_record_output_path: Optional[Path] = None
        output_result: dict = {}
        jumpcut_extra_outputs: list[dict] = []
        fatal_recording_error: Optional[str] = None
        _victim_pov_segments: list[dict[str, Any]] = []
        obs_timing_markers: list[dict[str, Any]] = []
        _pov_demo_spans: list[tuple[int, int]] = []

        def _mark_obs(op: str) -> None:
            obs_timing_markers.append({"op": op, "mono": time.monotonic()})

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
                    _mark_obs("pause")
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
                            _mark_obs("pause")
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
            _mark_obs("pause")
            return True

        def _obs_resume() -> None:
            if not self._ws:
                return
            try:
                req = getattr(obs_requests, "ResumeRecord", None)
                if req is None:
                    return
                self._ws.call(req())
                _mark_obs("resume")
            except Exception as e:
                logger.warning("OBS ResumeRecord failed: %s", e)

        try:
            if not self._ws:
                return {
                    "clip_id": clip_id,
                    "status": "obs_error",
                    "demo_path": str(demo_abs),
                    "demo_filename": demo_abs.name,
                    "player_name": player_name_for_db,
                }
            # prepare 结束后到真正 StartRecord 之间要做 OBS/光标，期间若不 pause，Demo 会空转吃掉击杀前预留
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
            pre_record_video_paths = self._obs_snapshot_record_dir_video_paths()

            # 关键帧延迟：先 demo_resume，等多余预滚走完，再 StartRecord，使成片起点对齐目标。
            demo_resumed_before_record = False
            if pause_bracket and delay_pre_sec > 0.05:
                ok_dr_pre = await asyncio.to_thread(
                    inject_console_sequence,
                    ["demo_resume"],
                    skip_console_toggle=True,
                    close_console=False,
                )
                if ok_dr_pre:
                    demo_resumed_before_record = True
                    logger.info(
                        "[record] kf_delay clip=%s: default_pre=%.2fs target=%.2fs → delay StartRecord %.2fs",
                        clip_id,
                        _KEYFRAME_PRE_FIRST_SEC,
                        _target_pre_first_sec,
                        delay_pre_sec,
                    )
                    await asyncio.sleep(delay_pre_sec)
                else:
                    logger.warning(
                        "[record] demo_resume before StartRecord failed for clip=%s; "
                        "recording will have ~%.2fs extra pre-roll",
                        clip_id,
                        delay_pre_sec,
                    )

            record_started_at_wall = time.time()
            self._ws.call(obs_requests.StartRecord())
            _mark_obs("start")

            radar_post_start_sec = 0.0  # 从 StartRecord 到 demo 实际开始推 tick 的实测时长
            if pause_bracket and not demo_resumed_before_record:
                ok_dr0 = await asyncio.to_thread(
                    inject_console_sequence,
                    ["demo_resume"],
                    skip_console_toggle=True,
                    close_console=False,
                )
                if not ok_dr0:
                    logger.warning("demo_resume immediately after StartRecord failed")
                await asyncio.sleep(0.08)
                radar_post_start_sec = time.time() - record_started_at_wall
            elif pause_bracket and demo_resumed_before_record:
                await asyncio.sleep(0.08)
                radar_post_start_sec = time.time() - record_started_at_wall

            _va_lk_tick: Optional[int] = None
            try:
                _va_kills = _clip_kill_ticks_sorted(clip)
                if _va_kills:
                    _va_lk_tick = int(_va_kills[-1])
            except Exception:
                pass
            _va_mst = int(meta_record_start_tick)
            _va_tr = float(TICK_RATE)
            _va_lk_linear = (
                (_va_lk_tick - _va_mst) / _va_tr if _va_lk_tick is not None else None
            )
            logger.info(
                "[video-align] clip=%s phase=start_record wall=%.6f mono=%.6f "
                "meta_start_tick=%s meta_end_tick=%s last_kill_tick=%s "
                "approx_last_kill_sec_if_linear_ticks=%s radar_post_start_sec=%.4f",
                clip_id,
                record_started_at_wall,
                time.monotonic(),
                meta_record_start_tick,
                meta_record_end_tick,
                _va_lk_tick,
                f"{_va_lk_linear:.4f}" if _va_lk_linear is not None else "None",
                float(radar_post_start_sec),
            )

            # 关键帧预滚：StartRecord 前已 demo_resume 并 sleep(delay_pre_sec)，demo 在片头已向前走了
            # delay_pre_sec；StartRecord 后又 sleep(0.08) demo 仍在走。若此处仍按整段 legacy_duration
            #（按 seg 起算的墙钟全长）去睡，会整体多录约 delay_pre_sec，击杀后预留观感被「吃掉」。
            _rec_wall_trim = 0.0
            if pause_bracket:
                _rec_wall_trim += 0.08
            if pause_bracket and demo_resumed_before_record and delay_pre_sec > 0.05:
                _rec_wall_trim += float(delay_pre_sec)

            if not use_smart_jump:
                await self._sleep_abortable(max(0.0, float(legacy_duration) - _rec_wall_trim))
            else:
                await self._sleep_abortable(post_start_seg0)
                jump_cut_active = True
                file_split_jumpcut = False
                split_fallback_on = os.environ.get(
                    "CS2_INSIGHT_SMART_JUMP_FILE_SPLIT_FALLBACK",
                    "1",
                ).strip().lower() not in ("0", "false", "no")

                async def _split_close_open_obs(part_idx: int) -> None:
                    """PauseRecord 不可用时：结束当前 OBS 文件并开始新录制，再执行段间 seek（控制台不入镜）。"""
                    nonlocal record_started_at_wall, pre_record_video_paths
                    stop_resp = self._ws.call(obs_requests.StopRecord())
                    _mark_obs("stop")
                    stop_path = self._obs_response_output_path(stop_resp)
                    clip_tag = dict(clip)
                    clip_tag["_stem_jumpcut_part"] = int(part_idx)
                    part_meta = await self._finalize_obs_recording_rename(
                        stop_path,
                        clip_tag,
                        demo_abs,
                        spectator_name,
                        record_started_at_wall,
                        pre_record_video_paths,
                    )
                    if part_meta:
                        jumpcut_extra_outputs.append(part_meta)
                    pre_record_video_paths = self._obs_snapshot_record_dir_video_paths()
                    record_started_at_wall = time.time()
                    self._ws.call(obs_requests.StartRecord())
                    _mark_obs("start")
                    if pause_bracket:
                        ok_dr0 = await asyncio.to_thread(
                            inject_console_sequence,
                            ["demo_resume"],
                            skip_console_toggle=True,
                            close_console=False,
                        )
                        if not ok_dr0:
                            logger.warning("demo_resume after split StartRecord failed")
                        await asyncio.sleep(0.08)

                for si, (seg_start, seg_end) in enumerate(segments):
                    seg_dur = max(0.0, (seg_end - seg_start) / float(TICK_RATE))
                    if si == 0:
                        # 首段与单段同理：StartRecord 前/刚开录时 demo 已先走 _rec_wall_trim 秒。
                        seg0 = max(0.0, seg_dur + float(first_seg_extra) - _rec_wall_trim)
                        await self._sleep_abortable(seg0)
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
                    if file_split_jumpcut:
                        await _split_close_open_obs(si)
                    elif not _obs_pause():
                        if split_fallback_on:
                            logger.warning(
                                "PauseRecord unavailable (e.g. MP4); using StopRecord/StartRecord between "
                                "segments clip_id=%s segment=%d/%d. Prefer MKV recording format for a single file.",
                                clip_id,
                                si + 1,
                                len(segments),
                            )
                            file_split_jumpcut = True
                            fatal_recording_error = None
                            await _split_close_open_obs(si)
                        else:
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
                    # 回合合集首段往往很长：纯墙钟 sleep(seg_dur) 与 demo 实际 tick 易有漂移，
                    # 段末可能已略过 seg_end 进入下一回合（观感像「到 R2 了」）。OBS 已 Pause 后先
                    # demo_gototick 钳回上一段结束 tick，再执行下一段大跨度跳转，避免锚点落在错误回合。
                    ftd_snap = (
                        str(clip.get("compilation_kind") or "").strip() == "freeze_to_death" and si >= 1
                    )
                    if ftd_snap:
                        snap_tick = max(0, int(segments[si - 1][1]))
                        boundary_cmds = ["demo_pause", "demo_timescale 1", f"demo_gototick {snap_tick}"]
                        logger.info(
                            "freeze_to_death segment boundary resync snap_tick=%s before seg=%d/%d clip_id=%s",
                            snap_tick,
                            si + 1,
                            len(segments),
                            clip_id,
                        )
                    else:
                        boundary_cmds = ["demo_pause"]
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
                        boundary_cmds,
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
                            # jump_cut_seek=True 时不触发 GSI 验证，不会返回 None
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

            # ── 主录制墙钟结束后立刻 PauseRecord，再按需 demo_pause ─────────────
            # 击杀后预留（post_last）已折合进 legacy_duration / 智能跳剪末段 seg_dur；
            # sleep 结束后的第一件事应是 OBS 暂停，再执行控制台与 POV 准备（与输出格式是否
            # 真正进入 paused 无关：仍发 PauseRecord，不支持时由 finally Resume+Stop 收尾）。
            #
            # 最后一回合：clip_max_tick 附近易触发结算界面。demo_pause 注入约 ~0.6s，
            # 必须先 _obs_pause 再 demo_pause，否则控制台注入期间结算画面会进主成片。
            _bridge_t0 = time.monotonic()
            _va_lk_br: Optional[int] = None
            try:
                _va_k2 = _clip_kill_ticks_sorted(clip)
                if _va_k2:
                    _va_lk_br = int(_va_k2[-1])
            except Exception:
                pass
            _va_tr_b = float(TICK_RATE)
            _va_ms_b = int(meta_record_start_tick)
            _va_me_b = int(meta_record_end_tick)
            _va_span_b = (_va_me_b - _va_ms_b) / _va_tr_b
            _va_lk_lin_b = (
                (_va_lk_br - _va_ms_b) / _va_tr_b if _va_lk_br is not None else None
            )
            logger.info(
                "[video-align] clip=%s phase=main_sleep_tick_model smart_jump=%d "
                "meta_start=%s meta_end=%s approx_demo_span_sec_if_linear_ticks=%.4f "
                "last_kill_tick=%s approx_last_kill_sec_if_linear_ticks=%s",
                clip_id,
                1 if use_smart_jump else 0,
                meta_record_start_tick,
                meta_record_end_tick,
                _va_span_b,
                _va_lk_br,
                f"{_va_lk_lin_b:.4f}" if _va_lk_lin_b is not None else "None",
            )
            if not use_smart_jump:
                _main_sleep_used = max(0.0, float(legacy_duration) - float(_rec_wall_trim))
                logger.info(
                    "[main-pov-bridge] clip=%s phase=main_sleep_done smart_jump=0 mono=%.3f "
                    "legacy_duration_sec=%.4f rec_wall_trim_sec=%.4f main_sleep_sec=%.4f "
                    "segments=%s meta_start_tick=%s meta_end_tick=%s",
                    clip_id,
                    _bridge_t0,
                    float(legacy_duration),
                    float(_rec_wall_trim),
                    _main_sleep_used,
                    segments,
                    meta_record_start_tick,
                    meta_record_end_tick,
                )
            else:
                logger.info(
                    "[main-pov-bridge] clip=%s phase=main_sleep_done smart_jump=1 mono=%.3f "
                    "segments=%s meta_start_tick=%s meta_end_tick=%s",
                    clip_id,
                    _bridge_t0,
                    segments,
                    meta_record_start_tick,
                    meta_record_end_tick,
                )

            _clip_max_val = int(clip.get("clip_max_tick") or 0)
            _pre_pov_obs_paused = _obs_pause()
            logger.info(
                "[main-pov-bridge] clip=%s phase=post_main_obs_pause mono=%.3f dt_sec=%.3f "
                "pause_ok=%s obs_record_paused=%s clip_max_tick=%s",
                clip_id,
                time.monotonic(),
                time.monotonic() - _bridge_t0,
                _pre_pov_obs_paused,
                _obs_record_paused(),
                _clip_max_val,
            )
            if _pre_pov_obs_paused:
                await asyncio.sleep(0.05)
            if _clip_max_val > 0:
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
                logger.info(
                    "[main-pov-bridge] clip=%s phase=post_main_demo_pause mono=%.3f dt_sec=%.3f ok=%s",
                    clip_id,
                    time.monotonic(),
                    time.monotonic() - _bridge_t0,
                    _ok_post_pause,
                )
            else:
                logger.info(
                    "[main-pov-bridge] clip=%s phase=post_main_demo_pause_skipped mono=%.3f dt_sec=%.3f "
                    "reason=clip_max_tick_0",
                    clip_id,
                    time.monotonic(),
                    time.monotonic() - _bridge_t0,
                )

            # ── 追加 POV 段落（受害者视角 / 击杀者视角） ────────────────────────
            # 高光片段：追加每位受害者死亡前后的视角；失误片段：追加击杀者视角。
            # 开关及独立时序参数均来自 clip.pacing_override（由队列抽屉写入）。
            # 固定 tick 分段（解析高光/合集）时禁用节奏覆写，但回合时间线入队片段仍允许受害者/击杀者 POV。
            _vpo = clip.get("pacing_override") or {}
            _tl_src = str(clip.get("timeline_source") or "").strip()
            _is_round_timeline = _tl_src.startswith("round_timeline")
            if clip.get("fixed_segment_pacing") and not _is_round_timeline:
                _vpo = {}
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
                        _vic_pairs.append((_killer_name, int(_death_t), None, "killer"))
                else:
                    _vk_ticks  = _clip_kill_ticks_in_order(clip)
                    if _want_victim_pov:
                        # 受害者视角（高光/合集片段）：按 kill_ticks 顺序逐一追加
                        _vic_list  = clip.get("victims") or []
                        for _i, (_vn, _vt) in enumerate(zip(_vic_list, _vk_ticks)):
                            _nxt = int(_vk_ticks[_i + 1]) if _i + 1 < len(_vk_ticks) else None
                            _vic_pairs.append((_vn, int(_vt), _nxt, "victim"))
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
                            _vic_pairs.append((_kn, int(_kt), None, "killer"))
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

                for _pov_i, (_vname, _vtick, _next_kill_tick, _pov_kind) in enumerate(_vic_pairs):
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
                    logger.info(
                        "[main-pov-bridge] clip=%s phase=pov_segment_begin mono=%.3f dt_sec=%.3f "
                        "pov_index=%d/%d name=%r kind=%s seek_tick=%d vs_start=%d vs_end=%d "
                        "record_dur_sec=%.4f pre_pov_obs_paused_flag=%s",
                        clip_id,
                        time.monotonic(),
                        time.monotonic() - _bridge_t0,
                        int(_pov_i) + 1,
                        len(_vic_pairs),
                        _vname,
                        _pov_kind,
                        int(_pov_seek_tick),
                        int(_vs_start),
                        int(_vs_end),
                        float(_pov_record_dur),
                        bool(_pre_pov_obs_paused),
                    )
                    _pov_reused_main_pause = bool(_pre_pov_obs_paused)
                    _pov_pause_ok = False
                    if _pre_pov_obs_paused:
                        _pre_pov_obs_paused = False  # 仅首次复用
                        _pov_pause_ok = True
                    elif not _obs_pause():
                        logger.warning("OBS PauseRecord failed for POV append (%s); skipping", _vname)
                        break
                    else:
                        _pov_pause_ok = True
                    logger.info(
                        "[main-pov-bridge] clip=%s phase=pov_obs_pause_done mono=%.3f dt_sec=%.3f "
                        "name=%r reused_main_pause=%s pause_ok=%s obs_record_paused=%s",
                        clip_id,
                        time.monotonic(),
                        time.monotonic() - _bridge_t0,
                        _vname,
                        _pov_reused_main_pause,
                        _pov_pause_ok,
                        _obs_record_paused(),
                    )

                    _pov_demo_spans.append((int(_vs_start), int(_vs_end)))

                    _ok_vdr = False
                    _pov_skip = False  # True → spec verify 耗尽重试，跳过本 POV 段
                    try:
                        # skip_leading=False：内部完整注入 demo_pause + demo_timescale 1 + demo_gototick，
                        # 确保倒退 seek 在 demo_pause 状态下可靠触发。
                        # goto_delay_extra 应对倒退 seek（需从 keyframe 重扫）的较长耗时。
                        # 注意：jump_cut_seek=True 会跳过 stage-2 demo_resume，导致 stage-4 的
                        # spec_mode/spec_player 在 demo 暂停状态下发出 → CS2 静默忽略视角切换。
                        # 修正：将 spec 命令合入下方 demo_resume 注入批次，确保 demo 已恢复
                        # 播放时再切摄像机。
                        # demo_resume 与 spec 注入须在 _obs_resume() 之前完成（OBS 仍为 PauseRecord），
                        # 否则控制台开关会录进成片（见智能跳剪段间注释）。
                        _pov_goto_extra = self._pov_goto_delay_extra_sec(
                            clip,
                            pov_seek_tick=max(0, _pov_seek_tick),
                            clip_max_tick=_clip_max,
                        )
                        logger.info(
                            "[main-pov-bridge] clip=%s phase=pov_prepare_enter mono=%.3f dt_sec=%.3f "
                            "name=%r seek_tick=%d goto_delay_extra_sec=%.4f obs_record_paused=%s",
                            clip_id,
                            time.monotonic(),
                            time.monotonic() - _bridge_t0,
                            _vname,
                            int(_pov_seek_tick),
                            float(_pov_goto_extra),
                            _obs_record_paused(),
                        )
                        await self._prepare_clip_playback(
                            demo_abs,
                            max(0, _pov_seek_tick),
                            None,   # spec 由下方 demo_resume 批次完成
                            None,
                            warmup=warmup,
                            inject_session_warmup_cvars=False,
                            jump_cut_seek=True,
                            jump_cut_skip_leading_demo_pause=False,
                            goto_delay_extra=_pov_goto_extra,
                        )
                        logger.info(
                            "[main-pov-bridge] clip=%s phase=pov_prepare_exit mono=%.3f dt_sec=%.3f "
                            "name=%r obs_record_paused=%s",
                            clip_id,
                            time.monotonic(),
                            time.monotonic() - _bridge_t0,
                            _vname,
                            _obs_record_paused(),
                        )
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
                        # ★ 以慢速启动 demo，让 GSI 验证期间 demo 几乎不前进。
                        _pov_verify_timescale = float(self._spec_player_verify.demo_timescale)
                        if _pov_verify_timescale <= 0:
                            _pov_verify_timescale = 0.05
                        _ok_vdr = await asyncio.to_thread(
                            inject_console_sequence,
                            [f"demo_timescale {_pov_verify_timescale:g}", "demo_resume"],
                            skip_console_toggle=False,
                            close_console=True,
                        )
                        if _ok_vdr:
                            await self._sleep_abortable(
                                self._env_float("CS2_INSIGHT_POV_RESUME_TO_SPEC_DELAY", "0.18"),
                            )
                            if _pov_slot is not None:
                                _pov_target_steam64 = self._demo_steam_by_name(demo_abs).get(
                                    _vname.lower() if _vname else ""
                                )
                                _pov_spv = self._spec_player_verify
                                _pov_max_retries = max(1, int(_pov_spv.max_retries))
                                _pov_per_retry_t = float(_pov_spv.per_retry_timeout_sec)
                                _pov_verify_settle = float(_pov_spv.settle_sec)
                                if _pov_target_steam64:
                                    verified_pov_slot = await self._spec_player_with_gsi_verify(
                                        demo_abs,
                                        _pov_target_steam64,
                                        int(_pov_slot),
                                        _pov_mode,
                                        max_retries=_pov_max_retries,
                                        per_retry_timeout=_pov_per_retry_t,
                                        settle=_pov_verify_settle,
                                        skip_console_toggle=False,
                                        close_console=True,
                                    )
                                    if verified_pov_slot is None:
                                        logger.warning(
                                            "POV spec_verify failed name=%r demo=%s; skipping segment",
                                            _vname, demo_abs.name,
                                        )
                                        _pov_skip = True
                                        _ok_vdr = False
                                    else:
                                        logger.info(
                                            "POV spec_verify OK name=%r slot=%d (initial=%d) source=%s",
                                            _vname, verified_pov_slot, int(_pov_slot), _pov_source,
                                        )
                                else:
                                    _spec_cmds = [f"spec_mode {_pov_mode}", f"spec_player {int(_pov_slot)}"]
                                    logger.info(
                                        "POV spec (no-verify, no-steam64) name=%r slot=%s source=%s",
                                        _vname, _pov_slot, _pov_source,
                                    )
                                    _ok_vdr = await asyncio.to_thread(
                                        inject_console_sequence,
                                        _spec_cmds,
                                        skip_console_toggle=False,
                                        close_console=True,
                                    )
                            elif _vname:
                                logger.warning(
                                    "POV spec: no slot for name=%r demo=%s; skipping spec_player",
                                    _vname, demo_abs,
                                )
                            if not _pov_skip:
                                await asyncio.to_thread(
                                    inject_console_sequence,
                                    ["demo_timescale 1"],
                                    skip_console_toggle=False,
                                    close_console=True,
                                )
                        if _ok_vdr and not _pov_skip:
                            await self._sleep_abortable(_pov_post_resume_delay)
                            await self._sleep_abortable(settle_between)
                    finally:
                        # 仅在 spec 验证成功时恢复 OBS 录制；验证失败时 OBS 保持暂停，跳过本段
                        logger.info(
                            "[main-pov-bridge] clip=%s phase=pov_pre_obs_resume mono=%.3f dt_sec=%.3f "
                            "name=%r pov_skip=%s ok_vdr=%s obs_record_paused=%s",
                            clip_id,
                            time.monotonic(),
                            time.monotonic() - _bridge_t0,
                            _vname,
                            bool(_pov_skip),
                            bool(_ok_vdr),
                            _obs_record_paused(),
                        )
                        if not _pov_skip:
                            if record_started_at_wall is not None:
                                logger.info(
                                    "[video-align] clip=%s phase=pov_wall_before_resume "
                                    "pov_i=%s name=%r wall_since_start_record=%.4f mono=%.6f "
                                    "dt_from_main_sleep=%.4f",
                                    clip_id,
                                    _pov_i,
                                    _vname,
                                    time.time() - float(record_started_at_wall),
                                    time.monotonic(),
                                    time.monotonic() - _bridge_t0,
                                )
                            _obs_resume()

                    if _pov_skip:
                        logger.warning(
                            "POV segment skipped (spec_verify exhausted) name=%r kind=%s demo=%s",
                            _vname, _pov_kind, demo_abs.name,
                        )
                        continue
                    if not _ok_vdr:
                        logger.warning("POV resume/spec injection failed for %s; segment may be unstable", _vname)
                    _victim_pov_segments.append(
                        {
                            "player_name": str(_vname),
                            "duration_sec": round(float(_pov_record_dur), 4),
                            "anchor_tick": int(_vtick),
                            "perspective_type": str(_pov_kind),
                        }
                    )
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
                            _mark_obs("resume")
                    except Exception:
                        pass  # 未暂停时 OBS 可能返回错误，忽略即可
                    stop_resp = self._ws.call(obs_requests.StopRecord())
                    _mark_obs("stop")
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
                    pre_record_video_paths,
                )

        self._set_state(DirectorState.STOPPING, clip_id)
        radar_clip_meta = _recording_radar_clip_meta_fields(
            clip,
            use_smart_jump=use_smart_jump,
            segments=segments,
            meta_record_start_tick=int(meta_record_start_tick),
            meta_record_end_tick=int(meta_record_end_tick),
            post_start_seg0=float(radar_post_start_sec),
            first_seg_extra=float(first_seg_extra),
            settle_between=float(settle_between),
            director=self,
        )
        if obs_timing_markers:
            radar_clip_meta["obs_recording_markers"] = list(obs_timing_markers)
        _ffprobe_sec_for_log: Optional[float] = None
        try:
            _op = (output_result or {}).get("output_path")
            if _op:
                _dur_actual = _ffprobe_duration_sec(Path(str(_op)))
                _ffprobe_sec_for_log = _dur_actual
                if _dur_actual is not None:
                    legacy_rt = _build_radar_timing_payload(
                        record_segments=list(radar_clip_meta.get("record_segments") or []),
                        meta_record_start_tick=int(meta_record_start_tick),
                        meta_record_end_tick=int(meta_record_end_tick),
                        anchor_tick=int(radar_clip_meta.get("anchor_tick") or _clip_radar_anchor_tick(clip)),
                        tick_rate=float(TICK_RATE),
                        actual_duration_sec=float(_dur_actual),
                    )
                    strict_rt = _build_radar_timing_from_obs_markers(
                        markers=list(obs_timing_markers),
                        segments=list(segments),
                        pov_demo_spans=list(_pov_demo_spans),
                        use_smart_jump=use_smart_jump,
                        meta_record_start_tick=int(meta_record_start_tick),
                        meta_record_end_tick=int(meta_record_end_tick),
                        tick_rate=float(TICK_RATE),
                        actual_duration_sec=float(_dur_actual),
                    )
                    if strict_rt is not None:
                        radar_clip_meta["radar_timing"] = strict_rt
                        radar_clip_meta["record_segments"] = []
                    else:
                        radar_clip_meta["radar_timing"] = legacy_rt
        except Exception as _rt_exc:
            logger.warning("radar_timing 构建失败（将依赖旧时间轴）: %s", _rt_exc)
        _video_align_log_obs_marker_chain(clip_id, list(obs_timing_markers or []))
        _video_align_log_radar_summary(
            clip_id,
            radar=radar_clip_meta.get("radar_timing"),
            ffprobe_sec=_ffprobe_sec_for_log,
        )
        if fatal_recording_error:
            err_out: dict[str, Any] = {
                "clip_id": clip_id,
                "status": "error",
                "error": fatal_recording_error,
                "duration": planned_wall_seconds,
                "smart_jump_segments": len(segments) if use_smart_jump else 1,
                "player_name": player_name_for_db,
                "record_start_tick": meta_record_start_tick,
                "record_end_tick": meta_record_end_tick,
                **output_result,
            }
            merge_clip_metadata_into_recording_result(err_out, clip)
            err_out.update(radar_clip_meta)
            return err_out
        ok_out: dict[str, Any] = {
            "clip_id": clip_id,
            "status": "recorded",
            "duration": planned_wall_seconds,
            "smart_jump_segments": len(segments) if use_smart_jump else 1,
            "player_name": player_name_for_db,
            "record_start_tick": meta_record_start_tick,
            "record_end_tick": meta_record_end_tick,
            **output_result,
        }
        if jumpcut_extra_outputs:
            _parts = [x.get("output_path") for x in jumpcut_extra_outputs if x.get("output_path")]
            if _parts:
                ok_out["smart_jump_split_files"] = _parts
                ok_out["smart_jump_file_split_used"] = True
        merge_clip_metadata_into_recording_result(ok_out, clip)
        ok_out.update(radar_clip_meta)
        ok_out["pov_hud_enabled"] = bool(getattr(self, "_pov_enabled", False))
        if getattr(self, "_pov_enabled", False):
            ok_out["recording_perspective"] = "pov_hud"
        elif player_name_for_db:
            ok_out["recording_perspective"] = "player_follow"
        else:
            ok_out["recording_perspective"] = "spectator"
        ok_out["victim_pov_segments"] = list(_victim_pov_segments)
        ok_out["death_tick"] = _clip_death_tick(clip)
        ok_out["kill_ticks"] = list(_clip_kill_ticks_in_order(clip))
        return ok_out

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
        *,
        pov_enabled: bool = False,
    ) -> list[dict]:
        """
        Full pipeline: copy demo -> game/csgo, launch CS2 +playdemo -> OBS record -> cleanup.
        若提供 ``spectator_user_id``，控制台使用 ``spec_player <id>``；否则用 ``spectator_name``。
        Returns updated clips with recording status.
        """
        results: list[dict] = []

        self._pov_enabled = bool(pov_enabled)
        try:
            self._launch_cs2(demo_abs, warmup)
            self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
            await self._await_gsi_startup_gate()

            if not self.connect_obs():
                self._set_state(DirectorState.ERROR, "Cannot connect to OBS")
                return [
                    {
                        "clip_id": c["clip_id"],
                        "status": "obs_error",
                        "demo_path": str(demo_abs),
                        "demo_filename": demo_abs.name,
                    }
                    for c in clips
                ]

            self._set_state(DirectorState.LOADING_DEMO, str(demo_abs))
            load_ok = False
            try:
                await self._sleep_abortable(8.0)
                await self._await_cs2_window(40.0)
                load_ok = True
            except RecordingAborted:
                logger.info("Recording aborted by user (pre-clip)")
                await self._run_cleanup_step("OBS StopRecord after abort", self._safe_stop_obs_recording, timeout=10.0)
                for c in clips:
                    results.append(
                        {
                            "clip_id": c["clip_id"],
                            "status": "aborted",
                            "demo_path": str(demo_abs),
                            "demo_filename": demo_abs.name,
                        },
                    )

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
                        one["demo_path"] = str(demo_abs)
                        one["demo_filename"] = demo_abs.name
                        merge_clip_metadata_into_recording_result(one, clip)
                        results.append(one)
                    except _SpecVerifyAbort:
                        logger.error(
                            "spec_player GSI verify exhausted retries for clip %s; aborting pipeline",
                            clip_id,
                        )
                        await self._run_cleanup_step(
                            "OBS StopRecord after spec verify failure",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        results.append(
                            {
                                "clip_id": clip_id,
                                "status": "spec_verify_failed",
                                "error": "GSI验证失败：切换玩家视角重试均未成功，中止录制",
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_abs.name,
                            },
                        )
                        for c in clips[clip_idx + 1:]:
                            results.append(
                                {
                                    "clip_id": c["clip_id"],
                                    "status": "aborted",
                                    "demo_path": str(demo_abs),
                                    "demo_filename": demo_abs.name,
                                },
                            )
                        break
                    except RecordingAborted:
                        logger.info("Recording aborted by user at clip %s", clip_id)
                        await self._run_cleanup_step(
                            "OBS StopRecord after abort",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        results.append(
                            {
                                "clip_id": clip_id,
                                "status": "aborted",
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_abs.name,
                            },
                        )
                        for c in clips[clip_idx + 1:]:
                            results.append(
                                {
                                    "clip_id": c["clip_id"],
                                    "status": "aborted",
                                    "demo_path": str(demo_abs),
                                    "demo_filename": demo_abs.name,
                                },
                            )
                        break
                    except Exception as e:
                        logger.error("Recording failed for %s: %s", clip_id, e)
                        try:
                            self._obs_restore_hide_cursor_inputs()
                        except Exception:
                            pass
                        results.append(
                            {
                                "clip_id": clip_id,
                                "status": "error",
                                "error": str(e),
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_abs.name,
                            },
                        )

        except RecordingAborted:
            self._set_state(DirectorState.STOPPING, "aborted")
        except Exception as e:
            self._set_state(DirectorState.ERROR, str(e))
            raise
        finally:
            self._pov_enabled = False
            await self._cleanup_recording_session()
            self._set_state(DirectorState.COMPLETED)

        return results

    async def execute_batch_recording(
        self,
        demo_jobs: list[tuple[Path, list[dict], Optional[str], Optional[int]]],
        warmup: Optional[RecordingWarmupExtras] = None,
        *,
        pov_enabled: bool = False,
    ) -> list[dict]:
        """
        多 Demo 批量录制：OBS 全程保持连接；每个 Demo 启动 CS2 → 录完该 Demo 全部片段 → 关闭游戏，再下一个。
        ``demo_jobs`` 每项为 ``(demo_abs, clips, spectator_name, spectator_user_id)``。
        返回扁平结果列表，每条含 ``demo_filename`` 便于前端对照。
        """
        all_results: list[dict] = []

        if not demo_jobs:
            return all_results

        self._pov_enabled = bool(pov_enabled)
        try:
            if not self.connect_obs():
                self._set_state(DirectorState.ERROR, "Cannot connect to OBS")
                for dem_path, clips, _, _ in demo_jobs:
                    df = dem_path.name
                    for c in clips:
                        all_results.append(
                            {
                                "clip_id": c["clip_id"],
                                "status": "obs_error",
                                "demo_path": str(dem_path),
                                "demo_filename": df,
                            },
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
                                "demo_path": str(demo_abs),
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
                        one["demo_path"] = str(demo_abs)
                        merge_clip_metadata_into_recording_result(one, clip)
                        all_results.append(one)
                    except _SpecVerifyAbort:
                        logger.error(
                            "Batch spec_player GSI verify exhausted retries for clip %s; aborting pipeline",
                            clip_id,
                        )
                        await self._run_cleanup_step(
                            "OBS StopRecord after spec verify failure",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        all_results.append(
                            {
                                "clip_id": clip_id,
                                "status": "spec_verify_failed",
                                "error": "GSI验证失败：切换玩家视角重试均未成功，中止录制",
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_name,
                            },
                        )
                        OBSDirector._append_aborted_results_for_tail(demo_jobs, job_idx, clip_idx, all_results)
                        await self._run_cleanup_step("CS2 shutdown after spec verify failure", self._kill_cs2, timeout=30.0)
                        await self._run_cleanup_step(
                            "CS2 artifact cleanup after spec verify failure",
                            self._cleanup_cs2_artifacts,
                            timeout=8.0,
                        )
                        batch_aborted = True
                        break
                    except RecordingAborted:
                        logger.info("Batch recording aborted by user at clip %s", clip_id)
                        await self._run_cleanup_step(
                            "OBS StopRecord after abort",
                            self._safe_stop_obs_recording,
                            timeout=10.0,
                        )
                        all_results.append(
                            {
                                "clip_id": clip_id,
                                "status": "aborted",
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_name,
                            },
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
                            {
                                "clip_id": clip_id,
                                "status": "error",
                                "error": str(e),
                                "demo_path": str(demo_abs),
                                "demo_filename": demo_name,
                            },
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
            self._pov_enabled = False
            await self._cleanup_recording_session()
            self._set_state(DirectorState.COMPLETED)

        return all_results
