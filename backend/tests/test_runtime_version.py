from __future__ import annotations

import sys
from pathlib import Path


_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app import main as main_module
from app import obs_config_center
from app.update_info import resolve_local_version_info


def test_runtime_surfaces_use_staged_release_version():
    expected, source = resolve_local_version_info()

    assert source == "file"
    assert main_module.app.version == expected
    assert main_module.health() == {"status": "ok", "version": expected}
    assert obs_config_center.APP_VERSION == f"V{expected}"
