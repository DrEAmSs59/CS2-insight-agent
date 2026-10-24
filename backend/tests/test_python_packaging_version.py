import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    "python_packaging_version",
    Path(__file__).resolve().parents[2] / "packaging/windows/verify_python_version.py",
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


@pytest.mark.parametrize("version,bits", [
    ((3, 12, 7), 64), ((3, 12, 14), 64), ((3, 11, 15), 64),
    ((3, 13, 17), 64), ((3, 12, 15), 32),
])
def test_rejects_old_or_incompatible_runtime(version, bits):
    with pytest.raises(RuntimeError, match="3.12.15"):
        gate.verify_python_version(version, bits)


@pytest.mark.parametrize("version", [(3, 12, 15), (3, 12, 16)])
def test_accepts_patched_cp312_runtime(version):
    gate.verify_python_version(version, 64)
