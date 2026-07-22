"""OBS AI 调优的只读探测、确定性推荐与变更计划。

本模块刻意不执行 OBS 写操作。它为设置页提供真实环境快照和可审计的推荐结果，
后续执行器必须重新探测环境、校验 plan_hash，并在备份成功后才能应用变更。
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from . import obs_config_center
from .env_utils import detect_obs_path, get_data_dir


class ObsTuningGoal(BaseModel):
    resolution: Literal["current", "four-three", "full-hd", "custom"] = "current"
    output_width: Optional[int] = Field(default=None, ge=320, le=16384)
    output_height: Optional[int] = Field(default=None, ge=240, le=8640)
    fps: int = Field(default=240, ge=1, le=1000)
    use_case: Literal["slowmo", "highlight", "archive"] = "slowmo"
    priority: Literal["quality", "balanced", "performance"] = "balanced"
    codec: Literal["auto", "h264", "hevc", "av1"] = "auto"
    test_seconds: int = Field(default=10, ge=5, le=120)

    @field_validator("fps")
    @classmethod
    def _integer_fps(cls, value: int) -> int:
        if isinstance(value, bool) or int(value) != value:
            raise ValueError("FPS 必须是整数")
        return int(value)

    @model_validator(mode="after")
    def _custom_resolution_complete(self):
        if self.resolution == "custom" and (self.output_width is None or self.output_height is None):
            raise ValueError("自定义分辨率必须同时提供宽度和高度")
        return self


class ObsTuningRecommendationRequest(BaseModel):
    goal: ObsTuningGoal
    discovery: Optional[dict[str, Any]] = None


class ObsTuningPlanRequest(BaseModel):
    goal: ObsTuningGoal


class ObsTuningApplyRequest(BaseModel):
    goal: ObsTuningGoal
    plan_hash: str = Field(min_length=16, max_length=128)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_run(args: list[str], *, timeout: float = 5.0) -> str:
    try:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            creationflags=creationflags,
        )
        return proc.stdout.strip() if proc.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _detect_windows_hardware() -> dict[str, Any]:
    shell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not shell:
        return {}
    script = (
        "$g=@(Get-CimInstance Win32_VideoController | ForEach-Object {"
        "[pscustomobject]@{name=$_.Name;adapter_ram=$_.AdapterRAM;driver_version=$_.DriverVersion}});"
        "$c=Get-CimInstance Win32_Processor | Select-Object -First 1;"
        "$s=Get-CimInstance Win32_ComputerSystem;"
        "[pscustomobject]@{gpus=$g;cpu=$c.Name;memory_bytes=$s.TotalPhysicalMemory}"
        "| ConvertTo-Json -Compress -Depth 4"
    )
    raw = _safe_run([shell, "-NoProfile", "-NonInteractive", "-Command", script], timeout=8.0)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _nvidia_details() -> list[dict[str, Any]]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    raw = _safe_run(
        [
            exe,
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader,nounits",
        ],
        timeout=5.0,
    )
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        parts = [item.strip() for item in line.split(",")]
        if not parts or not parts[0]:
            continue
        try:
            memory_mb = int(parts[2]) if len(parts) > 2 else None
        except ValueError:
            memory_mb = None
        rows.append(
            {
                "name": parts[0],
                "driver_version": parts[1] if len(parts) > 1 else "",
                "memory_mb": memory_mb,
            }
        )
    return rows


def _normalise_gpu_rows(raw: object) -> list[dict[str, Any]]:
    rows = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        try:
            adapter_bytes = int(row.get("adapter_ram") or 0)
        except (TypeError, ValueError):
            adapter_bytes = 0
        out.append(
            {
                "name": name,
                "driver_version": str(row.get("driver_version") or "").strip(),
                "memory_mb": round(adapter_bytes / (1024 * 1024)) if adapter_bytes else None,
            }
        )
    return out


def _merge_nvidia_rows(gpus: list[dict[str, Any]], nvidia: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not nvidia:
        return gpus
    merged = list(gpus)
    for row in nvidia:
        match = next((item for item in merged if item["name"].lower() == row["name"].lower()), None)
        if match:
            match.update({key: value for key, value in row.items() if value not in (None, "")})
        else:
            merged.append(row)
    return merged


def _prioritize_gpu_rows(gpus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Put the GPU most likely used for gameplay/encoding first on hybrid systems."""

    def priority(row: dict[str, Any]) -> tuple[int, int, int, int]:
        name = str(row.get("name") or "").lower()
        try:
            memory_mb = int(row.get("memory_mb") or 0)
        except (TypeError, ValueError):
            memory_mb = 0
        discrete_name = bool(
            re.search(r"\b(rtx|gtx|quadro|titan)\b", name)
            or re.search(r"\bradeon\s+rx\b", name)
            or re.search(r"\bintel\s+arc\b", name)
        )
        integrated_name = bool(
            "radeon(tm) graphics" in name
            or re.search(r"\b(uhd|iris)\b", name)
            or "integrated" in name
        )
        return (
            1 if discrete_name else 0,
            0 if integrated_name else 1,
            memory_mb,
            1 if "nvidia" in name or "geforce" in name else 0,
        )

    return sorted(gpus, key=priority, reverse=True)


