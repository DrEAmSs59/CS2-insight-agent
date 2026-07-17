from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat
import websocket


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
PUBLIC_TMP = FRONTEND / "public" / "__litecut_visual_tmp"
DEFAULT_REPORT_DIR = ROOT / "artifacts" / "litecut-visual-regression"
MATRIX_PATH = ROOT / "data" / "lite_cut_visual_acceptance.json"
EFFECT_CONTRACT_PATH = ROOT / "data" / "lite_cut_effect_contract.json"
VITE_PORT = 4174

sys.path.insert(0, str(ROOT / "backend"))

from app.lite_cut.composer import (  # noqa: E402
    _composite_overlays_on_base,
    _lite_cut_boundary_transition_to_ts,
    _lite_cut_clip_to_ts,
    _map_transition_type,
)
from app.lite_cut.assets import ensure_alpha_mov_preview_proxy  # noqa: E402
from app.video_composer import ffprobe_streams, probe_video_audio_summary, resolve_ffprobe_binary  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def first_existing(root: Path, candidates: list[str]) -> Path:
    for candidate in candidates:
        path = Path(candidate)
        if not path.is_absolute():
            path = root / path
        if path.is_file():
            return path.resolve()
    raise FileNotFoundError(f"No usable acceptance asset in: {candidates}")


def stream_has_alpha(path: Path, ffprobe: Path) -> bool:
    for stream in ffprobe_streams(path, ffprobe).get("streams") or []:
        if not isinstance(stream, dict) or stream.get("codec_type") != "video":
            continue
        pixel_format = str(stream.get("pix_fmt") or "").lower()
        tags = {str(key).lower(): value for key, value in (stream.get("tags") or {}).items()}
        alpha_mode = str(tags.get("alpha_mode") or "")
        if pixel_format.startswith("yuva") or pixel_format in {"rgba", "argb", "bgra", "abgr", "gbrap", "gbrap10le", "gbrap12le", "gbrap16le"} or alpha_mode == "1":
            return True
    return False


def resolve_ffmpeg() -> Path:
    configured = ""
    config_path = ROOT / "data" / "cs2-insight.config.json"
    if config_path.is_file():
        configured = str(load_json(config_path).get("ffmpeg_path") or "").strip()
    candidates = [configured, shutil.which("ffmpeg.exe") or "", shutil.which("ffmpeg") or ""]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate).resolve()
    raise FileNotFoundError("FFmpeg is not configured or available on PATH")


def resolve_edge() -> Path:
    candidates = [
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("Microsoft Edge or Google Chrome is required for preview screenshots")


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-1800:]
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command[:5])}\n{detail}")
    return result


