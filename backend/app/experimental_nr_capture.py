"""实验性「游戏内神经重画」录制后端（HLAE + ReShade/OpenNR 抓帧）。

社区版默认用 OBS 采集屏幕。实验档改为复用 **CIAP Pro 的 HLAE 1000fps 录制后端**：

1. 环境探测：AMD 显卡、CS2 可执行文件、OpenNR 运行时文件（ReShade/OpenNR add-on/
   danielblnc runtime/权重）、CIAP Pro 是否在线。缺任何一项就返回 ``NOT_AVAILABLE``
   并列出缺什么，前端据此提示。
2. 抓帧前把运行时文件 staging 到 CS2 ``bin/win64``（同名文件先改名备份），抓帧
   结束后无论成功失败都还原，保证不影响正常游戏/录制的 OBS 链路。
3. 通过 Pro 的录制 API 产出 1000fps take；可选再录一条「NR 关」的参考 take，用于
   后处理里的亮度锁源。
4. 后处理交给 ``experimental_nr_pipeline``：FrameMeld 60fps（blur 0.35）→ 可选亮度
   锁源（``experimental_nr_lumalock``）→ x265 10bit CRF18。

路径解析优先级统一为：**环境变量 → AppConfig.experimental → 自动探测/默认目录**。
需要外部二进制的部分（ReShade、OpenNR、danielblnc runtime、权重）不随仓库分发，
用户需自行准备，见 ``docs/experimental-amd-nr.md``。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LOG_PREFIX = "experimental-amd-nr"
CAPTURE_FPS = 1000
STALE_FRAME_LIMIT = 30
DEFAULT_PRO_BASE = "http://127.0.0.1:19871"

_AMD_HINTS = ("amd", "radeon", "advanced micro devices", "rx ")

#: staging 到 CS2 bin/win64 的运行时文件（键名同时用于前端展示与日志）。
RUNTIME_FILES = {
    "reShade": "dxgi.dll",
    "openNrAddon": "amd-nr.addon64",
    "runtime": "dlssnr_amd_pass1.dll",
    "weights": "dlssnr_on_amd_weights.bin",
}


class ExperimentalNrUnavailable(RuntimeError):
    """实验档所需外部资源不完整。"""

    def __init__(self, reason: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail or {}


# ---------------------------------------------------------------- 路径解析


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser() if raw else None


def _first_existing(*candidates: Path | None) -> Path | None:
    for item in candidates:
        if item is not None and item.is_file():
            return item
    return None


def _load_config():
    try:
        from .env_utils import load_config

        return load_config()
    except Exception as exc:  # pragma: no cover - 依赖缺失时仍可用环境变量
        logger.debug("load_config unavailable for experimental nr: %s", exc)
        return None


def _experimental_field(cfg, name: str) -> str:
    experimental = getattr(cfg, "experimental", None)
    value = getattr(experimental, name, "") if experimental is not None else ""
    return str(value or "").strip()


def data_dir() -> Path:
    """应用数据目录（日志/抓帧产物默认落在它下面）。"""
    try:
        from .env_utils import get_data_dir

        return get_data_dir()
    except Exception:  # pragma: no cover
        return Path.cwd() / "data"


def log_dir() -> Path:
    return data_dir() / "logs"


def pro_base() -> str:
    env = os.environ.get("CS2_NR_PRO_BASE", "").strip()
    if env:
        return env.rstrip("/")
    cfg = _load_config()
    configured = _experimental_field(cfg, "nr_pro_base")
    return configured.rstrip("/") if configured else DEFAULT_PRO_BASE


def pro_data_dir() -> Path:
    """CIAP Pro 的 data 目录（里面存 native-recording-jobs 模板）。"""
    env = _env_path("CS2_NR_PRO_DATA")
    if env is not None:
        return env
    cfg = _load_config()
    configured = _experimental_field(cfg, "nr_pro_data_dir")
    if configured:
        return Path(configured).expanduser()
    appdata = os.environ.get("APPDATA", "").strip()
    base = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    return base / "CS2 Insight Agent" / "data"


def pro_exe_candidates() -> list[Path]:
    """CIAP Pro 可执行文件的候选路径。"""
    candidates: list[Path] = []
    env = _env_path("CS2_NR_PRO_EXE")
    if env is not None:
        candidates.append(env)
    cfg = _load_config()
    configured = _experimental_field(cfg, "nr_pro_exe")
    if configured:
        candidates.append(Path(configured).expanduser())
    for root_name in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(root_name, "").strip()
        if not root:
            continue
        candidates.append(Path(root) / "CS2 Insight Agent Pro" / "cs2-insight-agent-pro.exe")
        candidates.append(Path(root) / "Programs" / "CS2 Insight Agent Pro" / "cs2-insight-agent-pro.exe")
    unique: list[Path] = []
    seen: set[str] = set()
    for item in candidates:
        key = str(item).lower()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def runtime_dir_default() -> Path:
    return data_dir() / "experimental-nr-runtime"


def output_dir_default() -> Path:
    return data_dir() / "nr-captures"


def cs2_exe() -> Path | None:
    env = _env_path("CS2_NR_CS2_EXE")
    if env is not None:
        return env
    cfg = _load_config()
    configured = str(getattr(cfg, "cs2_path", "") or "").strip() if cfg is not None else ""
    if configured:
        return Path(configured).expanduser()
    try:
        from .env_utils import detect_cs2_path

        detected = detect_cs2_path()
    except Exception:  # pragma: no cover
        detected = None
    return Path(detected).expanduser() if detected else None


def ffmpeg_bin() -> str:
    env = os.environ.get("CS2_NR_FFMPEG", "").strip()
    if env and Path(env).is_file():
        return env
    cfg = _load_config()
    configured = str(getattr(cfg, "ffmpeg_path", "") or "").strip() if cfg is not None else ""
    if configured and Path(configured).is_file():
        return configured
    try:
        from .env_utils import detect_ffmpeg_path

        detected = detect_ffmpeg_path()
        if detected:
            return detected
    except Exception:  # pragma: no cover
        pass
    return shutil.which("ffmpeg") or "ffmpeg"


def runtime_dir() -> Path:
    env = _env_path("CS2_NR_RUNTIME_DIR")
    if env is not None:
        return env
    cfg = _load_config()
    configured = _experimental_field(cfg, "nr_runtime_dir")
    return Path(configured).expanduser() if configured else runtime_dir_default()


def output_dir() -> Path:
    env = _env_path("CS2_NR_CAPTURE_DIR")
    if env is not None:
        return env
    cfg = _load_config()
    configured = _experimental_field(cfg, "nr_capture_dir")
    return Path(configured).expanduser() if configured else output_dir_default()


@dataclass
class ExperimentalNrPaths:
    cs2_exe: Path | None
    runtime_dir: Path
    output_dir: Path
    pro_data_dir: Path
    pro_base: str


def resolve_paths() -> ExperimentalNrPaths:
    return ExperimentalNrPaths(
        cs2_exe=cs2_exe(),
        runtime_dir=runtime_dir(),
        output_dir=output_dir(),
        pro_data_dir=pro_data_dir(),
        pro_base=pro_base(),
    )


# ---------------------------------------------------------------- 显卡


def _gpu_names() -> list[str]:
    """返回显卡名列表；优先 obs_tuning，缺依赖时回退 WMI。"""
    try:
        from .obs_tuning import detect_hardware

        hw = detect_hardware() or {}
        names = [str(i.get("name") or "").strip() for i in (hw.get("gpus") or []) if isinstance(i, dict)]
        names = [n for n in names if n]
        if names:
            return names
    except Exception as exc:  # pragma: no cover
        logger.debug("obs_tuning unavailable: %s", exc)
    try:  # pragma: no cover
        out = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        return [ln.strip() for ln in (out.stdout or "").splitlines() if ln.strip()]
    except Exception as exc:  # pragma: no cover
        logger.debug("gpu fallback failed: %s", exc)
        return []


def _runtime_file_state(path: Path) -> dict[str, bool]:
    state = {key: False for key in RUNTIME_FILES}
    if path.is_dir():
        for key, name in RUNTIME_FILES.items():
            state[key] = (path / name).is_file()
    return state


# ---------------------------------------------------------------- Pro 录制后端


def probe_pro_agent(timeout: float = 3.0) -> dict[str, Any]:
    """探测 CIAP Pro 本体是否在线（它自带 HLAE 1000fps 录制后端）。"""
    base = pro_base()
    try:
        with urllib.request.urlopen(f"{base}/api/health", timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        return {"running": True, "version": payload.get("version", ""), "base": base}
    except Exception as exc:  # pragma: no cover - 网络异常属正常探测结果
        return {"running": False, "base": base, "error": str(exc)}


def ensure_pro_agent(timeout_sec: float = 60.0, poll_sec: float = 2.0) -> dict[str, Any]:
    """保证 CIAP Pro 录制后端在线；未运行时尝试启动它。"""
    state = probe_pro_agent()
    if state.get("running"):
        return {**state, "started": False}
    exe = _first_existing(*pro_exe_candidates())
    if exe is None:
        return {"running": False, "started": False, "error": "PRO_EXE_MISSING", "base": pro_base()}
    try:
        subprocess.Popen([str(exe)], cwd=str(exe.parent))  # noqa: S603 - 用户本机已安装的程序
    except OSError as exc:
        return {"running": False, "started": False, "error": f"PRO_EXE_LAUNCH_FAILED: {exc}", "base": pro_base()}
    deadline = time.monotonic() + max(5.0, timeout_sec)
    while time.monotonic() < deadline:
        state = probe_pro_agent()
        if state.get("running"):
            return {**state, "started": True, "exe": str(exe)}
        time.sleep(max(0.5, poll_sec))
    return {"running": False, "started": True, "error": "PRO_AGENT_TIMEOUT", "base": pro_base(), "exe": str(exe)}


def _load_request_template() -> dict[str, Any]:
    """从 Pro 最近一次录制任务里取 envelope 模板（含 HUD/后期/天气参数）。"""
    jobs_dir = pro_data_dir() / "native-recording-jobs"
    candidates = sorted(jobs_dir.glob("*/request.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for item in candidates:
        try:
            data = json.loads(item.read_text(encoding="utf-8"))
        except Exception:
            continue
        requests = data.get("requests") if isinstance(data, dict) else None
        if not isinstance(requests, list) or not requests:
            continue
        first = requests[0] if isinstance(requests[0], dict) else {}
        if not first.get("request_id") or not first.get("rounds") or not first.get("demo"):
            continue
        return data
    raise ExperimentalNrUnavailable("NO_PRO_TEMPLATE", {"hint": str(jobs_dir)})


# ---------------------------------------------------------------- 环境探测


def probe_environment() -> dict[str, Any]:
    """探测实验档所需资源与 AMD 显卡状态，返回给前端/状态页。"""
    paths = resolve_paths()
    gpus = _gpu_names()
    amd = any(token in name.lower() for name in gpus for token in _AMD_HINTS)
    runtime_state = _runtime_file_state(paths.runtime_dir)
    pro = probe_pro_agent()

    missing: list[str] = []
    if not amd:
        missing.append("AMD_GPU")
    if paths.cs2_exe is None or not paths.cs2_exe.is_file():
        missing.append("CS2_EXE")
    if not all(runtime_state.values()):
        missing.append("NR_RUNTIME")
    if not pro.get("running"):
        missing.append("PRO_AGENT")

    return {
        "available": not missing,
        "missing": missing,
        "capture_backend": "ciap-pro",
        "capture_fps": CAPTURE_FPS,
        "gpus": gpus,
        "amd": amd,
        "cs2": str(paths.cs2_exe) if paths.cs2_exe else "",
        "runtime_dir": str(paths.runtime_dir),
        "runtime_files": runtime_state,
        "output_dir": str(paths.output_dir),
        "log_dir": str(log_dir()),
        "pro": pro,
        "pro_running": bool(pro.get("running")),
        "pro_base": paths.pro_base,
        "pro_data_dir": str(paths.pro_data_dir),
    }


# ---------------------------------------------------------------- 抓帧


def capture_via_pro(
    *,
    demo: Path,
    output_path: Path,
    ticks: tuple[int, int] | None,
    timeout_sec: int = 3600,
    poll_sec: float = 3.0,
) -> dict[str, Any]:
    """调用 CIAP Pro 的录制 API 产出 1000fps take（复用其 HLAE 后端）。"""
    envelope = _load_request_template()
    request = dict(envelope["requests"][0])
    request["request_id"] = str(uuid.uuid4())
    demo_obj = dict(request.get("demo") or {})
    demo_obj["demo_path"] = str(demo)
    demo_obj["demo_filename"] = demo.name
    request["demo"] = demo_obj
    if ticks is not None and request.get("rounds"):
        first = dict(request["rounds"][0])
        first["round_start_tick"] = int(ticks[0])
        first["round_end_tick"] = int(ticks[1])
        first["freeze_end_tick"] = int(ticks[0])
        request["rounds"] = [first]

    base = pro_base()

    def post(url: str, body: dict) -> dict:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def get(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    try:
        plan = post(f"{base}/api/recording/plan", request)
        envelope_job = dict(envelope)
        envelope_job["requests"] = [request]
        job = post(f"{base}/api/recording/jobs", envelope_job)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:2000]
        except Exception:
            detail = str(exc)
        raise ExperimentalNrUnavailable("PRO_HTTP_ERROR", {"status": exc.code, "detail": detail}) from exc
    except urllib.error.URLError as exc:
        raise ExperimentalNrUnavailable("PRO_UNREACHABLE", {"error": str(exc)}) from exc
    job_id = job.get("job_id") or job.get("id") or ""
    if not job_id:
        raise ExperimentalNrUnavailable("PRO_JOB_CREATE_FAILED", {"response": job})

    started = time.monotonic()
    last: dict[str, Any] = {}
    while time.monotonic() - started < timeout_sec:
        last = get(f"{base}/api/recording/jobs/{job_id}")
        if str(last.get("state") or "") in {"completed", "failed", "cancelled"}:
            break
        time.sleep(poll_sec)
    results = last.get("results") or []
    source = ""
    for item in results:
        src = item.get("output_path") or (item.get("segment_results") or [{}])[0].get("output_path") or ""
        if src and Path(src).is_file():
            source = src
            break
    if not source:
        raise ExperimentalNrUnavailable(
            "PRO_CAPTURE_NO_OUTPUT",
            {"state": last.get("state"), "error": last.get("error"), "job_id": job_id},
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output_path)
    return {
        "ok": True,
        "state": "captured",
        "job_id": job_id,
        "plan": plan,
        "source": source,
        "output": str(output_path),
        "elapsed_sec": round(time.monotonic() - started, 1),
    }


def _capture_reference_take(
    *,
    demo: Path,
    output_path: Path,
    ticks: tuple[int, int] | None,
    timeout_sec: int,
    runtime_path: Path | None,
    log_path: Path,
) -> Path:
    """同 demo/同 tick 再录一条「NR 关」的参考 take（亮度锁源用）。"""
    ini = (runtime_path / "amd-nr.ini") if runtime_path else None
    original = ini.read_bytes() if ini is not None and ini.is_file() else None
    ref_out = output_path.with_name(output_path.stem + "_ref" + output_path.suffix)
    try:
        if ini is not None and original is not None:
            lines = []
            for line in original.decode("utf-8", "replace").splitlines():
                lines.append("StartOn=0" if line.strip().startswith("StartOn") else line)
            ini.write_text("\n".join(lines) + "\n", encoding="utf-8")
            _write_log(log_path, ["reference capture: StartOn=0"])
        result = capture_via_pro(demo=demo, output_path=ref_out, ticks=ticks, timeout_sec=timeout_sec)
        _write_log(
            log_path,
            [
                f"reference capture ok job={result.get('job_id')} "
                f"elapsed={result.get('elapsed_sec')}s output={result.get('output')}"
            ],
        )
        return Path(result["output"])
    finally:
        if ini is not None and original is not None:
            try:
                ini.write_bytes(original)
            except OSError:
                pass


def _postprocess(
    *,
    take_path: Path,
    final_path: Path,
    log_path: Path,
    blur_amount: float = 0.35,
    ref_take: Path | None = None,
    luma_lock: bool = False,
) -> dict[str, Any]:
    """抓帧后处理：FrameMeld 60fps(blur) + 可选亮度锁源 + x265 10bit CRF18。"""
    from .experimental_nr_pipeline import PostProcessError, run_postprocess

    def log(message: str) -> None:
        _write_log(log_path, [message])

    try:
        return run_postprocess(
            ffmpeg_bin=ffmpeg_bin(),
            take_path=take_path,
            output_path=final_path,
            log=type("L", (), {"info": staticmethod(log)})(),
            blur_amount=blur_amount,
            ref_take=ref_take,
            luma_lock=luma_lock,
        )
    except PostProcessError as exc:
        log(f"postprocess failed step={exc.step}: {exc}")
        return {"ok": False, "state": "postprocess_failed", "step": exc.step, "message": str(exc)}


def start_capture(
    *,
    demo: Path,
    output_path: Path,
    ticks: tuple[int, int] | None = None,
    dry_run: bool = True,
    timeout_sec: int = 7200,
    postprocess: bool = True,
    luma_lock: bool = False,
) -> dict[str, Any]:
    """启动一次实验档抓帧（dry_run 只做环境校验，不真正抓帧）。"""
    status = probe_environment()
    log_path = open_log("capture")
    _write_log(
        log_path,
        [
            "capture requested",
            f"dry_run={dry_run} demo={demo} output={output_path} ticks={ticks}",
            f"available={status['available']} missing={status['missing']} amd={status['amd']} gpus={status['gpus']}",
            f"pro={status['pro']}",
        ],
    )
    if not status["available"]:
        return {
            "ok": False,
            "state": "not_available",
            "missing": status["missing"],
            "message": "实验档缺少所需资源：" + ", ".join(status["missing"]),
            "log_path": str(log_path),
        }
    if dry_run:
        return {
            "ok": True,
            "state": "dry_run",
            "message": "环境就绪（dry-run 未启动抓帧）",
            "log_path": str(log_path),
        }

    cs2_path = Path(status["cs2"])
    runtime_path = Path(status["runtime_dir"])
    staging_manifest = None
    try:
        from .experimental_nr_staging import cs2_bin_dir, stage_runtime

        bin_dir = cs2_bin_dir(cs2_path)
        staging_manifest = stage_runtime(runtime_path, bin_dir, log_path)
    except Exception as exc:  # pragma: no cover - staging 失败时不阻塞抓帧
        _write_log(log_path, [f"staging failed: {exc}"])

    result: dict[str, Any]
    try:
        result = capture_via_pro(demo=demo, output_path=output_path, ticks=ticks, timeout_sec=timeout_sec)
    except ExperimentalNrUnavailable as exc:
        _write_log(log_path, [f"pro capture unavailable: {exc.reason} {exc.detail}"])
        result = {
            "ok": False,
            "state": "failed",
            "reason": exc.reason,
            "detail": exc.detail,
            "message": "Pro 录制后端抓帧失败",
        }
    ref_take: Path | None = None
    if result.get("ok") and luma_lock:
        try:
            ref_take = _capture_reference_take(
                demo=demo,
                output_path=output_path,
                ticks=ticks,
                timeout_sec=timeout_sec,
                runtime_path=runtime_path,
                log_path=log_path,
            )
            result["reference_take"] = str(ref_take)
        except ExperimentalNrUnavailable as exc:
            _write_log(log_path, [f"reference capture failed: {exc.reason} {exc.detail}"])
            result["reference_error"] = exc.reason
    if staging_manifest is not None:
        try:
            from .experimental_nr_staging import unstage_runtime

            unstage_runtime(staging_manifest, log_path)
            result["runtime_staged"] = True
        except Exception as exc:  # pragma: no cover
            _write_log(log_path, [f"unstage failed: {exc}"])

    result["log_path"] = str(log_path)
    if result.get("ok") and postprocess:
        final_path = output_path.with_name(output_path.stem + "_delivery.mp4")
        post = _postprocess(
            take_path=output_path,
            final_path=final_path,
            log_path=log_path,
            ref_take=ref_take,
            luma_lock=bool(luma_lock and ref_take is not None),
        )
        result["postprocess"] = post
        result["final_output"] = post.get("output") if post.get("ok") else ""
        _write_log(
            log_path,
            [f"postprocess ok={post.get('ok')} output={result['final_output']} message={post.get('message', '')}"],
        )
    return result


# ---------------------------------------------------------------- 日志


def open_log(tag: str) -> Path:
    logs = log_dir()
    try:
        logs.mkdir(parents=True, exist_ok=True)
    except OSError:
        logs = Path.cwd() / "logs"
        logs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return logs / f"{LOG_PREFIX}-{tag}-{stamp}.log"


def _write_log(path: Path, lines: list[str]) -> None:
    stamp = datetime.now().isoformat(timespec="seconds")
    try:
        with path.open("a", encoding="utf-8") as fh:
            for line in lines:
                fh.write(f"{stamp} {line}\n")
    except OSError:
        logger.warning("experimental nr log write failed: %s", path)
