from pathlib import Path

from app import env_utils


def test_candidate_steam_roots_skips_bitlocker_locked_drive(monkeypatch, tmp_path):
    locked = Path("E:/Steam")
    real_is_dir = Path.is_dir

    def fake_is_dir(self):
        if self == locked:
            raise OSError(-2144272384, "This drive is locked by BitLocker Drive Encryption")
        return real_is_dir(self)

    monkeypatch.setattr(Path, "is_dir", fake_is_dir)
    monkeypatch.setattr(env_utils, "_steam_install_from_registry", lambda: None)
    monkeypatch.setattr(env_utils, "DEFAULT_STEAM_PATHS", [locked, tmp_path])

    assert env_utils._candidate_steam_roots() == [tmp_path]