def detect_hardware() -> dict[str, Any]:
    win = _detect_windows_hardware() if sys.platform == "win32" else {}
    gpus = _normalise_gpu_rows(win.get("gpus"))
    gpus = _prioritize_gpu_rows(_merge_nvidia_rows(gpus, _nvidia_details()))
    cpu = str(win.get("cpu") or platform.processor() or platform.machine() or "未知处理器").strip()
    try:
        memory_bytes = int(win.get("memory_bytes") or 0)
    except (TypeError, ValueError):
        memory_bytes = 0

    return {
        "cpu": cpu,
        "logical_cores": os.cpu_count() or 0,
        "memory_bytes": memory_bytes or None,
        "memory_gb": round(memory_bytes / (1024**3), 1) if memory_bytes else None,
        "gpus": gpus,
    }


def infer_hardware_encoders(gpus: list[dict[str, Any]], current_encoder: str = "") -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}

    def add(encoder_id: str, label: str, codec: str, confidence: str = "inferred") -> None:
        found.setdefault(
            encoder_id,
            {"id": encoder_id, "label": label, "codec": codec, "confidence": confidence},
        )

    for gpu in gpus:
        name = str(gpu.get("name") or "")
        low = name.lower()
        if "nvidia" in low or "geforce" in low or "quadro" in low or "rtx" in low:
            add("nvenc_h264", "NVIDIA NVENC H.264", "h264")
            add("nvenc_hevc", "NVIDIA NVENC HEVC", "hevc")
            if re.search(r"\brtx\s*(40|50)\d{2}\b", low) or "ada" in low or "blackwell" in low:
                add("nvenc_av1", "NVIDIA NVENC AV1", "av1")
        if "amd" in low or "radeon" in low:
            add("amf_h264", "AMD AMF H.264", "h264")
            add("amf_hevc", "AMD AMF HEVC", "hevc")
            if re.search(r"\brx\s*(7|9)\d{3}\b", low):
                add("amf_av1", "AMD AMF AV1", "av1")
        if "intel" in low or " arc" in low:
            add("qsv_h264", "Intel QSV H.264", "h264")
            add("qsv_hevc", "Intel QSV HEVC", "hevc")
            if "arc" in low:
                add("qsv_av1", "Intel QSV AV1", "av1")

    current_low = current_encoder.lower()
    if "nvenc" in current_low:
        add("nvenc_h264", "NVIDIA NVENC（当前 OBS）", "h264", "observed")
    elif "qsv" in current_low:
        add("qsv_h264", "Intel QSV（当前 OBS）", "h264", "observed")
    elif "amf" in current_low:
        add("amf_h264", "AMD AMF（当前 OBS）", "h264", "observed")

    priority = {"nvenc_av1": 0, "nvenc_hevc": 1, "nvenc_h264": 2, "qsv_av1": 3, "amf_av1": 4}
    return sorted(found.values(), key=lambda item: (priority.get(item["id"], 20), item["label"]))


def _nearest_existing_path(raw: str) -> Path:
    path = Path(raw).expanduser() if raw else get_data_dir()
    if path.is_file():
        path = path.parent
    while not path.exists() and path.parent != path:
        path = path.parent
    return path if path.exists() else get_data_dir()


def _disk_payload(recording_path: str) -> dict[str, Any]:
    target = _nearest_existing_path(recording_path)
    try:
        usage = shutil.disk_usage(target)
        return {
            "path": str(target),
            "free_bytes": int(usage.free),
            "free_gb": round(usage.free / (1024**3), 1),
        }
    except OSError:
        return {"path": str(target), "free_bytes": None, "free_gb": None}


