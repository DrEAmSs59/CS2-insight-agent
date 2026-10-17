"""Windows integration tests using a disposable copy of the bundled runtime.

Set CS2_TEST_BUNDLED_PYTHON to the bundled python directory to run these tests.
"""
import base64
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest


HELPER = Path(__file__).resolve().parents[2] / "frontend/src-tauri/windows/prepare-python-upgrade.ps1"
pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or not os.environ.get("CS2_TEST_BUNDLED_PYTHON"),
    reason="requires Windows and CS2_TEST_BUNDLED_PYTHON",
)


@pytest.fixture
def runtime(tmp_path):
    source = Path(os.environ["CS2_TEST_BUNDLED_PYTHON"])
    install = tmp_path / "Insight user's install"
    target = install / "python"
    target.mkdir(parents=True)
    for item in source.iterdir():
        if item.is_file():
            shutil.copy2(item, target / item.name)
    for name in ("PIL", "pillow.libs"):
        package = source / "Lib/site-packages" / name
        if package.exists():
            shutil.copytree(package, target / "Lib/site-packages" / name)
    return install


def launch_python(install, marker, image="python.exe"):
    code = f"import PIL._imaging,time;from pathlib import Path;Path({str(marker)!r}).touch();time.sleep(120)"
    child = subprocess.Popen(
        [str(install / "python" / image), "-I", "-c", code],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 10
    while not marker.exists():
        if child.poll() is not None or time.monotonic() > deadline:
            child.kill()
            child.wait()
            pytest.fail("disposable Pillow process failed to start")
        time.sleep(0.05)
    return child


def cleanup(install):
    # Exercise the actual 32-bit installer -> Sysnative -> 64-bit PS boundary.
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    code = (
        "& \"$env:WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe\" "
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + quote(HELPER)
        + " -InstallDir " + quote(install) + " -WaitSeconds 2; exit $LASTEXITCODE"
    )
    encoded = base64.b64encode(code.encode("utf-16-le")).decode()
    return subprocess.run(
        [str(Path(os.environ["WINDIR"]) / "SysWOW64/WindowsPowerShell/v1.0/powershell.exe"),
         "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW,
    )


def test_cleans_workers_without_port_and_preserves_other_edition(runtime, tmp_path):
    sibling = runtime.with_name(runtime.name + " Pro")
    shutil.copytree(runtime, sibling)
    workers = [launch_python(runtime, tmp_path / "worker-ready"),
               launch_python(runtime, tmp_path / "windowless-ready", "pythonw.exe")]
    other = launch_python(sibling, tmp_path / "other-ready")
    try:
        result = cleanup(runtime)
        assert result.returncode == 0, (result.stdout, result.stderr)
        assert all(child.wait(timeout=5) is not None for child in workers)
        assert other.poll() is None
        extension = next((runtime / "python/Lib/site-packages/PIL").glob("_imaging.cp*.pyd"))
        with extension.open("r+b"):
            pass
    finally:
        for child in [*workers, other]:
            if child.poll() is None:
                child.kill()
            child.wait()


def test_locked_native_file_aborts_without_changing_it(runtime):
    extension = next((runtime / "python/Lib/site-packages/PIL").glob("_imaging.cp*.pyd"))
    before = extension.read_bytes()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong,
                                  ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.CreateFileW(str(extension), 0x80000000, 1, None, 3, 0, None)
    assert handle != ctypes.c_void_p(-1).value
    try:
        result = cleanup(runtime)
        assert result.returncode != 0
        assert b"_imaging" in result.stdout
        assert extension.read_bytes() == before
    finally:
        kernel.CloseHandle(handle)
    assert cleanup(runtime).returncode == 0


def test_fresh_install_has_no_runtime_to_stop(tmp_path):
    assert cleanup(tmp_path / "new install").returncode == 0
