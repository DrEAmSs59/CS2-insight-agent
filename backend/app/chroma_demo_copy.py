"""Prepare an app-owned Demo copy for validated solid-color sky playback."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .chroma_demo_manifest import (
    ChromaDemoManifestProfile,
    get_chroma_demo_manifest_profile,
)
from .demo_playback_compat import PlaybackDemoReport, prepare_cs2_playback_demo
from .demo_sky_handle_rewriter import (
    DemoSkyHandleRewriteReport,
    rewrite_demo_sky_material_handle_in_place,
)


class ChromaDemoCopyError(RuntimeError):
    """A validated chroma reference could not prepare the playback copy."""


@dataclass(frozen=True)
class ChromaDemoCopyReport:
    map_name: str
    profile: ChromaDemoManifestProfile
    manifest_report: PlaybackDemoReport
    handle_report: DemoSkyHandleRewriteReport


def prepare_chroma_demo_copy(
    source_path: str | Path,
    destination_path: str | Path,
    *,
    map_name: str,
) -> ChromaDemoCopyReport:
    """Migrate one validated reference registration into a disposable Demo.

    The source Demo is read-only.  The terminal sky SpawnGroup manifest and
    active ``CEnvSky`` material handles are rewritten only in ``destination``.
    """

    source = Path(source_path).resolve()
    destination = Path(destination_path).resolve()
    if source == destination:
        raise ChromaDemoCopyError("chroma Demo source and destination must differ")
    if not source.is_file():
        raise FileNotFoundError(f"Demo file not found: {source}")

    profile = get_chroma_demo_manifest_profile(map_name)
    if profile is None:
        raise ChromaDemoCopyError(
            f"no validated chroma Demo reference exists for {map_name or 'unknown'}"
        )

    manifest_report = prepare_cs2_playback_demo(
        source,
        destination,
        drop_legacy_type138=False,
        chroma_skybox_spawn_group_world_name=profile.world_name,
        chroma_skybox_spawn_group_manifests=profile.spawn_group_manifests,
    )
    try:
        handle_report = rewrite_demo_sky_material_handle_in_place(
            destination,
            expected_map=profile.map_name,
            target_handle=profile.target_sky_material_handle,
            expected_active_cubemap_fog_entities=(
                profile.active_cubemap_fog_entities_to_disable
            ),
            disable_active_gradient_fog=profile.disable_active_gradient_fog,
            suppressed_func_brush_model_handles=(
                profile.suppressed_func_brush_model_handles
            ),
        )
    except Exception:
        # A half-prepared copy must never be launched.  The original Demo is
        # outside this cleanup boundary and remains untouched.
        destination.unlink(missing_ok=True)
        raise

    return ChromaDemoCopyReport(
        map_name=profile.map_name,
        profile=profile,
        manifest_report=manifest_report,
        handle_report=handle_report,
    )