def _ffmpeg_payload(configured_path: str) -> dict[str, Any]:
    configured = (configured_path or "").strip()
    resolved = configured if configured and Path(configured).is_file() else shutil.which("ffmpeg") or ""
    ffprobe = ""
    if resolved:
        sibling = Path(resolved).with_name("ffprobe.exe" if sys.platform == "win32" else "ffprobe")
        ffprobe = str(sibling) if sibling.is_file() else shutil.which("ffprobe") or ""
    return {
        "configured_path": configured,
        "resolved_path": resolved,
        "usable": bool(resolved),
        "ffprobe_path": ffprobe,
        "ffprobe_usable": bool(ffprobe),
    }


def discover_environment(app_cfg, *, status_loader=None, hardware_loader=None) -> dict[str, Any]:
    status_fn = status_loader or obs_config_center.get_status_payload
    hardware_fn = hardware_loader or detect_hardware
    status = status_fn(app_cfg.obs)
    hardware = hardware_fn()
    gpus = _prioritize_gpu_rows(list(hardware.get("gpus") or []))
    hardware = {**hardware, "gpus": gpus, "primary_gpu": gpus[0] if gpus else None}
    configured_obs = str(app_cfg.obs.obs_path or "").strip()
    detected_obs = configured_obs if configured_obs and Path(configured_obs).is_file() else detect_obs_path() or ""
    recording = status.get("recording") if isinstance(status.get("recording"), dict) else {}
    current_encoder = str(recording.get("encoder") or "")
    encoders = infer_hardware_encoders(gpus, current_encoder)

    return {
        "ok": True,
        "checked_at": _utc_now(),
        "obs": {
            "install_path": detected_obs,
            "install_detected": bool(detected_obs),
            "connected": bool(status.get("obs_connected")),
            "version": status.get("obs_version"),
            "host": str(app_cfg.obs.host or "localhost"),
            "port": int(app_cfg.obs.port or 4455),
            "password_configured": bool(str(app_cfg.obs.password or "").strip()),
            "config_dir": status.get("obs_config_dir"),
            "active_profile": status.get("active_profile"),
            "active_scene_collection": status.get("active_scene_collection"),
            "video": status.get("video") or {},
            "recording": recording,
            "scene": status.get("scene") or {},
            "ws_error": status.get("ws_error"),
        },
        "hardware": {
            **hardware,
            "encoders": encoders,
        },
        "disk": _disk_payload(str(recording.get("output_path") or "")),
        "ffmpeg": _ffmpeg_payload(str(app_cfg.ffmpeg_path or "")),
        "limits": {
            "game_fps_p10": None,
            "game_fps_source": "not_measured",
            "prediction_is_stability_result": False,
        },
    }


def _gpu_capacity(gpus: list[dict[str, Any]], codec: str) -> tuple[float, str]:
    joined = " ".join(str(item.get("name") or "") for item in gpus).lower()
    if re.search(r"\brtx\s*50\d{2}\b", joined):
        base, tier = 2300.0, "NVIDIA RTX 50 系"
    elif re.search(r"\brtx\s*40\d{2}\b", joined):
        base, tier = 1650.0, "NVIDIA RTX 40 系"
    elif re.search(r"\brtx\s*30\d{2}\b", joined):
        base, tier = 1050.0, "NVIDIA RTX 30 系"
    elif "nvidia" in joined or "geforce" in joined or "quadro" in joined:
        base, tier = 650.0, "NVIDIA GPU"
    elif re.search(r"\brx\s*(7|9)\d{3}\b", joined) or "arc" in joined:
        base, tier = 1250.0, "现代硬件编码 GPU"
    elif joined:
        base, tier = 620.0, "已识别 GPU"
    else:
        base, tier = 420.0, "未知 GPU"
    codec_factor = {"h264": 1.0, "hevc": 0.88, "av1": 0.78}.get(codec, 1.0)
    return base * codec_factor, tier


def _goal_dimensions(goal: ObsTuningGoal, discovery: dict[str, Any]) -> tuple[int, int]:
    if goal.resolution == "four-three":
        return 1920, 1440
    if goal.resolution == "full-hd":
        return 1920, 1080
    if goal.resolution == "custom":
        return int(goal.output_width or 1920), int(goal.output_height or 1080)
    video = (((discovery.get("obs") or {}).get("video")) or {})
    width = int(video.get("output_width") or video.get("base_width") or 1920)
    height = int(video.get("output_height") or video.get("base_height") or 1080)
    return width, height


