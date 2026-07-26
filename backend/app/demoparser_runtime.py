"""Validate the patched Rust demoparser runtime required by replay playback."""

from __future__ import annotations

import json
from importlib import metadata
from typing import Any

REQUIRED_DEMOPARSER_VERSION = "0.41.4+cs2insight7"
REQUIRED_DEMOPARSER_METHODS = (
    "decode_smoke_voxel_journal",
    "write_replay_parquet",
    "read_replay_parquet_round",
    "read_replay_parquet_round_binary",
)


def inspect_demoparser_runtime() -> dict[str, Any]:
    """Return a stable capability report without raising import errors."""
    installed_version: str | None = None
    import_error: str | None = None
    missing_methods = list(REQUIRED_DEMOPARSER_METHODS)
    try:
        installed_version = metadata.version("demoparser2")
        from demoparser2 import DemoParser

        missing_methods = [
            method
            for method in REQUIRED_DEMOPARSER_METHODS
            if not callable(getattr(DemoParser, method, None))
        ]
    except Exception as exc:  # noqa: BLE001 - report the exact broken runtime
        import_error = f"{type(exc).__name__}: {exc}"

    return {
        "ready": (
            import_error is None
            and installed_version == REQUIRED_DEMOPARSER_VERSION
            and not missing_methods
        ),
        "installed_version": installed_version,
        "required_version": REQUIRED_DEMOPARSER_VERSION,
        "missing_methods": missing_methods,
        "import_error": import_error,
    }


def require_demoparser_runtime() -> dict[str, Any]:
    """Fail startup instead of silently degrading the Rust replay pipeline."""
    report = inspect_demoparser_runtime()
    if report["ready"]:
        return report
    installed = report["installed_version"] or "not installed"
    missing = ", ".join(report["missing_methods"]) or "none"
    detail = f"; import error: {report['import_error']}" if report["import_error"] else ""
    raise RuntimeError(
        "Incompatible demoparser2 runtime. "
        f"Required {REQUIRED_DEMOPARSER_VERSION}, installed {installed}; "
        f"missing Rust methods: {missing}{detail}. "
        "Run packaging/demoparser-lean/setup-backend-dev.ps1 from the repository root."
    )


def main() -> int:
    report = require_demoparser_runtime()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
