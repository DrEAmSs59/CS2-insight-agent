from pathlib import Path
import json
import subprocess

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from pydantic import ValidationError

from app import framemeld, ffmpeg_compatibility, video_composer
from app.api.obs import _configured_ffmpeg_toolkit_report
from app.api.montage import MontageProjectBody, MontageExportBody
from app.features.lite_cut.models import OutputConfig
from app.features.lite_cut.project_codec import read_project_body, serialize_project_body
from app.features.lite_cut.export_plan import build_lite_cut_export_plan
from app.montage_exceptions import MontageComposerError


def capability(version="0.1.5", features=None):
    payload = {"protocol": "org.framemeld.cli", "api_version": 1, "version": version,
               "features": features if features is not None else ["final-luma-sharpen-v1", "independent-sharpen-v1"]}
    return framemeld._capability_from_json(subprocess.CompletedProcess([], 0, json.dumps(payload), ""))


def command(cap=None, **kwargs):
    return framemeld.build_framemeld_command(ffmpeg_bin=Path("ffmpeg.exe"), source_path=Path("input.mp4"),
        output_path=Path("output.mp4"), video_encode_args=["-c:v", "libx264"], capability=cap or capability(), **kwargs)


@pytest.mark.parametrize("blending,sharpen,amount", [(True, False, 0.15), (False, True, 0.1), (False, True, 0.3), (True, True, 0.15)])
def test_independent_controls(blending, sharpen, amount):
    cmd = command(frame_blending=blending, sharpen_enabled=sharpen, sharpen_amount=amount)
    assert float(cmd[cmd.index("--final-sharpen") + 1]) == (amount if sharpen else 0)
    assert ("--sharpen-only" in cmd) is (not blending)
    assert cmd[-3:] == ["-c:a", "copy", "output.mp4"]


@pytest.mark.parametrize("cap", [capability(""), capability("0.1.4-fast.2"), capability("0.1.4"), capability("0.1.5", []), capability("0.1.5-beta.1")])
def test_old_or_missing_contract_cannot_enable_independent_sharpen(cap):
    assert not framemeld.supports_independent_sharpen(cap)
    with pytest.raises(MontageComposerError) as exc:
        command(cap, sharpen_enabled=True)
    assert exc.value.code == "MONTAGE_SHARPEN_REQUIRES_FRAMEMELD_015"


def test_legacy_fast_retains_documented_fixed_sharpening():
    cmd = command(capability("", ["final-luma-sharpen-v1"]))
    assert cmd[cmd.index("--final-sharpen") + 1] == "0.15"
    assert "--sharpen-only" not in cmd


@pytest.mark.parametrize("value", [0, 0.09, 0.31, float("nan"), float("inf")])
def test_range_is_enforced_at_all_api_boundaries(value):
    for model, extra in [(OutputConfig, {}), (MontageProjectBody, {}), (MontageExportBody, {"output_path": "out.mp4"})]:
        with pytest.raises(ValidationError):
            model(sharpen_amount=value, **extra)
    with pytest.raises(ValueError):
        command(sharpen_enabled=True, sharpen_amount=value)


def test_litecut_roundtrip_and_export_projection():
    for blending, sharpening in [(False, True), (True, False), (True, True)]:
        body = serialize_project_body(read_project_body({"schema_version": 3, "output": {
            "framemeld_enabled": blending, "sharpen_enabled": sharpening, "sharpen_amount": 0.27}}))
        plan = build_lite_cut_export_plan(body)
        assert (plan.framemeld_enabled, plan.sharpen_enabled, plan.sharpen_amount) == (blending, sharpening, 0.27)
    old = read_project_body({"schema_version": 3, "output": {"framemeld_enabled": True}})
    assert old.output.sharpen_enabled is False
    assert old.output.sharpen_amount == 0.15


@pytest.mark.parametrize("cap,available,legacy", [(None, False, False), (capability("", ["final-luma-sharpen-v1"]), False, True), (capability(), True, False)])
def test_runtime_gate_reports_independent_and_legacy_support(monkeypatch, tmp_path, cap, available, legacy):
    binary = tmp_path / "ffmpeg.exe"
    binary.touch()
    monkeypatch.setattr(video_composer, "resolve_ffmpeg_binary", lambda _: binary)
    monkeypatch.setattr(ffmpeg_compatibility, "inspect_ffmpeg_toolkit", lambda _: {"ok": True})
    monkeypatch.setattr(framemeld, "probe_framemeld", lambda _: cap)
    report = _configured_ffmpeg_toolkit_report(str(binary))
    assert report["framemeld_sharpen_available"] is available
    assert report["framemeld_legacy_sharpen"] is legacy