def _select_codec(goal: ObsTuningGoal, encoders: list[dict[str, Any]]) -> tuple[str, Optional[dict[str, Any]]]:
    by_codec: dict[str, list[dict[str, Any]]] = {}
    for item in encoders:
        by_codec.setdefault(str(item.get("codec") or ""), []).append(item)
    if goal.codec != "auto":
        rows = by_codec.get(goal.codec) or []
        return goal.codec, rows[0] if rows else None
    for codec in ("h264", "hevc", "av1"):
        rows = by_codec.get(codec) or []
        if rows:
            return codec, rows[0]
    return "h264", None


def recommend(goal: ObsTuningGoal, discovery: dict[str, Any]) -> dict[str, Any]:
    width, height = _goal_dimensions(goal, discovery)
    encoders = (((discovery.get("hardware") or {}).get("encoders")) or [])
    codec, encoder = _select_codec(goal, encoders)
    gpus = (((discovery.get("hardware") or {}).get("gpus")) or [])
    capacity, gpu_tier = _gpu_capacity(gpus, codec)
    megapixels_per_second = width * height * goal.fps / 1_000_000
    quality_factor = {"quality": 1.15, "balanced": 1.0, "performance": 0.86}[goal.priority]
    encoder_load = min(99, max(5, round(megapixels_per_second * quality_factor / capacity * 100)))
    render_capacity = capacity * 1.08
    render_load = min(99, max(5, round(megapixels_per_second / render_capacity * 100)))
    headroom = max(0, 100 - max(encoder_load, render_load))

    missing_gpu = not bool(gpus)
    missing_encoder = encoder is None
    missing_game_baseline = not bool(((discovery.get("limits") or {}).get("game_fps_p10")))
    score = 100
    score -= max(0, encoder_load - 58) * 1.05
    score -= max(0, render_load - 62) * 1.2
    score -= 15 if goal.fps >= 480 else 7 if goal.fps >= 360 else 0
    score -= 8 if goal.use_case == "archive" and goal.fps > 240 else 0
    score -= 12 if missing_encoder else 0
    score -= 8 if missing_gpu else 0
    score = max(18, min(96, round(score)))

    if score < 48:
        level, label, verdict = "not_recommended", "不推荐直接使用", "预计渲染或编码余量不足，建议先测试保守起点。"
    elif score < 72:
        level, label, verdict = "experimental", "探索性", "理论可行，但必须通过动态场景短录制验证。"
    elif score < 88:
        level, label, verdict = "recommended_with_test", "有条件推荐", "预计可用，建议先完成 10 秒和 60 秒两级测试。"
    else:
        level, label, verdict = "recommended", "推荐", "预计余量充足，适合作为首次短录制测试目标。"

    risks: list[str] = []
    if encoder_load >= 80:
        risks.append("硬件编码吞吐接近上限")
    if render_load >= 80:
        risks.append("GPU 渲染与编码并发余量偏低")
    if missing_encoder:
        risks.append(f"未确认本机存在可用的 {codec.upper()} 硬件编码器")
    if missing_game_baseline:
        risks.append("尚未采集 CS2 P10/P1 帧率，无法判断素材是否包含足够的独立画面")
    if goal.fps > 240:
        risks.append("超高帧率对场景复杂度、插件与后处理链更敏感")

    fallback_fps = goal.fps
    while fallback_fps > 60:
        fallback_rate = width * height * fallback_fps / 1_000_000
        fallback_load = fallback_rate * quality_factor / capacity * 100
        if fallback_load <= 65 and fallback_fps <= 360:
            break
        fallback_fps = 360 if fallback_fps > 360 else 240 if fallback_fps > 240 else 120 if fallback_fps > 120 else 60
    fallback_width, fallback_height = width, height
    if fallback_fps < goal.fps and width * height > 1920 * 1080 and score < 48:
        fallback_width, fallback_height = 1920, 1080

    codec_size_factor = {"h264": 1.0, "hevc": 0.76, "av1": 0.66}[codec]
    bitrate_mbps = 35 * (width * height / (1920 * 1080)) * (goal.fps / 60) * codec_size_factor * quality_factor
    size_gb = bitrate_mbps * 600 / 8 / 1000
    file_size = {"low_gb_per_10_min": round(size_gb * 0.72, 1), "high_gb_per_10_min": round(size_gb * 1.35, 1)}

    confidence = "low" if missing_gpu or missing_encoder else "medium" if missing_game_baseline else "high"
    return {
        "score": score,
        "level": level,
        "label": label,
        "verdict": verdict,
        "confidence": confidence,
        "prediction_only": True,
        "target": {
            "width": width,
            "height": height,
            "fps_num": goal.fps,
            "fps_den": 1,
            "codec": codec,
            "encoder": encoder,
        },
        "loads": {
            "render_percent": render_load,
            "encoder_percent": encoder_load,
            "headroom_percent": headroom,
            "megapixels_per_second": round(megapixels_per_second, 1),
        },
        "bottleneck": "GPU 渲染与编码并发" if render_load >= encoder_load else f"{codec.upper()} 硬件编码",
        "gpu_tier": gpu_tier,
        "risks": risks,
        "file_size": file_size,
        "safer_start": {
            "width": fallback_width,
            "height": fallback_height,
            "fps_num": fallback_fps,
            "fps_den": 1,
        },
    }


