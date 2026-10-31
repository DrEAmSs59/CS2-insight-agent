from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import env_utils, obs_config_center


class FakeCalibrationWs:
    def __init__(self, profile: dict[tuple[str, str], str]) -> None:
        self.profile = dict(profile)
        self.profile_writes: list[tuple[str, str, str]] = []

    @staticmethod
    def _payload(request):
        payload = getattr(request, "datain", None) or getattr(request, "data", None) or request.__dict__
        return payload() if callable(payload) else payload

    def call(self, request):
        name = type(request).__name__
        payload = self._payload(request)
        if name == "GetVideoSettings":
            return SimpleNamespace(
                datain={
                    "baseWidth": 2560,
                    "baseHeight": 1440,
                    "outputWidth": 2560,
                    "outputHeight": 1440,
                    "fpsNumerator": 60,
                    "fpsDenominator": 1,
                }
            )
        if name == "GetSceneList":
            return SimpleNamespace(datain={"scenes": [{"sceneName": "CS2 Insight Recording"}]})
        if name == "GetSceneItemList":
            return SimpleNamespace(
                datain={
                    "sceneItems": [
                        {
                            "sourceName": "CS2 Insight Game Capture",
                            "sceneItemId": 7,
                        }
                    ]
                }
            )
        if name == "GetSceneItemId":
            return SimpleNamespace(datain={"sceneItemId": 7})
        if name == "SetSceneItemTransform":
            return SimpleNamespace(datain={})
        if name == "GetProfileParameter":
            key = (payload["parameterCategory"], payload["parameterName"])
            return SimpleNamespace(datain={"parameterValue": self.profile.get(key, "")})
        if name == "SetProfileParameter":
            key = (payload["parameterCategory"], payload["parameterName"])
            value = str(payload["parameterValue"])
            self.profile[key] = value
            self.profile_writes.append((*key, value))
            return SimpleNamespace(datain={})
        raise AssertionError(f"unexpected OBS request: {name}")


def _run_calibration(monkeypatch, ws: FakeCalibrationWs):
    monkeypatch.setattr(obs_config_center, "_ws_connect", lambda _cfg: ws)
    monkeypatch.setattr(obs_config_center, "_ws_disconnect", lambda _ws: None)
    monkeypatch.setattr(obs_config_center, "_obs_is_recording", lambda _ws: False)
    monkeypatch.setattr(env_utils, "get_primary_monitor_resolution", lambda: (2560, 1440))
    return obs_config_center.calibrate(SimpleNamespace())


def test_advanced_output_uses_obs_simple_encoder_then_switches_mode(monkeypatch):
    ws = FakeCalibrationWs(
        {
            ("Output", "Mode"): "Advanced",
            ("AdvOut", "RecFilePath"): r"D:\OBS Recordings",
            ("AdvOut", "RecType"): "Standard",
            ("AdvOut", "RecEncoder"): "h264_texture_amf",
            ("SimpleOutput", "FilePath"): r"C:\Old Recordings",
            ("SimpleOutput", "RecQuality"): "Stream",
            ("SimpleOutput", "RecEncoder"): "",
            ("SimpleOutput", "StreamEncoder"): "obs_x264",
            ("SimpleOutput", "RecFormat2"): "mkv",
        }
    )

    result = _run_calibration(monkeypatch, ws)

    assert ws.profile[("Output", "Mode")] == "Simple"
    assert ws.profile[("SimpleOutput", "FilePath")] == r"D:\OBS Recordings"
    assert ws.profile[("SimpleOutput", "RecQuality")] == "Small"
    assert ws.profile[("SimpleOutput", "RecEncoder")] == "obs_x264"
    assert ws.profile[("SimpleOutput", "RecFormat2")] == "hybrid_mp4"
    assert ws.profile_writes[-1] == ("Output", "Mode", "Simple")
    assert result["restart_obs_required"] is True
    assert result["mode_change_pending_restart"] is True
    assert result["output_mode_before"] == "Advanced"
    assert result["output_mode_after_restart"] == "Simple"


def test_advanced_output_falls_back_to_x264_without_simple_stream_encoder(monkeypatch):
    ws = FakeCalibrationWs(
        {
            ("Output", "Mode"): "Advanced",
            ("AdvOut", "RecEncoder"): "obs_nvenc_av1_tex",
            ("SimpleOutput", "RecQuality"): "Small",
            ("SimpleOutput", "RecEncoder"): "obs_nvenc_av1_tex",
            ("SimpleOutput", "StreamEncoder"): "",
            ("SimpleOutput", "RecFormat2"): "hybrid_mp4",
        }
    )

    result = _run_calibration(monkeypatch, ws)

    assert ws.profile[("SimpleOutput", "RecEncoder")] == "x264"
    assert ws.profile_writes[-1] == ("Output", "Mode", "Simple")
    assert result["restart_obs_required"] is True


