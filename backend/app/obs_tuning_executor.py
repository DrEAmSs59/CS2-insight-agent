"""Auditable OBS tuning executor: apply, short-record, probe and report."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Optional

from obswebsocket import requests as obs_requests

from . import obs_config_center
from .obs_tuning import (
    ObsTuningApplyRequest,
    build_change_plan,
    discover_environment,
    recommend,
)


DiscoveryLoader = Callable[[Any], dict[str, Any]]
ConnectionFactory = Callable[[Any], Any]
BackupCreator = Callable[[], dict[str, str]]
MediaProbe = Callable[[str, str], dict[str, Any]]
LogReader = Callable[[float], dict[str, Any]]


logger = logging.getLogger(__name__)


def _connect_for_tuning(obs_cfg: Any) -> Any:
    # The generic OBS client waits 60 seconds per request. That is appropriate
    # for long recording jobs but makes a 10-second tuning test look frozen if
    # OBS fails to answer while starting or finalizing the test file.
    return obs_config_center._ws_connect(obs_cfg, timeout=12.0)


def _event(step: str, label: str, status: str, detail: str) -> dict[str, str]:
    return {"step": step, "label": label, "status": status, "detail": detail}


def _result(
    *,
    ok: bool,
    status: str,
    message: str,
    events: list[dict[str, str]],
    plan: Optional[dict[str, Any]] = None,
    backup: Optional[dict[str, str]] = None,
    actual: Optional[dict[str, Any]] = None,
    rolled_back: bool = False,
    applied_scope: Optional[list[str]] = None,
    test_file: Optional[str] = None,
    validation: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "status": status,
        "message": message,
        "events": events,
        "plan_id": (plan or {}).get("plan_id"),
        "backup": backup,
        "actual": actual,
        "rolled_back": rolled_back,
        "applied_scope": applied_scope or [],
        "pending_checks": [] if validation is not None else ["recording_encoder", "short_recording", "ffprobe", "obs_stats"],
        "test_file": test_file,
        "validation": validation,
    }


def _response_data(response: object) -> dict[str, Any]:
    payload = getattr(response, "datain", None)
    if callable(payload):
        payload = payload()
    return payload if isinstance(payload, dict) else {}


def _response_output_active(response: object) -> Optional[bool]:
    """Read an OBS output state without leaking obs-websocket's KeyError.

    obs-websocket-python dynamically creates ``getOutputActive`` and raises a
    KeyError when OBS returns an empty response (for example, for an optional
    output that is unavailable).  ``None`` means that this particular status
    could not be read; it does not mean that the output is active.
    """
    payload = _response_data(response)
    for key in ("outputActive", "output_active", "output-active"):
        if key in payload:
            return bool(payload[key])
    try:
        getter = getattr(response, "getOutputActive", None)
        if callable(getter):
            return bool(getter())
    except (AttributeError, KeyError, TypeError, ValueError):
        pass
    return None


def _active_outputs(ws: Any) -> list[str]:
    checks = [
        ("录制", "GetRecordStatus", True),
        ("直播", "GetStreamStatus", True),
        ("回放缓存", "GetReplayBufferStatus", False),
        ("虚拟摄像机", "GetVirtualCamStatus", False),
    ]
    active: list[str] = []
    for label, request_name, required in checks:
        request_type = getattr(obs_requests, request_name, None)
        if request_type is None:
            if required:
                raise RuntimeError(f"暂时无法读取 OBS 的{label}状态，请重新连接 OBS 后再试。")
            continue
        try:
            response = ws.call(request_type())
        except Exception as exc:  # noqa: BLE001
            if required:
                raise RuntimeError(f"暂时无法读取 OBS 的{label}状态，请重新连接 OBS 后再试。") from exc
            continue
        state = _response_output_active(response)
        if state is None:
            if required:
                raise RuntimeError(f"OBS 没有返回{label}状态，请重新连接 OBS 后再试。")
            # Replay Buffer and Virtual Camera are optional. An empty/failed
            # response means this output is unavailable in the current setup.
            continue
        if state:
            active.append(label)
    return active


def _set_video(ws: Any, video: dict[str, int]) -> None:
    ws.call(
        obs_requests.SetVideoSettings(
            fpsNumerator=int(video["fps_num"]),
            fpsDenominator=int(video["fps_den"]),
            baseWidth=int(video["base_width"]),
            baseHeight=int(video["base_height"]),
            outputWidth=int(video["output_width"]),
            outputHeight=int(video["output_height"]),
        )
    )


def _same_video(left: dict[str, int], right: dict[str, int]) -> bool:
    keys = ("base_width", "base_height", "output_width", "output_height", "fps_num", "fps_den")
    return all(int(left.get(key) or 0) == int(right.get(key) or 0) for key in keys)


def _profile_parameter(ws: Any, category: str, name: str) -> str:
    response = ws.call(
        obs_requests.GetProfileParameter(
            parameterCategory=category,
            parameterName=name,
        )
    )
    return str((getattr(response, "datain", None) or {}).get("parameterValue") or "").strip()


def _set_profile_parameter(ws: Any, category: str, name: str, value: str) -> None:
    ws.call(
        obs_requests.SetProfileParameter(
            parameterCategory=category,
            parameterName=name,
            parameterValue=str(value),
        )
    )


def _encoder_profile_value(encoder: dict[str, Any], *, advanced: bool) -> str:
    encoder_id = str(encoder.get("id") or "").lower()
    mapping = {
        "nvenc_h264": "jim_nvenc",
        "nvenc_hevc": "jim_hevc_nvenc",
        "nvenc_av1": "jim_av1_nvenc",
        "qsv_h264": "obs_qsv11_v2",
        "qsv_hevc": "obs_qsv11_hevc",
        "qsv_av1": "obs_qsv11_av1",
        "amf_h264": "h264_texture_amf",
        "amf_hevc": "h265_texture_amf",
        "amf_av1": "av1_texture_amf",
    }
    value = mapping.get(encoder_id, "")
    if not value:
        raise ValueError("没有可应用的硬件编码器")
    # Current OBS accepts the same registered encoder id in Simple and Advanced modes.
    return value


def _recording_profile_snapshot(ws: Any) -> dict[str, Any]:
    mode_raw = _profile_parameter(ws, "Output", "Mode") or "Simple"
    advanced = mode_raw.lower() == "advanced"
    category = "AdvOut" if advanced else "SimpleOutput"
    names = ["RecEncoder", "RecFormat2"] + ([] if advanced else ["RecQuality"])
    values = {name: _profile_parameter(ws, category, name) for name in names}
    return {
        "output_mode": "Advanced" if advanced else "Simple",
        "category": category,
        "values": values,
    }


def _configure_recording_profile(ws: Any, encoder: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    before = _recording_profile_snapshot(ws)
    category = before["category"]
    advanced = before["output_mode"] == "Advanced"
    target_values = {
        "RecEncoder": _encoder_profile_value(encoder, advanced=advanced),
        "RecFormat2": "hybrid_mp4",
    }
    if not advanced:
        target_values["RecQuality"] = "Small"
    for name, value in target_values.items():
        if before["values"].get(name) != value:
            _set_profile_parameter(ws, category, name, value)
    after = _recording_profile_snapshot(ws)
    mismatches = {
        name: {"expected": value, "actual": after["values"].get(name)}
        for name, value in target_values.items()
        if after["values"].get(name) != value
    }
    if mismatches:
        raise ValueError("OBS 没有接受录像编码设置：" + json.dumps(mismatches, ensure_ascii=False))
    after["encoder_label"] = str(encoder.get("label") or target_values["RecEncoder"])
    return before, after


def _restore_recording_profile(ws: Any, snapshot: Optional[dict[str, Any]]) -> bool:
    if not snapshot:
        return False
    try:
        for name, value in (snapshot.get("values") or {}).items():
            _set_profile_parameter(ws, str(snapshot["category"]), str(name), str(value))
        return True
    except Exception:  # noqa: BLE001
        return False


def _parse_stats(response: object) -> dict[str, float]:
    data = getattr(response, "datain", None) or {}
    stats = data.get("stats") if isinstance(data.get("stats"), dict) else data
    keys = (
        "cpuUsage",
        "memoryUsage",
        "availableDiskSpace",
        "activeFps",
        "averageFrameRenderTime",
        "renderSkippedFrames",
        "renderTotalFrames",
        "outputSkippedFrames",
        "outputTotalFrames",
    )
    out: dict[str, float] = {}
    for key in keys:
        try:
            out[key] = float(stats.get(key) or 0)
        except (TypeError, ValueError):
            out[key] = 0.0
    return out


def _stats_report(before: dict[str, float], after: dict[str, float], target_fps: int) -> dict[str, Any]:
    render_total = max(0.0, after["renderTotalFrames"] - before["renderTotalFrames"])
    render_skipped = max(0.0, after["renderSkippedFrames"] - before["renderSkippedFrames"])
    output_total = max(0.0, after["outputTotalFrames"] - before["outputTotalFrames"])
    output_skipped = max(0.0, after["outputSkippedFrames"] - before["outputSkippedFrames"])
    render_lag = (render_skipped / render_total * 100.0) if render_total else None
    encoding_lag = (output_skipped / output_total * 100.0) if output_total else None
    active_fps = float(after.get("activeFps") or 0)
    return {
        "active_fps": round(active_fps, 2),
        "target_fps": int(target_fps),
        "render_total_frames": int(render_total),
        "render_skipped_frames": int(render_skipped),
        "rendering_lag_percent": round(render_lag, 3) if render_lag is not None else None,
        "output_total_frames": int(output_total),
        "output_skipped_frames": int(output_skipped),
        "encoding_lag_percent": round(encoding_lag, 3) if encoding_lag is not None else None,
        "average_frame_render_time_ms": round(float(after.get("averageFrameRenderTime") or 0), 3),
        "cpu_usage_percent": round(float(after.get("cpuUsage") or 0), 2),
        "metrics_complete": render_lag is not None and encoding_lag is not None and active_fps > 0,
    }


def _wait_record_state(
    ws: Any,
    active: bool,
    *,
    timeout: float = 4.0,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = ws.call(obs_requests.GetRecordStatus())
        last = _response_data(response)
        state = _response_output_active(response)
        if state is None:
            raise RuntimeError("OBS 没有返回录制状态，请重新连接 OBS 后再试。")
        if state is active:
            return last
        sleep_fn(0.1)
    raise RuntimeError("OBS 录像状态确认超时")


def _stop_test_recording(
    ws: Any,
    *,
    obs_cfg: Any,
    connection_factory: ConnectionFactory,
    disconnect: Callable[[Any], None],
    sleep_fn: Callable[[float], None],
) -> str:
    """Stop the test recording without trusting stale state on the command socket.

    OBS can finish and return ``outputPath`` while ``GetRecordStatus`` on the
    same long-lived websocket continues to report the previous active state.
    A successful StopRecord response containing a path is already OBS's
    acknowledgement that the file was finalized.  Only when that response has
    no path (or times out) do we confirm on a fresh websocket connection.
    """
    stop_error: Optional[Exception] = None
    try:
        response = ws.call(obs_requests.StopRecord())
        output_path = str(_response_data(response).get("outputPath") or "").strip()
        if output_path:
            return output_path
    except Exception as exc:  # noqa: BLE001
        stop_error = exc

    confirmation_ws: Any = None
    try:
        confirmation_ws = connection_factory(obs_cfg)
        stopped = _wait_record_state(confirmation_ws, False, sleep_fn=sleep_fn)
        output_path = str(stopped.get("outputPath") or "").strip()
        if output_path:
            return output_path
        raise RuntimeError("OBS 已停止录像，但没有返回测试文件路径")
    except Exception as confirm_error:  # noqa: BLE001
        if stop_error is not None:
            raise RuntimeError("OBS 停止了录像，但没有返回可用的测试文件信息") from stop_error
        raise confirm_error
    finally:
        if confirmation_ws is not None and confirmation_ws is not ws:
            disconnect(confirmation_ws)


def _rate_value(raw: str) -> float:
    try:
        return float(Fraction(str(raw or "0/1")))
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe_recording_file(path: str, ffprobe_path: str) -> dict[str, Any]:
    file_path = Path(path)
    probe = Path(ffprobe_path)
    if not file_path.is_file():
        raise ValueError("OBS 没有返回可读取的测试文件")
    if not probe.is_file():
        raise ValueError("没有找到 ffprobe")
    command = [
        str(probe),
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration,size:format_tags=encoder:stream=index,codec_type,codec_name,codec_long_name,width,height,r_frame_rate,avg_frame_rate,channels,sample_rate:stream_tags=encoder",
        "-of",
        "json",
        str(file_path),
    ]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
        creationflags=creationflags,
    )
    if completed.returncode != 0:
        raise ValueError("ffprobe 无法读取测试文件：" + (completed.stderr or "未知错误").strip()[-300:])
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ffprobe 返回了无效结果") from exc
    streams = raw.get("streams") or []
    videos = [row for row in streams if isinstance(row, dict) and row.get("codec_type") == "video"]
    audios = [row for row in streams if isinstance(row, dict) and row.get("codec_type") == "audio"]
    video = videos[0] if videos else {}
    fmt = raw.get("format") or {}
    return {
        "path": str(file_path),
        "format_name": fmt.get("format_name"),
        "duration_seconds": round(float(fmt.get("duration") or 0), 3),
        "size_bytes": int(fmt.get("size") or file_path.stat().st_size),
        "video": {
            "codec_name": video.get("codec_name"),
            "codec_long_name": video.get("codec_long_name"),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "r_frame_rate": str(video.get("r_frame_rate") or ""),
            "avg_frame_rate": str(video.get("avg_frame_rate") or ""),
            "r_frame_rate_value": round(_rate_value(str(video.get("r_frame_rate") or "")), 4),
            "avg_frame_rate_value": round(_rate_value(str(video.get("avg_frame_rate") or "")), 4),
        },
        "audio_tracks": [
            {
                "index": int(row.get("index") or 0),
                "codec_name": row.get("codec_name"),
                "channels": row.get("channels"),
                "sample_rate": row.get("sample_rate"),
            }
            for row in audios
        ],
        "encoder_tag": ((fmt.get("tags") or {}).get("encoder") or (video.get("tags") or {}).get("encoder")),
    }


def read_obs_log_summary(started_at: float) -> dict[str, Any]:
    appdata = os.environ.get("APPDATA", "").strip()
    logs_dir = Path(appdata) / "obs-studio" / "logs" if appdata else None
    if logs_dir is None or not logs_dir.is_dir():
        return {"available": False, "encoding_overload_mentions": 0, "render_lag_mentions": 0, "nvenc_mentions": 0, "qsv_mentions": 0, "amf_mentions": 0}
    candidates = [p for p in logs_dir.glob("*.txt") if p.is_file()]
    if not candidates:
        return {"available": False, "encoding_overload_mentions": 0, "render_lag_mentions": 0, "nvenc_mentions": 0, "qsv_mentions": 0, "amf_mentions": 0}
    latest = max(candidates, key=lambda p: p.stat().st_mtime)
    if latest.stat().st_mtime < started_at:
        return {"available": True, "path": str(latest), "encoding_overload_mentions": 0, "render_lag_mentions": 0, "nvenc_mentions": 0, "qsv_mentions": 0, "amf_mentions": 0}
    try:
        text = latest.read_text(encoding="utf-8", errors="replace")[-500_000:]
    except OSError:
        return {"available": False, "encoding_overload_mentions": 0, "render_lag_mentions": 0, "nvenc_mentions": 0, "qsv_mentions": 0, "amf_mentions": 0}
    started_local = datetime.fromtimestamp(started_at)
    started_seconds = started_local.hour * 3600 + started_local.minute * 60 + started_local.second
    recent_lines: list[str] = []
    for line in text.splitlines():
        match = re.match(r"\s*(\d{2}):(\d{2}):(\d{2})[\.:]", line)
        if not match:
            continue
        line_seconds = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
        if line_seconds >= max(0, started_seconds - 2):
            recent_lines.append(line)
    lowered = "\n".join(recent_lines).lower()
    overload_patterns = ("encoding overloaded", "encoder is overloaded", "skipped frames due to encoding lag")
    render_patterns = ("lagged frames due to rendering lag", "rendering lag/stalls")
    return {
        "available": True,
        "path": str(latest),
        "checked_after": datetime.fromtimestamp(started_at).isoformat(timespec="seconds"),
        "encoding_overload_mentions": sum(lowered.count(pattern) for pattern in overload_patterns),
        "render_lag_mentions": sum(lowered.count(pattern) for pattern in render_patterns),
        "nvenc_mentions": lowered.count("nvenc"),
        "qsv_mentions": lowered.count("qsv"),
        "amf_mentions": lowered.count("amf"),
    }


def _validation_report(
    *,
    media: dict[str, Any],
    stats: dict[str, Any],
    logs: dict[str, Any],
    target_video: dict[str, int],
    encoder_profile: dict[str, Any],
) -> dict[str, Any]:
    video = media.get("video") or {}
    target_fps = int(target_video["fps_num"])
    media_resolution_ok = int(video.get("width") or 0) == target_video["output_width"] and int(video.get("height") or 0) == target_video["output_height"]
    r_fps_ok = abs(float(video.get("r_frame_rate_value") or 0) - target_fps) <= 0.01
    avg_fps_ok = abs(float(video.get("avg_frame_rate_value") or 0) - target_fps) <= max(0.5, target_fps * 0.01)
    render_lag = stats.get("rendering_lag_percent")
    encoding_lag = stats.get("encoding_lag_percent")
    stats_ok = bool(stats.get("metrics_complete")) and float(render_lag or 0) <= 1.0 and float(encoding_lag or 0) <= 1.0 and float(stats.get("active_fps") or 0) >= target_fps * 0.97
    logs_ok = int(logs.get("encoding_overload_mentions") or 0) == 0 and int(logs.get("render_lag_mentions") or 0) == 0
    encoder_value = str((encoder_profile.get("values") or {}).get("RecEncoder") or "")
    encoder_label = str(encoder_profile.get("encoder_label") or "")
    if "NVIDIA" in encoder_label:
        encoder_ok = "nvenc" in encoder_value.lower() and int(logs.get("nvenc_mentions") or 0) > 0
    elif "QSV" in encoder_label or "Intel" in encoder_label:
        encoder_ok = "qsv" in encoder_value.lower() and int(logs.get("qsv_mentions") or 0) > 0
    elif "AMD" in encoder_label or "AMF" in encoder_label:
        encoder_ok = "amf" in encoder_value.lower() and int(logs.get("amf_mentions") or 0) > 0
    else:
        encoder_ok = bool(encoder_value)
    passed = media_resolution_ok and r_fps_ok and avg_fps_ok and stats_ok and logs_ok and encoder_ok
    reasons: list[str] = []
    if not media_resolution_ok:
        reasons.append("测试文件分辨率与目标不一致")
    if not r_fps_ok or not avg_fps_ok:
        reasons.append("测试文件帧率与目标不一致")
    if not stats_ok:
        reasons.append("OBS 实时 FPS 或掉帧指标未达标")
    if not logs_ok:
        reasons.append("OBS 日志发现编码或渲染过载")
    if not encoder_ok:
        reasons.append("硬件编码器没有确认生效")
    return {
        "passed": passed,
        "verdict": "stable" if passed else "unstable",
        "media_resolution_ok": media_resolution_ok,
        "r_frame_rate_ok": r_fps_ok,
        "avg_frame_rate_ok": avg_fps_ok,
        "stats_ok": stats_ok,
        "logs_ok": logs_ok,
        "encoder_ok": encoder_ok,
        "reasons": reasons,
        "minimum_adjustment": None if passed else "保持分辨率不变，先将目标 FPS 调低一档后重新测试；不会自动替你修改。",
    }


def apply_video_tuning_plan(
    app_cfg: Any,
    request: ObsTuningApplyRequest,
    *,
    discovery_loader: DiscoveryLoader = discover_environment,
    connection_factory: ConnectionFactory = _connect_for_tuning,
    disconnect: Callable[[Any], None] = obs_config_center._ws_disconnect,
    backup_creator: BackupCreator = obs_config_center.create_active_profile_backup,
    sleep_fn: Callable[[float], None] = time.sleep,
    media_probe: MediaProbe = probe_recording_file,
    log_reader: LogReader = read_obs_log_summary,
) -> dict[str, Any]:
    """Revalidate, back up, configure, short-record, probe and report."""
    events: list[dict[str, str]] = []
    backup: Optional[dict[str, str]] = None
    recording_before: Optional[dict[str, Any]] = None
    ws: Any = None

    try:
        discovery = discovery_loader(app_cfg)
        recommendation = recommend(request.goal, discovery)
        plan = build_change_plan(request.goal, discovery, recommendation)
        if not bool((discovery.get("obs") or {}).get("connected")):
            events.append(_event("recheck", "重新检查 OBS 连接", "blocked", "OBS 已关闭或连接已经断开。"))
            return _result(
                ok=False,
                status="connection_lost",
                message="现在没有连接到 OBS。请重新打开并连接 OBS 后再试，尚未修改任何设置。",
                events=events,
                plan=plan,
            )
        if plan["plan_hash"] != request.plan_hash:
            events.append(_event("recheck", "重新检查电脑和 OBS", "blocked", "设置已经发生变化，请重新确认推荐设置。"))
            return _result(
                ok=False,
                status="stale_plan",
                message="OBS 设置已经变化，未进行修改。请返回重新确认。",
                events=events,
                plan=plan,
            )
        if not plan.get("can_apply"):
            blockers = list(plan.get("blockers") or [])
            detail = "；".join(blockers) or "执行条件尚未准备好"
            events.append(_event("recheck", "检查执行条件", "blocked", detail))
            return _result(
                ok=False,
                status="requirements_missing",
                message=detail + "。尚未修改任何设置。",
                events=events,
                plan=plan,
            )
        events.append(_event("recheck", "重新检查电脑和 OBS", "ok", "连接正常，确认内容没有变化。"))

        try:
            ws = connection_factory(app_cfg.obs)
        except Exception as exc:  # noqa: BLE001
            events.append(_event("idle", "检查 OBS 是否正在录制或直播", "failed", "与 OBS 的连接刚刚中断。"))
            return _result(
                ok=False,
                status="connection_failed",
                message="刚刚与 OBS 的连接中断了，未进行修改。",
                events=events,
                plan=plan,
            )

        try:
            active = _active_outputs(ws)
        except Exception as exc:  # noqa: BLE001
            events.append(_event("idle", "检查 OBS 是否正在录制或直播", "failed", str(exc)))
            return _result(
                ok=False,
                status="precheck_failed",
                message="暂时没有读到 OBS 的录制/直播状态，因此没有修改设置。请重新连接 OBS 后再试。",
                events=events,
                plan=plan,
            )
        if active:
            detail = "、".join(active) + "仍在运行"
            events.append(_event("idle", "检查 OBS 是否正在录制或直播", "blocked", detail))
            return _result(
                ok=False,
                status="output_active",
                message=f"请先停止 OBS 的{'、'.join(active)}，然后再试。",
                events=events,
                plan=plan,
            )
        events.append(_event("idle", "检查 OBS 是否正在录制或直播", "ok", "OBS 当前没有录制、直播或运行其他输出，可以安全修改。"))

        current = obs_config_center._parse_ws_video(ws.call(obs_requests.GetVideoSettings()))
        if not current["base_width"] or not current["base_height"]:
            events.append(_event("backup", "保存现在的设置", "failed", "没有读到有效的画布分辨率。"))
            return _result(
                ok=False,
                status="precheck_failed",
                message="没有读到 OBS 当前画面大小，未进行修改。",
                events=events,
                plan=plan,
            )

        discovered_video = ((discovery.get("obs") or {}).get("video") or {})
        expected_current = {
            key: int(discovered_video.get(key) or current[key])
            for key in ("base_width", "base_height", "output_width", "output_height", "fps_num", "fps_den")
        }
        if not _same_video(current, expected_current):
            events.append(_event("recheck", "重新检查电脑和 OBS", "blocked", "读取期间 OBS 视频设置又发生了变化。"))
            return _result(
                ok=False,
                status="environment_changed",
                message="OBS 设置刚刚发生了变化，未进行修改。请重新确认。",
                events=events,
                plan=plan,
            )

        try:
            backup = backup_creator()
        except Exception as exc:  # noqa: BLE001
            events.append(_event("backup", "保存现在的设置", "failed", str(exc)))
            return _result(
                ok=False,
                status="backup_failed",
                message="原设置没有备份成功，因此没有继续修改。",
                events=events,
                plan=plan,
            )
        events.append(_event("backup", "保存现在的设置", "ok", "已经创建恢复点。"))

        target = recommendation["target"]
        target_video = {
            "base_width": current["base_width"],
            "base_height": current["base_height"],
            "output_width": int(target["width"]),
            "output_height": int(target["height"]),
            "fps_num": int(target["fps_num"]),
            "fps_den": 1,
        }
        try:
            _set_video(ws, target_video)
            events.append(
                _event(
                    "apply",
                    "应用分辨率和帧率",
                    "ok",
                    f"已请求设置为 {target_video['output_width']}×{target_video['output_height']}、{target_video['fps_num']} FPS。",
                )
            )
        except Exception as exc:  # noqa: BLE001
            rolled_back = False
            try:
                _set_video(ws, current)
                rolled_back = True
            except Exception:  # noqa: BLE001
                pass
            events.append(_event("apply", "应用分辨率和帧率", "failed", str(exc)))
            return _result(
                ok=False,
                status="apply_failed",
                message="OBS 没有接受新设置。" + ("已恢复原来的视频设置。" if rolled_back else "请使用恢复点还原。"),
                events=events,
                plan=plan,
                backup=backup,
                rolled_back=rolled_back,
            )

        try:
            actual = obs_config_center._parse_ws_video(ws.call(obs_requests.GetVideoSettings()))
        except Exception as exc:  # noqa: BLE001
            rolled_back = False
            try:
                _set_video(ws, current)
                rolled_back = True
            except Exception:  # noqa: BLE001
                pass
            events.append(_event("verify", "确认设置已经生效", "failed", str(exc)))
            return _result(
                ok=False,
                status="verification_failed",
                message="无法读取修改后的实际设置。" + ("已恢复原来的视频设置。" if rolled_back else "请使用恢复点还原。"),
                events=events,
                plan=plan,
                backup=backup,
                rolled_back=rolled_back,
            )
        if not _same_video(actual, target_video):
            rolled_back = False
            try:
                _set_video(ws, current)
                rolled_back = _same_video(
                    obs_config_center._parse_ws_video(ws.call(obs_requests.GetVideoSettings())),
                    current,
                )
            except Exception:  # noqa: BLE001
                pass
            events.append(_event("verify", "确认设置已经生效", "failed", "OBS 回读值与目标不一致。"))
            return _result(
                ok=False,
                status="verification_failed",
                message="设置没有完整生效。" + ("已恢复原来的视频设置。" if rolled_back else "请使用恢复点还原。"),
                events=events,
                plan=plan,
                backup=backup,
                actual={"video": actual},
                rolled_back=rolled_back,
            )

        events.append(
            _event(
                "verify",
                "确认设置已经生效",
                "ok",
                f"实际为 {actual['output_width']}×{actual['output_height']}、{actual['fps_num']}/{actual['fps_den']} FPS。",
            )
        )

        applied_scope = ["video.fps", "video.output_resolution"]
        try:
            recording_before = _recording_profile_snapshot(ws)
            _, recording_actual = _configure_recording_profile(ws, target["encoder"])
            applied_scope.extend(["recording.encoder", "recording.format"])
            events.append(
                _event(
                    "encoder",
                    "设置显卡录制方式",
                    "ok",
                    f"已回读确认 {recording_actual['encoder_label']}，容器为 Hybrid MP4。",
                )
            )
        except Exception as exc:  # noqa: BLE001
            restored_profile = _restore_recording_profile(ws, recording_before)
            restored_video = False
            try:
                _set_video(ws, current)
                restored_video = True
            except Exception:  # noqa: BLE001
                pass
            events.append(_event("encoder", "设置显卡录制方式", "failed", str(exc)))
            return _result(
                ok=False,
                status="encoder_apply_failed",
                message="录像编码设置没有完整生效。" + ("已恢复原设置。" if restored_profile and restored_video else "请使用恢复点还原。"),
                events=events,
                plan=plan,
                backup=backup,
                actual={"video": actual},
                rolled_back=restored_profile and restored_video,
                applied_scope=applied_scope,
            )

        test_started_at = time.time()
        output_path = ""
        record_started = False
        stop_attempted = False
        stats_before: dict[str, float] = {}
        stats_after: dict[str, float] = {}
        try:
            get_stats = getattr(obs_requests, "GetStats", None)
            if get_stats is None:
                raise RuntimeError("当前 OBS 连接组件不支持读取 Stats")
            stats_before = _parse_stats(ws.call(get_stats()))
            ws.call(obs_requests.StartRecord())
            record_started = True
            _wait_record_state(ws, True, sleep_fn=sleep_fn)
            events.append(
                _event(
                    "record",
                    "进行短录制测试",
                    "running",
                    f"正在按目标设置录制 {request.goal.test_seconds} 秒。",
                )
            )
            logger.info(
                "OBS tuning short recording started: seconds=%s target=%sx%s@%s/%s",
                request.goal.test_seconds,
                target_video["output_width"],
                target_video["output_height"],
                target_video["fps_num"],
                target_video["fps_den"],
            )
            sleep_fn(float(request.goal.test_seconds))
            stats_after = _parse_stats(ws.call(get_stats()))
            stop_attempted = True
            output_path = _stop_test_recording(
                ws,
                obs_cfg=app_cfg.obs,
                connection_factory=connection_factory,
                disconnect=disconnect,
                sleep_fn=sleep_fn,
            )
            record_started = False
            logger.info("OBS tuning short recording stopped: output=%s", output_path)
            events[-1] = _event("record", "进行短录制测试", "ok", f"已完成 {request.goal.test_seconds} 秒测试录制。")
        except Exception as exc:  # noqa: BLE001
            logger.warning("OBS tuning short recording failed: %s", exc)
            if record_started and not stop_attempted:
                try:
                    output_path = _stop_test_recording(
                        ws,
                        obs_cfg=app_cfg.obs,
                        connection_factory=connection_factory,
                        disconnect=disconnect,
                        sleep_fn=sleep_fn,
                    )
                except Exception:  # noqa: BLE001
                    pass
            events.append(_event("record", "进行短录制测试", "failed", str(exc)))
            return _result(
                ok=False,
                status="recording_test_failed",
                message="OBS 设置已经写入，但短录制没有完成。不会自动降低分辨率或 FPS。",
                events=events,
                plan=plan,
                backup=backup,
                actual={"video": actual, "recording": recording_actual},
                applied_scope=applied_scope,
                test_file=output_path or None,
            )

        try:
            sleep_fn(0.4)
            logger.info("OBS tuning validating test file: output=%s", output_path)
            media = media_probe(output_path, str((discovery.get("ffmpeg") or {}).get("ffprobe_path") or ""))
            stats = _stats_report(stats_before, stats_after, int(target_video["fps_num"]))
            logs = log_reader(test_started_at)
            validation = _validation_report(
                media=media,
                stats=stats,
                logs=logs,
                target_video=target_video,
                encoder_profile=recording_actual,
            )
            events.append(
                _event(
                    "probe",
                    "检查测试视频和掉帧",
                    "ok" if validation["passed"] else "failed",
                    "ffprobe、OBS Stats 与日志检查完成。",
                )
            )
            logger.info("OBS tuning validation finished: passed=%s", validation["passed"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("OBS tuning validation failed: %s", exc)
            events.append(_event("probe", "检查测试视频和掉帧", "failed", str(exc)))
            return _result(
                ok=False,
                status="validation_failed",
                message="测试视频已经生成，但媒体或掉帧验收没有完成。",
                events=events,
                plan=plan,
                backup=backup,
                actual={"video": actual, "recording": recording_actual},
                applied_scope=applied_scope,
                test_file=output_path,
            )

        passed = bool(validation["passed"])
        return _result(
            ok=passed,
            status="passed" if passed else "unstable",
            message=(
                f"已完成真实短录制，稳定达到 {target_video['fps_num']} FPS。"
                if passed
                else f"设置与测试已完成，但没有稳定达到 {target_video['fps_num']} FPS；未自动降级。"
            ),
            events=events,
            plan=plan,
            backup=backup,
            actual={
                "video": actual,
                "recording": recording_actual,
                "ffprobe": media,
                "stats": stats,
                "logs": logs,
            },
            applied_scope=applied_scope,
            test_file=output_path,
            validation=validation,
        )
    finally:
        if ws is not None:
            disconnect(ws)