def build_change_plan(goal: ObsTuningGoal, discovery: dict[str, Any], recommendation: dict[str, Any]) -> dict[str, Any]:
    obs = discovery.get("obs") or {}
    current_video = obs.get("video") or {}
    current_recording = obs.get("recording") or {}
    target = recommendation["target"]
    video_ready = all(
        int(current_video.get(key) or 0) > 0
        for key in ("base_width", "base_height", "output_width", "output_height", "fps_num", "fps_den")
    )
    current_fps_num = int(current_video.get("fps_num") or current_video.get("fps") or 0)
    current_fps_den = int(current_video.get("fps_den") or 1)
    changes = [
        {
            "key": "video.fps",
            "current": f"{current_fps_num}/{current_fps_den}" if current_fps_num else "未知",
            "target": f"{target['fps_num']}/1",
            "method": "obs-websocket:SetVideoSettings",
            "phase": "now",
        },
        {
            "key": "video.output_resolution",
            "current": f"{int(current_video.get('output_width') or 0)}×{int(current_video.get('output_height') or 0)}",
            "target": f"{target['width']}×{target['height']}",
            "method": "obs-websocket:SetVideoSettings",
            "phase": "now",
        },
        {
            "key": "recording.encoder",
            "current": str(current_recording.get("encoder") or "未知"),
            "target": str((target.get("encoder") or {}).get("label") or "硬件编码器不可用"),
            "method": "obs-websocket:SetProfileParameter",
            "phase": "now",
        },
        {
            "key": "recording.format",
            "current": str(current_recording.get("format") or "未知"),
            "target": "Hybrid MP4（异常中断可恢复）",
            "method": "obs-websocket:SetProfileParameter",
            "phase": "now",
        },
    ]
    ffprobe_ready = bool((discovery.get("ffmpeg") or {}).get("ffprobe_usable"))
    encoder_ready = bool(target.get("encoder"))
    stable_snapshot = {
        "obs_connected": bool(obs.get("connected")),
        "active_profile": obs.get("active_profile"),
        "video": current_video,
        "recording": {
            "output_mode": current_recording.get("output_mode"),
            "encoder": current_recording.get("encoder"),
            "format": current_recording.get("format"),
            "rec_quality": current_recording.get("rec_quality"),
        },
        "goal": goal.model_dump(),
        "recommendation_target": target,
    }
    plan_hash = hashlib.sha256(
        json.dumps(stable_snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "plan_id": f"obs_{plan_hash[:12]}",
        "plan_hash": plan_hash,
        "created_at": _utc_now(),
        "can_apply": bool(obs.get("connected")) and video_ready and encoder_ready and ffprobe_ready,
        "blockers": [
            *([] if obs.get("connected") else ["OBS WebSocket 尚未连接"]),
            *([] if not obs.get("connected") or video_ready else ["没有读到 OBS 当前视频设置"]),
            *([] if encoder_ready else ["没有识别到可用的硬件编码器"]),
            *([] if ffprobe_ready else ["没有找到 ffprobe，无法验收测试文件"]),
        ],
        "changes": changes,
        "apply_scope": ["video.fps", "video.output_resolution", "recording.encoder", "recording.format"],
        "deferred_checks": [],
        "protected_fields": [
            "audio.sample_rate",
            "audio.channels",
            "audio.track_mapping",
            "stream.service",
            "stream.key",
            "scene_collection",
            "websocket.password",
            "ffmpeg.path",
            "montage.encoder",
        ],
        "safety_guards": [
            "执行前重新探测并校验 plan_hash",
            "检测录制、串流、回放缓冲和虚拟摄像机均已停止",
            "任何写入前创建 Profile 与 global.ini 备份",
            "写入后回读 FPS、分辨率与录像编码器",
            "失败时不静默降低 FPS 或分辨率",
        ],
        "recommendation": recommendation,
    }
