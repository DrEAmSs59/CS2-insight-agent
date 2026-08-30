import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_sky_handle_rewriter as sky_rewriter


def _configure_fake_tool(monkeypatch, tmp_path: Path) -> Path:
    tool = tmp_path / sky_rewriter._TOOL_NAME
    tool.write_bytes(b"tool")
    monkeypatch.setenv("CS2_INSIGHT_SKY_HANDLE_REWRITER", str(tool))
    return tool


def test_rewrite_atomically_promotes_verified_disposable_demo(monkeypatch, tmp_path: Path):
    tool = _configure_fake_tool(monkeypatch, tmp_path)
    demo = tmp_path / "preview.dem"
    demo.write_bytes(b"original-demo")
    original_sha = hashlib.sha256(b"original-demo").hexdigest()
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        output = Path(argv[argv.index("--output") + 1])
        output.write_bytes(b"rewritten-demo")
        return SimpleNamespace(
            returncode=0,
            stdout=(
                "source_fields_seen=28 target_fields_seen=0 "
                "fields_rewritten=28 entity_handles={10289658: 28}\n"
                "cubemap_fog_active_fields_rewritten=0 "
                "cubemap_fog_entities=0 "
                "gradient_fog_enabled_fields_rewritten=3 "
                "gradient_fog_entities=2 "
                "func_brush_model_fields_rewritten=0 "
                "suppressed_func_brush_entities=0\n"
            ),
            stderr="",
        )

    monkeypatch.setattr(sky_rewriter.subprocess, "run", fake_run)
    report = sky_rewriter.rewrite_demo_sky_material_handle_in_place(
        demo,
        expected_map="de_ancient",
        source_handle=5783173776371045529,
        target_handle=11736439226662960057,
        disable_active_gradient_fog=True,
    )

    assert demo.read_bytes() == b"rewritten-demo"
    assert report.input_sha256 == original_sha
    assert report.output_sha256 == hashlib.sha256(b"rewritten-demo").hexdigest()
    assert report.fields_rewritten == 28
    argv, kwargs = calls[0]
    assert Path(argv[0]) == tool
    assert argv[argv.index("--expected-input-sha256") + 1] == original_sha
    assert argv[argv.index("--expected-map") + 1] == "de_ancient"
    assert argv[argv.index("--source-handle") + 1] == "5783173776371045529"
    assert argv[argv.index("--target-handle") + 1] == "11736439226662960057"
    assert "--disable-active-gradient-fog" in argv
    assert report.gradient_fog_enabled_fields_rewritten == 3
    assert report.gradient_fog_entities == 2
    assert kwargs["shell"] is False


def test_rewriter_failure_preserves_input_and_cleans_candidate(monkeypatch, tmp_path: Path):
    _configure_fake_tool(monkeypatch, tmp_path)
    demo = tmp_path / "preview.dem"
    demo.write_bytes(b"original-demo")
    created = []

    def fake_run(argv, **_kwargs):
        output = Path(argv[argv.index("--output") + 1])
        output.write_bytes(b"unverified")
        created.append(output)
        return SimpleNamespace(returncode=9, stdout="", stderr="verification failed")

    monkeypatch.setattr(sky_rewriter.subprocess, "run", fake_run)
    with pytest.raises(
        sky_rewriter.DemoSkyHandleRewriteError,
        match="verification failed",
    ):
        sky_rewriter.rewrite_demo_sky_material_handle_in_place(
            demo,
            expected_map="de_ancient",
            source_handle=1,
            target_handle=2,
        )

    assert demo.read_bytes() == b"original-demo"
    assert created and not created[0].exists()


def test_auto_mode_omits_source_handle_and_promotes_verified_output(
    monkeypatch,
    tmp_path: Path,
):
    _configure_fake_tool(monkeypatch, tmp_path)
    demo = tmp_path / "preview.dem"
    demo.write_bytes(b"original-demo")
    calls = []

    def fake_run(argv, **_kwargs):
        calls.append(argv)
        Path(argv[argv.index("--output") + 1]).write_bytes(b"auto-rewritten")
        return SimpleNamespace(
            returncode=0,
            stdout=(
                "source_fields_seen=12 target_fields_seen=0 "
                "fields_rewritten=12 entity_handles={438: 4}\n"
                "cubemap_fog_active_fields_rewritten=1 "
                "cubemap_fog_entities=1 "
                "gradient_fog_enabled_fields_rewritten=0 "
                "gradient_fog_entities=0 "
                "func_brush_model_fields_rewritten=1 "
                "suppressed_func_brush_entities=1\n"
            ),
            stderr="",
        )

    monkeypatch.setattr(sky_rewriter.subprocess, "run", fake_run)
    report = sky_rewriter.rewrite_demo_sky_material_handle_in_place(
        demo,
        expected_map="de_dust2",
        target_handle=14038941216328320667,
        expected_active_cubemap_fog_entities=1,
        suppressed_func_brush_model_handles=(14229486482546056262,),
    )

    assert report.fields_rewritten == 12
    assert "--source-handle" not in calls[0]
    assert calls[0][calls[0].index("--target-handle") + 1] == (
        "14038941216328320667"
    )
    assert calls[0][
        calls[0].index("--expected-active-cubemap-fog-entities") + 1
    ] == "1"
    assert calls[0][
        calls[0].index("--suppress-func-brush-model-handle") + 1
    ] == "14229486482546056262"


def test_rejects_invalid_handles_before_starting_tool(monkeypatch, tmp_path: Path):
    demo = tmp_path / "preview.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(sky_rewriter.subprocess, "run", pytest.fail)
    with pytest.raises(sky_rewriter.DemoSkyHandleRewriteError, match="invalid"):
        sky_rewriter.rewrite_demo_sky_material_handle_in_place(
            demo,
            expected_map="de_ancient",
            source_handle=3,
            target_handle=3,
        )
