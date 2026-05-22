from pathlib import Path

from app.env_utils import _obs64_from_install_root, _obs_path_from_registry_value


def test_obs64_from_install_root_standard_layout(tmp_path: Path):
    exe = tmp_path / "bin" / "64bit" / "obs64.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    assert _obs64_from_install_root(tmp_path) == exe


def test_obs_path_from_registry_install_location(tmp_path: Path):
    exe = tmp_path / "bin" / "64bit" / "obs64.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    assert _obs_path_from_registry_value(str(tmp_path)) == exe


def test_obs_path_from_registry_display_icon(tmp_path: Path):
    exe = tmp_path / "bin" / "64bit" / "obs64.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    assert _obs_path_from_registry_value(f'"{exe}",0') == exe


def test_obs_path_from_registry_uninstall_string(tmp_path: Path):
    exe = tmp_path / "bin" / "64bit" / "obs64.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    uninstall = tmp_path / "uninstall.exe"
    uninstall.write_bytes(b"MZ")
    assert _obs_path_from_registry_value(str(uninstall)) == exe
