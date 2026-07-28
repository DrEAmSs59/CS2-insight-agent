import json
import os
from pathlib import Path

from app import env_utils
from app.env_utils import AppConfig


def _configure_paths(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    config_path = tmp_path / "profile" / "cs2-insight.config.json"
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    config_path.parent.mkdir()
    monkeypatch.setenv("CS2_INSIGHT_CONFIG", str(config_path))
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(config_path.parent))
    monkeypatch.setenv("CS2_INSIGHT_BUNDLE_DATA_DIR", str(bundle_dir))
    return config_path, bundle_dir


def test_load_config_accepts_utf8_bom(monkeypatch, tmp_path: Path):
    config_path, _ = _configure_paths(monkeypatch, tmp_path)
    config_path.write_text(
        json.dumps({"match_count": 50}),
        encoding="utf-8-sig",
    )

    cfg = env_utils.load_config()

    assert cfg.match_count == 50
    assert not list(config_path.parent.glob("*.invalid-*.json"))


def test_load_config_quarantines_invalid_json_and_rebuilds(
    monkeypatch,
    tmp_path: Path,
):
    config_path, bundle_dir = _configure_paths(monkeypatch, tmp_path)
    invalid_text = "this is not JSON"
    config_path.write_text(invalid_text, encoding="utf-8")
    (bundle_dir / "cs2-insight.config.example.json").write_text(
        json.dumps({"match_count": 50}),
        encoding="utf-8",
    )

    cfg = env_utils.load_config()

    assert cfg.match_count == 50
    assert json.loads(config_path.read_text(encoding="utf-8"))["match_count"] == 50
    quarantined = list(config_path.parent.glob("*.invalid-*.json"))
    assert len(quarantined) == 1
    assert quarantined[0].read_text(encoding="utf-8") == invalid_text


def test_save_config_replaces_complete_temporary_file(
    monkeypatch,
    tmp_path: Path,
):
    config_path, _ = _configure_paths(monkeypatch, tmp_path)
    replacements: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def tracked_replace(source, destination):
        source_path = Path(source)
        destination_path = Path(destination)
        replacements.append((source_path, destination_path))
        assert source_path != config_path
        assert json.loads(source_path.read_text(encoding="utf-8"))["match_count"] == 50
        real_replace(source, destination)

    monkeypatch.setattr(env_utils.os, "replace", tracked_replace)

    env_utils.save_config(AppConfig(match_count=50))

    assert replacements
    assert replacements[-1][1] == config_path
    assert json.loads(config_path.read_text(encoding="utf-8"))["match_count"] == 50
    assert not list(config_path.parent.glob("*.tmp"))


def test_failed_atomic_replace_keeps_previous_config(
    monkeypatch,
    tmp_path: Path,
):
    config_path, _ = _configure_paths(monkeypatch, tmp_path)
    original = json.dumps({"match_count": 20})
    config_path.write_text(original, encoding="utf-8")

    def failed_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(env_utils.os, "replace", failed_replace)

    try:
        env_utils.save_config(AppConfig(match_count=50))
    except OSError as exc:
        assert str(exc) == "simulated replace failure"
    else:
        raise AssertionError("save_config should propagate the replace failure")

    assert config_path.read_text(encoding="utf-8") == original
    assert not list(config_path.parent.glob("*.tmp"))
