"""实验档抓帧模块的路径解析与探测逻辑测试（不启动 CS2 / Pro）。"""

import json
import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import experimental_nr_capture as capture  # noqa: E402


@pytest.fixture()
def fake_runtime(tmp_path: Path) -> Path:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    for name in capture.RUNTIME_FILES.values():
        (runtime_dir / name).write_bytes(b"payload")
    return runtime_dir


@pytest.fixture()
def fake_cs2(tmp_path: Path) -> Path:
    exe = tmp_path / "cs2" / "game" / "bin" / "win64" / "cs2.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"stub")
    return exe


def _stub_pro(monkeypatch: pytest.MonkeyPatch, running: bool, version: str | None = None) -> None:
    monkeypatch.setattr(capture, "probe_pro_agent", lambda *a, **k: {"running": running, "version": version})


def test_probe_reports_runtime_missing(
    tmp_path: Path, fake_cs2: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CS2_NR_CS2_EXE", str(fake_cs2))
    monkeypatch.setenv("CS2_NR_RUNTIME_DIR", str(tmp_path / "missing-runtime"))
    monkeypatch.setenv("CS2_NR_CAPTURE_DIR", str(tmp_path / "out"))
    monkeypatch.setattr(capture, "_gpu_names", lambda: ["AMD Radeon RX 9070 XT"])
    _stub_pro(monkeypatch, True, "2.7.7.3")

    info = capture.probe_environment()

    assert info["missing"] == ["NR_RUNTIME"]
    assert info["available"] is False
    assert info["amd"] is True
    assert info["capture_backend"] == "ciap-pro"
    assert info["capture_fps"] == capture.CAPTURE_FPS
    assert all(value is False for value in info["runtime_files"].values())


def test_probe_available_when_everything_present(
    tmp_path: Path, fake_runtime: Path, fake_cs2: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CS2_NR_CS2_EXE", str(fake_cs2))
    monkeypatch.setenv("CS2_NR_RUNTIME_DIR", str(fake_runtime))
    monkeypatch.setenv("CS2_NR_CAPTURE_DIR", str(tmp_path / "out"))
    monkeypatch.setattr(capture, "_gpu_names", lambda: ["AMD Radeon RX 9070 XT"])
    _stub_pro(monkeypatch, True, "2.7.7.3")

    info = capture.probe_environment()

    assert info["available"] is True
    assert info["missing"] == []
    assert all(info["runtime_files"].values())


def test_probe_flags_non_amd_and_missing_pro(
    tmp_path: Path, fake_runtime: Path, fake_cs2: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CS2_NR_CS2_EXE", str(fake_cs2))
    monkeypatch.setenv("CS2_NR_RUNTIME_DIR", str(fake_runtime))
    monkeypatch.setattr(capture, "_gpu_names", lambda: ["NVIDIA GeForce RTX 4070"])
    _stub_pro(monkeypatch, False)

    info = capture.probe_environment()

    assert info["available"] is False
    assert "AMD_GPU" in info["missing"]
    assert "PRO_AGENT" in info["missing"]


def test_env_overrides_for_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CS2_NR_PRO_BASE", "http://127.0.0.1:19999")
    monkeypatch.setenv("CS2_NR_PRO_DATA", str(tmp_path / "pro-data"))
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"stub")
    monkeypatch.setenv("CS2_NR_FFMPEG", str(ffmpeg))

    assert capture.pro_base() == "http://127.0.0.1:19999"
    assert capture.pro_data_dir() == tmp_path / "pro-data"
    assert capture.ffmpeg_bin() == str(ffmpeg)


def test_start_capture_dry_run_returns_plan(
    tmp_path: Path, fake_runtime: Path, fake_cs2: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CS2_NR_CS2_EXE", str(fake_cs2))
    monkeypatch.setenv("CS2_NR_RUNTIME_DIR", str(fake_runtime))
    monkeypatch.setenv("CS2_NR_CAPTURE_DIR", str(tmp_path / "out"))
    monkeypatch.setattr(capture, "_gpu_names", lambda: ["AMD Radeon RX 9070 XT"])
    _stub_pro(monkeypatch, True, "2.7.7.3")

    def _boom(*args, **kwargs):  # pragma: no cover - 只在实现回归时触发
        raise AssertionError("dry_run 不应真正抓帧")

    monkeypatch.setattr(capture, "capture_via_pro", _boom)

    result = capture.start_capture(
        demo=Path("demo.dem"),
        output_path=tmp_path / "out" / "clip.mp4",
        ticks=(100, 200),
        dry_run=True,
    )

    assert result["ok"] is True
    assert result["state"] == "dry_run"
    assert result["log_path"]


def test_start_capture_not_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        capture,
        "probe_environment",
        lambda: {
            "available": False,
            "missing": ["CS2_EXE", "NR_RUNTIME"],
            "amd": True,
            "gpus": ["AMD Radeon RX 9070 XT"],
            "pro": {"running": False},
        },
    )

    result = capture.start_capture(demo=Path("demo.dem"), output_path=tmp_path / "out.mp4")

    assert result["ok"] is False
    assert result["state"] == "not_available"
    assert "CS2_EXE" in result["missing"]


def test_load_request_template_skips_broken_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pro_data = tmp_path / "pro-data"
    jobs = pro_data / "native-recording-jobs"
    broken = jobs / "broken"
    broken.mkdir(parents=True)
    (broken / "request.json").write_text("{not json", encoding="utf-8")
    invalid = jobs / "invalid"
    invalid.mkdir()
    (invalid / "request.json").write_text(json.dumps({"requests": [{"demo": {}}]}), encoding="utf-8")
    valid = jobs / "valid"
    valid.mkdir()
    payload = {"requests": [{"request_id": "r1", "demo": {"path": "x.dem"}, "rounds": [{"round": 1}]}]}
    (valid / "request.json").write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("CS2_NR_PRO_DATA", str(pro_data))

    template = capture._load_request_template()

    assert template["requests"][0]["request_id"] == "r1"
