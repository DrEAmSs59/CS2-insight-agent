"""Fail-closed bridge to the offline CEnvSky handle rewriter.

Third-party demos serialize the active ``CEnvSky.m_hSkyMaterial`` resource
handle in PacketEntities snapshots.  A mounted VPK can provide the replacement
material bytes, but it cannot change that already-recorded handle.  This module
invokes the open-source Source 2 demo writer against the app-owned disposable
playback copy and atomically promotes the verified result in place.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


_REPO_ROOT = Path(__file__).resolve().parents[2]
_TOOL_NAME = (
    "demo-sky-handle-rewriter.exe"
    if sys.platform == "win32"
    else "demo-sky-handle-rewriter"
)
_COUNTS_RE = re.compile(
    r"source_fields_seen=(?P<source>\d+)\s+"
    r"target_fields_seen=(?P<target>\d+)\s+"
    r"fields_rewritten=(?P<rewritten>\d+)"
)
_ENVIRONMENT_COUNTS_RE = re.compile(
    r"cubemap_fog_active_fields_rewritten=(?P<fog_fields>\d+)\s+"
    r"cubemap_fog_entities=(?P<fog_entities>\d+)\s+"
    r"gradient_fog_enabled_fields_rewritten=(?P<gradient_fields>\d+)\s+"
    r"gradient_fog_entities=(?P<gradient_entities>\d+)\s+"
    r"func_brush_model_fields_rewritten=(?P<brush_fields>\d+)\s+"
    r"suppressed_func_brush_entities=(?P<brush_entities>\d+)"
)


class DemoSkyHandleRewriteError(RuntimeError):
    """The disposable demo could not be safely rewritten or verified."""


@dataclass(frozen=True)
class DemoSkyHandleRewriteReport:
    input_sha256: str
    output_sha256: str
    source_fields_seen: int
    target_fields_seen: int
    fields_rewritten: int
    cubemap_fog_active_fields_rewritten: int
    cubemap_fog_entities: int
    gradient_fog_enabled_fields_rewritten: int
    gradient_fog_entities: int
    func_brush_model_fields_rewritten: int
    suppressed_func_brush_entities: int


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        while chunk := reader.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_sky_handle_rewriter() -> Path:
    configured = os.environ.get("CS2_INSIGHT_SKY_HANDLE_REWRITER", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file():
            raise DemoSkyHandleRewriteError(
                f"configured sky-handle rewriter does not exist: {path}"
            )
        return path

    executable = Path(sys.executable).resolve()
    candidates = (
        executable.parent.parent / "tools" / _TOOL_NAME,
        _REPO_ROOT
        / "tools"
        / "demo-cosmetic-rewriter"
        / "target"
        / "release"
        / _TOOL_NAME,
        _REPO_ROOT
        / "frontend"
        / "src-tauri"
        / "bundle-resources"
        / "tools"
        / _TOOL_NAME,
    )
    for path in candidates:
        if path.is_file():
            return path.resolve()
    raise DemoSkyHandleRewriteError(
        f"{_TOOL_NAME} not found; build tools/demo-cosmetic-rewriter or set "
        "CS2_INSIGHT_SKY_HANDLE_REWRITER"
    )


def rewrite_demo_sky_material_handle_in_place(
    demo_path: str | Path,
    *,
    expected_map: str,
    source_handle: int | None = None,
    target_handle: int,
    expected_active_cubemap_fog_entities: int = 0,
    disable_active_gradient_fog: bool = False,
    suppressed_func_brush_model_handles: tuple[int, ...] = (),
    timeout_seconds: int = 180,
) -> DemoSkyHandleRewriteReport:
    """Rewrite one app-owned playback copy and atomically retain its path."""

    demo = Path(demo_path).resolve()
    if not demo.is_file():
        raise FileNotFoundError(f"Demo file not found: {demo}")
    if (
        target_handle <= 0
        or (source_handle is not None and source_handle <= 0)
        or source_handle == target_handle
    ):
        raise DemoSkyHandleRewriteError("invalid source/target CEnvSky material handles")
    if expected_active_cubemap_fog_entities < 0:
        raise DemoSkyHandleRewriteError("invalid active cubemap-fog entity count")
    normalized_model_handles = tuple(
        int(value) for value in suppressed_func_brush_model_handles
    )
    if (
        any(value <= 0 for value in normalized_model_handles)
        or len(set(normalized_model_handles)) != len(normalized_model_handles)
    ):
        raise DemoSkyHandleRewriteError(
            "suppressed func_brush model handles must be unique and positive"
        )
    normalized_map = str(expected_map or "").strip().lower()
    if not normalized_map.startswith("de_"):
        raise DemoSkyHandleRewriteError("expected demo map must be a de_* name")

    input_sha256 = _sha256_file(demo)
    output = demo.with_name(f".{demo.name}.sky-handle-{uuid.uuid4().hex}.dem")
    tool = resolve_sky_handle_rewriter()
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    argv = [
        str(tool),
        "--input",
        str(demo),
        "--output",
        str(output),
        "--expected-input-sha256",
        input_sha256,
        "--expected-map",
        normalized_map,
        "--target-handle",
        str(target_handle),
        "--expected-active-cubemap-fog-entities",
        str(expected_active_cubemap_fog_entities),
    ]
    if source_handle is not None:
        argv.extend(("--source-handle", str(source_handle)))
    if disable_active_gradient_fog:
        argv.append("--disable-active-gradient-fog")
    for model_handle in normalized_model_handles:
        argv.extend(("--suppress-func-brush-model-handle", str(model_handle)))
    promoted = False
    try:
        try:
            completed = subprocess.run(
                argv,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                shell=False,
                creationflags=creationflags,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise DemoSkyHandleRewriteError(
                f"sky-handle rewriter failed to start: {exc}"
            ) from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()
            raise DemoSkyHandleRewriteError(
                f"sky-handle rewriter exited with {completed.returncode}: "
                f"{detail[:2000]}"
            )
        if not output.is_file():
            raise DemoSkyHandleRewriteError("sky-handle rewriter produced no output demo")
        match = _COUNTS_RE.search(completed.stdout or "")
        if match is None:
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter did not return its verification counters"
            )
        source_fields_seen = int(match.group("source"))
        target_fields_seen = int(match.group("target"))
        fields_rewritten = int(match.group("rewritten"))
        if source_fields_seen <= 0 or fields_rewritten != source_fields_seen:
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter returned inconsistent replacement counters"
            )
        environment_match = _ENVIRONMENT_COUNTS_RE.search(completed.stdout or "")
        if environment_match is None:
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter did not return environment verification counters"
            )
        fog_fields = int(environment_match.group("fog_fields"))
        fog_entities = int(environment_match.group("fog_entities"))
        gradient_fields = int(environment_match.group("gradient_fields"))
        gradient_entities = int(environment_match.group("gradient_entities"))
        brush_fields = int(environment_match.group("brush_fields"))
        brush_entities = int(environment_match.group("brush_entities"))
        if fog_entities != expected_active_cubemap_fog_entities or (
            expected_active_cubemap_fog_entities > 0 and fog_fields <= 0
        ):
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter returned inconsistent cubemap-fog counters"
            )
        if disable_active_gradient_fog and (
            gradient_entities <= 0 or gradient_fields <= 0
        ):
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter returned inconsistent gradient-fog counters"
            )
        if not disable_active_gradient_fog and (
            gradient_entities != 0 or gradient_fields != 0
        ):
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter unexpectedly changed gradient fog"
            )
        if normalized_model_handles and (
            brush_entities < len(normalized_model_handles) or brush_fields <= 0
        ):
            raise DemoSkyHandleRewriteError(
                "sky-handle rewriter returned inconsistent func_brush counters"
            )
        output_sha256 = _sha256_file(output)
        if output_sha256 == input_sha256:
            raise DemoSkyHandleRewriteError("sky-handle rewrite did not change the demo")
        os.replace(output, demo)
        promoted = True
        return DemoSkyHandleRewriteReport(
            input_sha256=input_sha256,
            output_sha256=output_sha256,
            source_fields_seen=source_fields_seen,
            target_fields_seen=target_fields_seen,
            fields_rewritten=fields_rewritten,
            cubemap_fog_active_fields_rewritten=fog_fields,
            cubemap_fog_entities=fog_entities,
            gradient_fog_enabled_fields_rewritten=gradient_fields,
            gradient_fog_entities=gradient_entities,
            func_brush_model_fields_rewritten=brush_fields,
            suppressed_func_brush_entities=brush_entities,
        )
    finally:
        if not promoted:
            output.unlink(missing_ok=True)
            Path(f"{output}.partial").unlink(missing_ok=True)