def test_simple_output_without_profile_changes_does_not_require_restart(monkeypatch):
    ws = FakeCalibrationWs(
        {
            ("Output", "Mode"): "Simple",
            ("SimpleOutput", "RecQuality"): "Small",
            ("SimpleOutput", "RecEncoder"): "jim_nvenc",
            ("SimpleOutput", "StreamEncoder"): "jim_nvenc",
            ("SimpleOutput", "RecFormat2"): "hybrid_mp4",
        }
    )

    result = _run_calibration(monkeypatch, ws)

    assert ws.profile_writes == []
    assert result["restart_obs_required"] is False
    assert result["mode_change_pending_restart"] is False
    assert result["output_mode_before"] == "Simple"


def test_simple_x264_is_upgraded_when_obs_has_hardware_stream_encoder(monkeypatch):
    ws = FakeCalibrationWs(
        {
            ("Output", "Mode"): "Simple",
            ("SimpleOutput", "RecQuality"): "Small",
            ("SimpleOutput", "RecEncoder"): "x264",
            ("SimpleOutput", "StreamEncoder"): "nvenc",
            ("SimpleOutput", "RecFormat2"): "hybrid_mp4",
        }
    )

    result = _run_calibration(monkeypatch, ws)

    assert ws.profile[("SimpleOutput", "RecEncoder")] == "nvenc"
    assert ("SimpleOutput", "RecEncoder", "nvenc") in ws.profile_writes
    assert result["restart_obs_required"] is True


def test_backup_failure_is_not_published_and_incomplete_backup_cannot_restore(tmp_path, monkeypatch):
    import pytest
    root, backups = tmp_path / "obs", tmp_path / "backups"
    profile = root / "basic" / "profiles" / "test"
    profile.mkdir(parents=True)
    (profile / "basic.ini").write_text("good profile")
    (root / "global.ini").write_text("good global")
    monkeypatch.setattr(obs_config_center, "_backup_root", lambda: backups)
    real_copy = obs_config_center.shutil.copytree
    def fail_copy(src, dst):
        Path(dst).mkdir(parents=True)
        raise PermissionError("basic.ini locked")
    with monkeypatch.context() as patch:
        patch.setattr(obs_config_center.shutil, "copytree", fail_copy)
        with pytest.raises(PermissionError):
            obs_config_center._create_backup(root, reason="test", project_profile="test")
    assert obs_config_center.list_backups() == []
    broken = backups / "legacy-broken"
    broken.mkdir(parents=True)
    (broken / "manifest.json").write_text('{"project_profile":"test"}')
    (broken / "global.ini").write_text("old global")
    assert obs_config_center.list_backups() == []
    with pytest.raises(ValueError, match="不完整"):
        obs_config_center._restore_backup_pack(broken, root, "test")
    assert (profile / "basic.ini").read_text() == "good profile"
    assert (root / "global.ini").read_text() == "good global"


def test_restore_failure_preserves_current_profile_and_can_retry(tmp_path, monkeypatch):
    import pytest
    root = tmp_path / "obs"
    profile = root / "basic" / "profiles" / "test"
    profile.mkdir(parents=True)
    (profile / "basic.ini").write_text("before")
    (root / "global.ini").write_text("global before")
    monkeypatch.setattr(obs_config_center, "_backup_root", lambda: tmp_path / "backups")
    _, backup = obs_config_center._create_backup(root, reason="test", project_profile="test")
    (profile / "basic.ini").write_text("current")
    (root / "global.ini").write_text("global current")
    rename = Path.rename
    def fail_global(src, dst):
        if src.name == "new-global.ini":
            raise PermissionError("global locked")
        return rename(src, dst)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "rename", fail_global)
        with pytest.raises(PermissionError):
            obs_config_center._restore_backup_pack(backup, root, "test")
    assert (profile / "basic.ini").read_text() == "current"
    assert (root / "global.ini").read_text() == "global current"
    obs_config_center._restore_backup_pack(backup, root, "test")
    assert (profile / "basic.ini").read_text() == "before"
    assert (root / "global.ini").read_text() == "global before"