def wait_for_url(url: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for {url}")


def extract_frame(ffmpeg: Path, source: Path, second: float, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run([
        str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-vf", f"setpts=PTS-STARTPTS,select=gte(t\\,{max(0.0, second):.6f})",
        "-frames:v", "1", "-fps_mode", "passthrough", "-update", "1", str(output),
    ])
    if not output.is_file():
        raise RuntimeError(f"FFmpeg did not create frame at {second:.3f}s from {source}")


def extract_last_frame(ffmpeg: Path, source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run([
        str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-vf", "reverse", "-frames:v", "1",
        "-fps_mode", "passthrough", "-update", "1", str(output),
    ])
    if not output.is_file():
        raise RuntimeError(f"FFmpeg did not create final frame from {source}")


def copy_as_mp4(ffmpeg: Path, source: Path, output: Path) -> None:
    run([str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-c", "copy", str(output)])


def image_metrics(preview_path: Path, export_path: Path) -> dict[str, Any]:
    preview = Image.open(preview_path).convert("RGB")
    exported = Image.open(export_path).convert("RGB")
    if preview.size != exported.size:
        preview = preview.crop((0, 0, min(preview.width, exported.width), min(preview.height, exported.height)))
        exported = exported.crop((0, 0, preview.width, preview.height))
    diff = ImageChops.difference(preview, exported)
    stat = ImageStat.Stat(diff)
    mae = sum(stat.mean) / (3 * 255.0)
    rms = sum(stat.rms) / (3 * 255.0)
    preview_mean = ImageStat.Stat(preview).mean
    export_mean = ImageStat.Stat(exported).mean
    mean_rgb_delta = sum(abs(a - b) for a, b in zip(preview_mean, export_mean)) / (3 * 255.0)
    return {
        "mae": round(mae, 6),
        "rms": round(rms, 6),
        "mean_rgb_delta": round(mean_rgb_delta, 6),
        "preview_mean_rgb": [round(value, 2) for value in preview_mean],
        "export_mean_rgb": [round(value, 2) for value in export_mean],
    }


def changed_bbox(base_path: Path, target_path: Path, threshold: int = 22) -> tuple[int, int, int, int] | None:
    base = Image.open(base_path).convert("RGB")
    target = Image.open(target_path).convert("RGB")
    if base.size != target.size:
        width = min(base.width, target.width)
        height = min(base.height, target.height)
        base = base.crop((0, 0, width, height))
        target = target.crop((0, 0, width, height))
    diff = ImageChops.difference(base, target).convert("L")
    mask = diff.point(lambda value: 255 if value >= threshold else 0)
    return mask.getbbox()


def bbox_metrics(
    preview_base: Path,
    preview_target: Path,
    export_base: Path,
    export_target: Path,
) -> dict[str, Any]:
    preview_bbox = changed_bbox(preview_base, preview_target)
    export_bbox = changed_bbox(export_base, export_target)
    if not preview_bbox or not export_bbox:
        return {"preview_bbox": preview_bbox, "export_bbox": export_bbox, "bbox_missing": True}
    preview_size = Image.open(preview_target).size
    export_size = Image.open(export_target).size

    def normalized(box: tuple[int, int, int, int], size: tuple[int, int]) -> tuple[float, float, float, float]:
        left, top, right, bottom = box
        width, height = size
        return (
            ((left + right) / 2) / width,
            ((top + bottom) / 2) / height,
            (right - left) / width,
            (bottom - top) / height,
        )

    p = normalized(preview_bbox, preview_size)
    e = normalized(export_bbox, export_size)
    return {
        "preview_bbox": preview_bbox,
        "export_bbox": export_bbox,
        "center_delta": round(max(abs(p[0] - e[0]), abs(p[1] - e[1])), 6),
        "width_delta": round(abs(p[2] - e[2]), 6),
        "height_delta": round(abs(p[3] - e[3]), 6),
    }


def change_energy(base_path: Path, target_path: Path) -> float:
    base = Image.open(base_path).convert("RGB")
    target = Image.open(target_path).convert("RGB")
    if base.size != target.size:
        width = min(base.width, target.width)
        height = min(base.height, target.height)
        base = base.crop((0, 0, width, height))
        target = target.crop((0, 0, width, height))
    diff = ImageChops.difference(base, target)
    return sum(ImageStat.Stat(diff).mean) / (3 * 255.0)


class VisualRegressionRunner:
    def __init__(self, *, scope: str, report_dir: Path) -> None:
        self.scope = scope
        self.report_dir = report_dir.resolve()
        self.matrix = load_json(MATRIX_PATH)
        self.contract = load_json(EFFECT_CONTRACT_PATH)
        self.ffmpeg = resolve_ffmpeg()
        self.ffprobe = resolve_ffprobe_binary(self.ffmpeg)
        self.edge = resolve_edge()
        self.primary = first_existing(ROOT, self.matrix["source_candidates"]["primary"])
        self.secondary = first_existing(ROOT, self.matrix["source_candidates"]["secondary"])
        self.vite: subprocess.Popen[str] | None = None
        self.results: list[dict[str, Any]] = []
        self.temp_root = Path(tempfile.mkdtemp(prefix="litecut_visual_"))
        self.edge_profile = self.temp_root / "edge-profile"
        self.quality = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"]

    def close(self) -> None:
        if self.vite is not None and self.vite.poll() is None:
            self.vite.terminate()
            try:
                self.vite.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.vite.kill()
        shutil.rmtree(PUBLIC_TMP, ignore_errors=True)
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def start_vite(self) -> None:
        PUBLIC_TMP.mkdir(parents=True, exist_ok=True)
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            raise FileNotFoundError("npm is required for browser preview rendering")
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.vite = subprocess.Popen(
            [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(VITE_PORT), "--strictPort"],
            cwd=FRONTEND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            creationflags=creationflags,
        )
        wait_for_url(f"http://127.0.0.1:{VITE_PORT}/test/litecut-visual-regression.html")

    def browser_screenshot(self, case: dict[str, Any], output: Path) -> None:
        PUBLIC_TMP.mkdir(parents=True, exist_ok=True)
        tmp_case = PUBLIC_TMP / "case.json.tmp"
        tmp_case.write_text(json.dumps(case, ensure_ascii=False), encoding="utf-8")
        tmp_case.replace(PUBLIC_TMP / "case.json")
        output.parent.mkdir(parents=True, exist_ok=True)
        width = int(case["width"])
        height = int(case["height"])
        url = f"http://127.0.0.1:{VITE_PORT}/test/litecut-visual-regression.html?case={case.get('caseId', 'case')}"
        if case.get("kind") == "alpha-video":
            self.cdp_screenshot(url=url, output=output, width=width, height=height, ready_expression="document.querySelector('[data-alpha-ready=\"true\"]') !== null")
            return
        run([
            str(self.edge), "--headless=new", "--hide-scrollbars", "--no-first-run", "--autoplay-policy=no-user-gesture-required",
            "--disable-features=msEdgeFirstRunExperience", f"--user-data-dir={self.edge_profile}",
            "--force-device-scale-factor=1", f"--virtual-time-budget={4500 if case.get('kind') == 'alpha-video' else 1800}",
            f"--window-size={width},{height}", f"--screenshot={output}", url,
        ], timeout=40)
        if not output.is_file():
            raise RuntimeError(f"Browser did not create screenshot: {output}")
        image = Image.open(output)
        if image.size != (width, height):
            image.crop((0, 0, min(width, image.width), min(height, image.height))).resize((width, height)).save(output)

    def cdp_screenshot(self, *, url: str, output: Path, width: int, height: int, ready_expression: str) -> None:
        profile = self.temp_root / f"edge-cdp-{time.time_ns()}"
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen([
            str(self.edge), "--headless=new", "--hide-scrollbars", "--no-first-run",
            "--autoplay-policy=no-user-gesture-required", "--remote-allow-origins=*",
            "--remote-debugging-port=0", f"--user-data-dir={profile}", url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        socket = None
        try:
            active_port = profile / "DevToolsActivePort"
            deadline = time.time() + 20
            while time.time() < deadline and not active_port.is_file():
                time.sleep(0.05)
            if not active_port.is_file():
                raise TimeoutError("Edge did not publish its DevTools port")
            port = int(active_port.read_text(encoding="utf-8").splitlines()[0])
            page_ws = ""
            while time.time() < deadline and not page_ws:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1) as response:
                        pages = json.loads(response.read().decode("utf-8"))
                    page_ws = next((item.get("webSocketDebuggerUrl") for item in pages if item.get("type") == "page"), "")
                except Exception:
                    time.sleep(0.05)
            if not page_ws:
                raise TimeoutError("Edge did not expose a debuggable page")
            socket = websocket.create_connection(page_ws, timeout=5, origin=f"http://127.0.0.1:{port}")
            request_id = 0

            def call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
                nonlocal request_id
                request_id += 1
                target_id = request_id
                socket.send(json.dumps({"id": target_id, "method": method, "params": params or {}}))
                while True:
                    payload = json.loads(socket.recv())
                    if payload.get("id") == target_id:
                        if payload.get("error"):
                            raise RuntimeError(str(payload["error"]))
                        return payload.get("result") or {}

            call("Page.enable")
            call("Runtime.enable")
            call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})
            ready_deadline = time.time() + 20
            ready = False
            while time.time() < ready_deadline:
                result = call("Runtime.evaluate", {"expression": ready_expression, "returnByValue": True})
                ready = bool(((result.get("result") or {}).get("value")))
                if ready:
                    break
                time.sleep(0.1)
            if not ready:
                raise TimeoutError("Browser video frame did not become ready")
            capture = call("Page.captureScreenshot", {"format": "png", "fromSurface": True, "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1}})
            output.write_bytes(base64.b64decode(capture["data"]))
        finally:
            if socket is not None:
                socket.close()
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()

    def add_result(self, *, category: str, case_id: str, passed: bool, metrics: dict[str, Any] | None = None, detail: str = "") -> None:
        self.results.append({
            "category": category,
            "case_id": case_id,
            "passed": bool(passed),
            "metrics": metrics or {},
            "detail": detail,
        })

    def render_clip(self, *, source: Path, canvas: dict[str, Any], clip: dict[str, Any], output: Path) -> None:
        _lite_cut_clip_to_ts(
            ffmpeg_bin=self.ffmpeg,
            src=source,
            out_ts=output,
            clip=clip,
            width=int(canvas["width"]),
            height=int(canvas["height"]),
            fps=30.0,
            canvas_fit="contain",
            background_color="black",
            blur_amount=24,
            video_encode_quality=self.quality,
        )

    def validate_media_inputs(self) -> None:
        groups = self.matrix["source_candidates"]
        for group, candidates in groups.items():
            found = []
            for candidate in candidates:
                path = Path(candidate)
                if not path.is_absolute():
                    path = ROOT / path
                if not path.is_file():
                    continue
                try:
                    info = probe_video_audio_summary(path, self.ffprobe)
                    found.append({"path": str(path), "width": info.get("width"), "height": info.get("height"), "duration": info.get("duration"), "pixel_format": info.get("pixel_format"), "has_alpha": info.get("has_alpha")})
                except Exception as exc:
                    found.append({"path": str(path), "error": str(exc)})
            self.add_result(category="media", case_id=group, passed=bool(found) and not any("error" in item for item in found), metrics={"assets": found})

    def run_alpha_mov_case(self) -> None:
        source = first_existing(ROOT, self.matrix["source_candidates"]["transparent_mov"])
        copied_source = self.temp_root / "alpha-source.mov"
        shutil.copy2(source, copied_source)
        proxy = ensure_alpha_mov_preview_proxy(copied_source, ffmpeg_bin=self.ffmpeg, duration_sec=2.0)
        if proxy is None or not proxy.is_file():
            self.add_result(category="alpha-mov", case_id="transparent-mov-preview", passed=False, detail="alpha preview proxy was not generated")
            return
        source_info = probe_video_audio_summary(copied_source, self.ffprobe)
        proxy_info = probe_video_audio_summary(proxy, self.ffprobe)
        canvas = self.matrix["canvas_presets"][0]
        width, height = int(canvas["width"]), int(canvas["height"])
        checker = Image.new("RGB", (width, height))
        pixels = checker.load()
        for y in range(height):
            for x in range(width):
                value = 88 if ((x // 12) + (y // 12)) % 2 == 0 else 42
                pixels[x, y] = (value, value, value)
        checker_path = PUBLIC_TMP / "checker.png"
        checker.save(checker_path)
        shutil.copy2(proxy, PUBLIC_TMP / "alpha-preview.webm")
        base_mp4 = self.temp_root / "checker-base.mp4"
        run([
            str(self.ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
            "-loop", "1", "-framerate", "30", "-t", "2", "-i", str(checker_path),
            *self.quality, "-pix_fmt", "yuv420p", base_mp4.as_posix(),
        ])
        output_mp4 = self.temp_root / "alpha-composited.mp4"
        overlay = {
            "type": "file", "file_path": str(copied_source),
            "timeline_start": 0, "trim_in": 0, "trim_out": 2, "duration": 2,
            "transform": {"x": 0.5, "y": 0.5, "width": 1, "height": 1, "scale": 1, "rotation": 0, "opacity": 1},
        }
        _composite_overlays_on_base(
            ffmpeg_bin=self.ffmpeg, ffprobe=self.ffprobe, base_mp4=base_mp4,
            overlay_clips=[overlay], out_mp4=output_mp4, video_encode_quality=self.quality,
        )
        case_dir = self.report_dir / "alpha-mov"
        export_frame = case_dir / "export.png"
        preview_frame = case_dir / "preview.png"
        extract_frame(self.ffmpeg, output_mp4, 0.5, export_frame)
        self.browser_screenshot({"kind": "alpha-video", "caseId": "transparent-mov-preview", "width": width, "height": height, "second": 0.5}, preview_frame)
        metrics = image_metrics(preview_frame, export_frame)
        preview_energy = change_energy(checker_path, preview_frame)
        export_energy = change_energy(checker_path, export_frame)
        proxy_has_alpha = stream_has_alpha(proxy, self.ffprobe)
        passed = bool(source_info.get("has_alpha")) and proxy_has_alpha and preview_energy > 0.003 and export_energy > 0.003 and metrics["mae"] <= 0.20
        self.add_result(category="alpha-mov", case_id="transparent-mov-preview", passed=passed, metrics={**metrics, "preview_energy": round(preview_energy, 6), "export_energy": round(export_energy, 6), "source_pixel_format": source_info.get("pixel_format"), "proxy_pixel_format": proxy_info.get("pixel_format"), "proxy_has_alpha": proxy_has_alpha}, detail="real MOV browser proxy vs FFmpeg alpha composite")

    def prepare_raw_source(self, *, second: float = 1.5, name: str = "source_a.png", source: Path | None = None) -> Path:
        destination = PUBLIC_TMP / name
        extract_frame(self.ffmpeg, source or self.primary, second, destination)
        return destination

    def run_filter_transform_matrix(self) -> None:
        filter_map = {item["id"]: item for item in self.contract["filter_presets"]}
        canvases = self.matrix["canvas_presets"] if self.scope == "full" else self.matrix["canvas_presets"][:1]
        filter_ids = self.matrix["filter_presets"] if self.scope == "full" else ["none", "vintage"]
        transform_cases = self.matrix["transform_cases"] if self.scope == "full" else self.matrix["transform_cases"][:2]
        self.prepare_raw_source(second=1.5)

        jobs: list[tuple[str, dict[str, Any], str]] = []
        for canvas in canvases:
            for filter_id in filter_ids:
                jobs.append((f"filter-{canvas['id']}-{filter_id}", self.matrix["transform_cases"][0], filter_id))
            for transform in transform_cases[1:]:
                jobs.append((f"transform-{canvas['id']}-{transform['id']}", transform, "none"))

        for case_id, transform, filter_id in jobs:
            canvas_id = case_id.split("-")[1]
            canvas = next(item for item in canvases if item["id"] == canvas_id)
            case_dir = self.report_dir / "filter-transform" / case_id.replace(":", "_")
            clip = {
                "id": case_id,
                "trim_in": 1.0,
                "trim_out": 2.0,
                "timeline_start": 0,
                "transform": transform,
                "color": {"preset": filter_id, "brightness": 0, "contrast": 0, "saturation": 0},
            }
            rendered = self.temp_root / f"{case_id.replace(':', '_')}.ts"
            export_frame = case_dir / "export.png"
            preview_frame = case_dir / "preview.png"
            self.render_clip(source=self.primary, canvas=canvas, clip=clip, output=rendered)
            extract_frame(self.ffmpeg, rendered, 0.5, export_frame)
            self.browser_screenshot({
                "kind": "filter-transform", "caseId": case_id,
                "width": canvas["width"], "height": canvas["height"],
                "transform": transform, "cssFilter": filter_map[filter_id]["css"],
            }, preview_frame)
            metrics = image_metrics(preview_frame, export_frame)
            threshold = 0.08 if filter_id == "none" and transform["id"] == "identity" else 0.24
            passed = metrics["mae"] <= threshold and metrics["mean_rgb_delta"] <= 0.16
            self.add_result(category="filter-transform", case_id=case_id, passed=passed, metrics=metrics, detail=f"mae<={threshold}")

    def normalized_pair(self, canvas: dict[str, Any]) -> tuple[Path, Path]:
        safe_id = canvas["id"].replace(":", "_")
        previous = self.temp_root / f"previous-{safe_id}.ts"
        incoming = self.temp_root / f"incoming-{safe_id}.ts"
        if not previous.is_file():
            clip = {"trim_in": 1.0, "trim_out": 3.0, "timeline_start": 0}
            self.render_clip(source=self.primary, canvas=canvas, clip=clip, output=previous)
            self.render_clip(source=self.secondary, canvas=canvas, clip=clip, output=incoming)
        return previous, incoming

    def run_transition_matrix(self) -> None:
        canvases = self.matrix["canvas_presets"] if self.scope == "full" else self.matrix["canvas_presets"][:1]
        transitions = self.matrix["transitions"] if self.scope == "full" else ["fade", "flash", "dip", "wipe_l", "slide_up"]
        progress_values = self.matrix["transition_progress"]
        for canvas in canvases:
            previous, incoming = self.normalized_pair(canvas)
            previous_info = probe_video_audio_summary(previous, self.ffprobe)
            previous_duration = float(previous_info.get("duration") or 2.0)
            transition_outgoing = PUBLIC_TMP / "transition_outgoing.png"
            extract_last_frame(self.ffmpeg, previous, transition_outgoing)
            for transition in transitions:
                safe_id = canvas["id"].replace(":", "_")
                transition_file = self.temp_root / f"transition-{safe_id}-{transition}.ts"
                _lite_cut_boundary_transition_to_ts(
                    ffmpeg_bin=self.ffmpeg,
                    ffprobe=self.ffprobe,
                    previous_ts=previous,
                    next_ts=incoming,
                    transition_type=_map_transition_type(transition),
                    transition_duration=1.0,
                    fps=30.0,
                    out_ts=transition_file,
                    video_encode_quality=self.quality,
                )
                for progress in progress_values:
                    case_id = f"transition-{canvas['id']}-{transition}-{progress:.2f}"
                    case_dir = self.report_dir / "transitions" / case_id.replace(":", "_")
                    export_frame = case_dir / "export.png"
                    preview_frame = case_dir / "preview.png"
                    extract_frame(self.ffmpeg, transition_file, previous_duration + progress, export_frame)
                    extract_frame(self.ffmpeg, incoming, progress, PUBLIC_TMP / "transition_incoming.png")
                    self.browser_screenshot({
                        "kind": "transition", "caseId": case_id,
                        "width": canvas["width"], "height": canvas["height"],
                        "transition": transition, "progress": progress,
                    }, preview_frame)
                    metrics = image_metrics(preview_frame, export_frame)
                    threshold = 0.32 if transition in {"blur", "glitch", "spin"} else 0.26
                    mean_luma = sum(metrics["export_mean_rgb"]) / (3 * 255.0)
                    unexpected_black = transition != "dip" and mean_luma < 0.015
                    passed = metrics["mae"] <= threshold and not unexpected_black
                    self.add_result(category="transition", case_id=case_id, passed=passed, metrics={**metrics, "unexpected_black": unexpected_black}, detail=f"mae<={threshold}")

    def font_source(self, font: dict[str, Any]) -> Path:
        path = Path(font["file"])
        if not path.is_absolute():
            path = ROOT / path
        if not path.is_file():
            raise FileNotFoundError(f"Font is unavailable: {path}")
        return path.resolve()

    def browser_base(self, canvas: dict[str, Any], *, source_second: float, output: Path) -> None:
        self.prepare_raw_source(second=source_second)
        self.browser_screenshot({
            "kind": "filter-transform", "caseId": f"base-{canvas['id']}-{source_second}",
            "width": canvas["width"], "height": canvas["height"],
            "transform": self.matrix["transform_cases"][0], "cssFilter": "none",
        }, output)

    def run_font_matrix(self) -> None:
        canvases = self.matrix["canvas_presets"] if self.scope == "full" else self.matrix["canvas_presets"][:1]
        fonts = self.matrix["fonts"]
        imported_dir = self.temp_root / "导入字体测试"
        imported_dir.mkdir(parents=True, exist_ok=True)
        for canvas in canvases:
            previous, _incoming = self.normalized_pair(canvas)
            base_mp4 = self.temp_root / f"font-base-{canvas['id'].replace(':', '_')}.mp4"
            copy_as_mp4(self.ffmpeg, previous, base_mp4)
            export_base = self.report_dir / "fonts" / f"base-{canvas['id'].replace(':', '_')}" / "export.png"
            preview_base = self.report_dir / "fonts" / f"base-{canvas['id'].replace(':', '_')}" / "preview.png"
            extract_frame(self.ffmpeg, base_mp4, 1.0, export_base)
            self.browser_base(canvas, source_second=2.0, output=preview_base)
            for font in fonts:
                source_font = self.font_source(font)
                browser_font_name = "font-under-test" + source_font.suffix.lower()
                shutil.copy2(source_font, PUBLIC_TMP / browser_font_name)
                export_font_file = ""
                if font["kind"] == "imported":
                    imported_font = imported_dir / f"Imported Font{source_font.suffix.lower()}"
                    shutil.copy2(source_font, imported_font)
                    export_font_file = str(imported_font)
                case_id = f"font-{canvas['id']}-{font['id']}"
                case_dir = self.report_dir / "fonts" / case_id.replace(":", "_")
                output_mp4 = self.temp_root / f"{case_id.replace(':', '_')}.mp4"
                text = {
                    "content": "CLUTCH",
                    "font_family": font["family"],
                    "font_file": export_font_file,
                    "font_size": 36,
                    "preset_id": "clutch",
                }
                overlay = {
                    "type": "text", "timeline_start": 0, "trim_in": 0, "trim_out": 2, "duration": 2,
                    "transform": {"x": 0.58, "y": 0.38, "width": 0.72, "height": 0.26, "scale": 1.0, "rotation": 0, "opacity": 1},
                    "text": text,
                }
                _composite_overlays_on_base(
                    ffmpeg_bin=self.ffmpeg, ffprobe=self.ffprobe, base_mp4=base_mp4,
                    overlay_clips=[overlay], out_mp4=output_mp4,
                    video_encode_quality=self.quality,
                )
                export_frame = case_dir / "export.png"
                preview_frame = case_dir / "preview.png"
                extract_frame(self.ffmpeg, output_mp4, 1.0, export_frame)
                self.browser_screenshot({
                    "kind": "text", "caseId": case_id,
                    "width": canvas["width"], "height": canvas["height"],
                    "fontFamily": font["family"], "fontAsset": browser_font_name,
                    "fontSize": 36, "text": "CLUTCH", "presetId": "clutch",
                    "x": 0.58, "y": 0.38, "boxWidth": 0.72, "boxHeight": 0.26, "scale": 1,
                    "transition": "cut", "progress": 1,
                }, preview_frame)
                metrics = bbox_metrics(preview_base, preview_frame, export_base, export_frame)
                passed = not metrics.get("bbox_missing") and metrics.get("center_delta", 1) <= 0.055 and metrics.get("width_delta", 1) <= 0.18 and metrics.get("height_delta", 1) <= 0.18
                self.add_result(category="font", case_id=case_id, passed=passed, metrics=metrics, detail="bbox center<=0.055, size delta<=0.18")

    def run_image_transition_matrix(self) -> None:
        canvases = self.matrix["canvas_presets"] if self.scope == "full" else self.matrix["canvas_presets"][:1]
        transitions = self.matrix["transitions"] if self.scope == "full" else ["fade", "flash", "dip", "wipe_l", "slide_up"]
        overlay_path = first_existing(ROOT, self.matrix["source_candidates"]["images"])
        shutil.copy2(overlay_path, PUBLIC_TMP / "overlay_image.png")
        for canvas in canvases:
            previous, _incoming = self.normalized_pair(canvas)
            base_mp4 = self.temp_root / f"image-transition-base-{canvas['id'].replace(':', '_')}.mp4"
            copy_as_mp4(self.ffmpeg, previous, base_mp4)
            export_base = self.report_dir / "image-transitions" / f"base-{canvas['id'].replace(':', '_')}" / "export.png"
            preview_base = self.report_dir / "image-transitions" / f"base-{canvas['id'].replace(':', '_')}" / "preview.png"
            extract_frame(self.ffmpeg, base_mp4, 0.5, export_base)
            self.browser_base(canvas, source_second=1.5, output=preview_base)
            for transition in transitions:
                case_id = f"image-transition-{canvas['id']}-{transition}"
                case_dir = self.report_dir / "image-transitions" / case_id.replace(":", "_")
                output_mp4 = self.temp_root / f"{case_id.replace(':', '_')}.mp4"
                overlay = {
                    "type": "file", "file_path": str(overlay_path),
                    "timeline_start": 0, "trim_in": 0, "trim_out": 2, "duration": 2,
                    "transform": {"x": 0.5, "y": 0.5, "width": 0.46, "height": 0.34, "scale": 1.0, "rotation": 0, "opacity": 1},
                    "transition_in": {"type": transition, "duration_sec": 1.0},
                }
                _composite_overlays_on_base(
                    ffmpeg_bin=self.ffmpeg, ffprobe=self.ffprobe, base_mp4=base_mp4,
                    overlay_clips=[overlay], out_mp4=output_mp4,
                    video_encode_quality=self.quality,
                )
                export_frame = case_dir / "export.png"
                preview_frame = case_dir / "preview.png"
                extract_frame(self.ffmpeg, output_mp4, 0.5, export_frame)
                self.browser_screenshot({
                    "kind": "image-transition", "caseId": case_id,
                    "width": canvas["width"], "height": canvas["height"],
                    "transition": transition, "progress": 0.5,
                    "x": 0.5, "y": 0.5, "boxWidth": 0.46, "boxHeight": 0.34, "scale": 1,
                }, preview_frame)
                metrics = bbox_metrics(preview_base, preview_frame, export_base, export_frame)
                preview_energy = change_energy(preview_base, preview_frame)
                export_energy = change_energy(export_base, export_frame)
                metrics.update({
                    "preview_energy": round(preview_energy, 6),
                    "export_energy": round(export_energy, 6),
                    "energy_delta": round(abs(preview_energy - export_energy), 6),
                })
                passed = not metrics.get("bbox_missing") and metrics.get("center_delta", 1) <= 0.10 and metrics.get("width_delta", 1) <= 0.24 and metrics.get("height_delta", 1) <= 0.24 and metrics["energy_delta"] <= 0.13
                self.add_result(category="image-transition", case_id=case_id, passed=passed, metrics=metrics, detail="overlay bbox and visual energy")

    def run_text_transition_matrix(self) -> None:
        canvas = self.matrix["canvas_presets"][0]
        transitions = self.matrix["transitions"] if self.scope == "full" else ["fade", "flash", "dip", "slide_up"]
        font = next(item for item in self.matrix["fonts"] if item["kind"] == "imported")
        source_font = self.font_source(font)
        browser_font_name = "font-under-test" + source_font.suffix.lower()
        shutil.copy2(source_font, PUBLIC_TMP / browser_font_name)
        imported_dir = self.temp_root / "文字转场导入字体"
        imported_dir.mkdir(parents=True, exist_ok=True)
        imported_font = imported_dir / f"Imported Font{source_font.suffix.lower()}"
        shutil.copy2(source_font, imported_font)
        previous, _incoming = self.normalized_pair(canvas)
        base_mp4 = self.temp_root / "text-transition-base.mp4"
        copy_as_mp4(self.ffmpeg, previous, base_mp4)
        for transition in transitions:
            for phase in ("in", "out"):
                local_time = 0.5 if phase == "in" else 1.5
                progress = 0.5
                case_id = f"text-transition-{transition}-{phase}"
                case_dir = self.report_dir / "text-transitions" / case_id
                export_base = case_dir / "export-base.png"
                preview_base = case_dir / "preview-base.png"
                extract_frame(self.ffmpeg, base_mp4, local_time, export_base)
                self.browser_base(canvas, source_second=1.0 + local_time, output=preview_base)
                output_mp4 = self.temp_root / f"{case_id}.mp4"
                overlay = {
                    "type": "text", "timeline_start": 0, "trim_in": 0, "trim_out": 2, "duration": 2,
                    "transform": {"x": 0.58, "y": 0.38, "width": 0.72, "height": 0.26, "scale": 1.0, "rotation": 0, "opacity": 1},
                    "text": {"content": "CLUTCH", "font_family": font["family"], "font_file": str(imported_font), "font_size": 36, "preset_id": "clutch"},
                    f"transition_{phase}": {"type": transition, "duration_sec": 1.0},
                }
                _composite_overlays_on_base(
                    ffmpeg_bin=self.ffmpeg, ffprobe=self.ffprobe, base_mp4=base_mp4,
                    overlay_clips=[overlay], out_mp4=output_mp4,
                    video_encode_quality=self.quality,
                )
                export_frame = case_dir / "export.png"
                preview_frame = case_dir / "preview.png"
                extract_frame(self.ffmpeg, output_mp4, local_time, export_frame)
                self.browser_screenshot({
                    "kind": "text", "caseId": case_id,
                    "width": canvas["width"], "height": canvas["height"],
                    "fontFamily": font["family"], "fontAsset": browser_font_name,
                    "fontSize": 36, "text": "CLUTCH", "presetId": "clutch",
                    "x": 0.58, "y": 0.38, "boxWidth": 0.72, "boxHeight": 0.26, "scale": 1,
                    "transition": transition, "progress": progress, "phase": phase,
                }, preview_frame)
                metrics = bbox_metrics(preview_base, preview_frame, export_base, export_frame)
                preview_energy = change_energy(preview_base, preview_frame)
                export_energy = change_energy(export_base, export_frame)
                metrics.update({"preview_energy": round(preview_energy, 6), "export_energy": round(export_energy, 6), "energy_delta": round(abs(preview_energy - export_energy), 6)})
                passed = not metrics.get("bbox_missing") and metrics.get("center_delta", 1) <= 0.07 and metrics.get("width_delta", 1) <= 0.20 and metrics.get("height_delta", 1) <= 0.20 and metrics["energy_delta"] <= 0.08
                self.add_result(category="text-transition", case_id=case_id, passed=passed, metrics=metrics, detail="text bbox and visual energy")

    def write_report(self) -> Path:
        self.report_dir.mkdir(parents=True, exist_ok=True)
        summary: dict[str, dict[str, int]] = {}
        for item in self.results:
            bucket = summary.setdefault(item["category"], {"passed": 0, "failed": 0})
            bucket["passed" if item["passed"] else "failed"] += 1
        payload = {
            "schema_version": 1,
            "scope": self.scope,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "ffmpeg": str(self.ffmpeg),
            "edge": str(self.edge),
            "primary_source": str(self.primary),
            "secondary_source": str(self.secondary),
            "summary": summary,
            "results": self.results,
        }
        json_path = self.report_dir / "report.json"
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        lines = ["# LiteCut 视觉回归报告", "", f"- 范围：`{self.scope}`", f"- 主素材：`{self.primary}`", f"- 对照素材：`{self.secondary}`", "", "## 汇总", "", "| 类别 | 通过 | 失败 |", "|---|---:|---:|"]
        for category, counts in summary.items():
            lines.append(f"| {category} | {counts['passed']} | {counts['failed']} |")
        failed = [item for item in self.results if not item["passed"]]
        lines.extend(["", "## 未通过", ""])
        if not failed:
            lines.append("全部通过。")
        else:
            for item in failed:
                lines.append(f"- `{item['case_id']}`：{item['detail']}；`{json.dumps(item['metrics'], ensure_ascii=False)}`")
        markdown_path = self.report_dir / "report.md"
        markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return markdown_path

    def run_all(self) -> Path:
        self.report_dir.mkdir(parents=True, exist_ok=True)
        self.start_vite()
        self.validate_media_inputs()
        self.run_alpha_mov_case()
        self.run_filter_transform_matrix()
        self.run_transition_matrix()
        self.run_font_matrix()
        self.run_image_transition_matrix()
        self.run_text_transition_matrix()
        return self.write_report()


def main() -> int:
    parser = argparse.ArgumentParser(description="Render and compare LiteCut browser preview frames with FFmpeg export frames.")
    parser.add_argument("--scope", choices=("smoke", "full"), default="full")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    args = parser.parse_args()
    runner = VisualRegressionRunner(scope=args.scope, report_dir=args.report_dir)
    try:
        report = runner.run_all()
        failed = sum(1 for item in runner.results if not item["passed"])
        print(f"Report: {report}")
        print(f"Cases: {len(runner.results)}, failed: {failed}")
        return 1 if failed else 0
    finally:
        runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
