# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Launch closed-source skin-core.exe with pipe session key + AES-GCM request files."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

from .skin_core_crypto import build_session_key_frame, decrypt_response, encrypt_request

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ENV_EXE = "CS2_SKIN_CORE_EXE"
_ENV_DEV = "CS2_SKIN_CORE_DEV"
_ENV_INSIGHT_DEV = "CS2_INSIGHT_DEV"

# Sibling closed-source repo layouts used for local/dev discovery.
_DEV_ANYSKIN_ROOTS: tuple[Path, ...] = (
    _REPO_ROOT.parent / "CS2-demo-anyskin",
    Path(r"C:\code\CS2-demo-anyskin"),
)


class SkinCoreNotFound(FileNotFoundError):
    """skin-core.exe could not be resolved on this machine."""


class SkinCoreError(RuntimeError):
    """skin-core process failed after launch (auth, IO, or business)."""


def _is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _candidate_paths() -> list[Path]:
    candidates: list[Path] = []

    env = (os.environ.get(_ENV_EXE) or "").strip()
    if env:
        candidates.append(Path(env).expanduser())

    # In installed and portable builds this module lives at
    # <install_dir>/backend/app/skin_core_client.py. Resolve the sidecar directly
    # from the installation root; writable/bundled data directories are unrelated
    # to executable discovery and may live on a different drive.
    candidates.append(_REPO_ROOT / "tools" / "skin-core.exe")

    # Prefer sibling closed-repo builds over staged bundle-resources so local
    # `release-skin-core` updates are picked up without re-staging.
    for root in _DEV_ANYSKIN_ROOTS:
        candidates.append(root / "dist" / "skin-core.exe")
        candidates.append(root / "target" / "release" / "skin-core.exe")

    candidates.append(
        _REPO_ROOT / "frontend" / "src-tauri" / "bundle-resources" / "tools" / "skin-core.exe"
    )

    return candidates


def resolve_skin_core_exe() -> Path:
    """Locate skin-core.exe: env → install tools → closed-repo dist → staged tools."""
    seen: set[str] = set()
    for raw in _candidate_paths():
        try:
            path = raw.expanduser().resolve()
        except OSError:
            path = raw.expanduser()
        key = str(path).casefold()
        if key in seen:
            continue
        seen.add(key)
        if _is_file(path):
            return path
    raise SkinCoreNotFound(
        "skin-core.exe not found; set CS2_SKIN_CORE_EXE or place it at "
        "<install_dir>/tools/skin-core.exe"
    )


def _env_flag_enabled(name: str) -> bool:
    value = (os.environ.get(name) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _path_text(path: Path) -> str:
    return str(path).replace("\\", "/").casefold()


def _is_bundled_tools_exe(exe: Path) -> bool:
    """True when exe lives under packaged/repo bundle-resources/tools/."""
    text = _path_text(exe)
    if "bundle-resources/tools/" in text:
        return True
    try:
        tools_root = _REPO_ROOT.resolve() / "tools"
        return exe.resolve() == (tools_root / "skin-core.exe").resolve() or _path_text(
            exe
        ).startswith(_path_text(tools_root) + "/")
    except OSError:
        return False


def _is_dev_anyskin_exe(exe: Path) -> bool:
    """True when exe was resolved from CS2-demo-anyskin dist/ or target/."""
    text = _path_text(exe)
    if "cs2-demo-anyskin" not in text:
        return False
    return "/dist/" in text or text.endswith("/dist/skin-core.exe") or "/target/" in text


def _should_set_dev_env(exe: Path | None = None) -> bool:
    """Whether to force ``CS2_SKIN_CORE_DEV=1`` so skin-core skips PE allowlist.

    Production / bundled tools must leave DEV unset so the parent PE gate applies.
    DEV is set only when explicitly requested, or when the resolved exe is clearly
    an unpackaged CS2-demo-anyskin build artifact.
    """
    if _env_flag_enabled(_ENV_DEV) or _env_flag_enabled(_ENV_INSIGHT_DEV):
        return True
    if exe is None:
        return False
    if _is_bundled_tools_exe(exe):
        return False
    return _is_dev_anyskin_exe(exe)


def _cli_path_str(path: str | Path) -> str:
    """UTF-8 path string for CLI argv — must match AAD bytes exactly."""
    return str(path)


# Multi-item / large-demo rewrites can take several minutes; keep a high ceiling
# so a wedged skin-core cannot pin the UI spinner forever (timeout=None).
_DEFAULT_REWRITE_TIMEOUT_SEC = 600.0


def run_rewrite_owned_batch(
    *,
    input_dem: str | Path,
    output_dem: str | Path,
    steam_id64: str,
    items: Sequence[Mapping[str, Any]],
    demoparser2_python: str | Path,
    timeout: float | None = _DEFAULT_REWRITE_TIMEOUT_SEC,
) -> dict[str, Any]:
    """Spawn skin-core rewrite-owned-batch with pipe auth; return decrypted response JSON.

    Default ``timeout`` is 600s. Pass ``timeout=None`` only for explicit unbounded waits.
    """
    exe = resolve_skin_core_exe()

    input_arg = _cli_path_str(input_dem)
    output_arg = _cli_path_str(output_dem)
    demopy_arg = _cli_path_str(demoparser2_python)

    request_obj = {
        "schema_version": 1,
        "steam_id64": str(steam_id64),
        "items": list(items),
    }
    plaintext = json.dumps(request_obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    key = os.urandom(32)
    req_blob = encrypt_request(key, input_arg, output_arg, plaintext)

    with tempfile.TemporaryDirectory(prefix="skin-core-") as tmp:
        tmp_path = Path(tmp)
        request_path = tmp_path / "request.bin"
        response_path = tmp_path / "response.bin"
        request_path.write_bytes(req_blob)

        request_arg = _cli_path_str(request_path)
        response_arg = _cli_path_str(response_path)

        cmd = [
            _cli_path_str(exe),
            "rewrite-owned-batch",
            "--input",
            input_arg,
            "--output",
            output_arg,
            "--request",
            request_arg,
            "--response",
            response_arg,
            "--demoparser2-python",
            demopy_arg,
        ]

        env = os.environ.copy()
        if _should_set_dev_env(exe):
            env[_ENV_DEV] = "1"

        logger.info(
            "skin-core rewrite start: exe=%s steam_id64=%s items=%s timeout=%s",
            exe,
            steam_id64,
            len(items),
            timeout,
        )
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        try:
            stdout, stderr = proc.communicate(
                input=build_session_key_frame(key),
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            proc.kill()
            killed_out, killed_err = proc.communicate()
            err_tail = (killed_err or b"").decode("utf-8", errors="replace").strip()
            out_tail = (killed_out or b"").decode("utf-8", errors="replace").strip()
            logger.error(
                "skin-core timed out after %ss: stderr=%r stdout=%r",
                timeout,
                err_tail[:2000],
                out_tail[:500],
            )
            raise SkinCoreError(
                f"skin-core timed out after {timeout:g}s"
                + (f": {err_tail[:300]}" if err_tail else "")
            ) from exc

        code = proc.returncode
        if stdout:
            logger.info("skin-core stdout: %s", stdout[:500].decode("utf-8", errors="replace"))
        if stderr:
            logger.info("skin-core stderr: %s", stderr[:500].decode("utf-8", errors="replace"))
        logger.info("skin-core rewrite finished: exit=%s items=%s", code, len(items))

        if code == 2:
            raise SkinCoreError(
                f"skin-core auth failed (exit 2): {(stderr or b'').decode('utf-8', errors='replace').strip()}"
            )

        if not response_path.is_file():
            raise SkinCoreError(
                f"skin-core produced no response file (exit {code}): "
                f"{(stderr or b'').decode('utf-8', errors='replace').strip()}"
            )

        # AAD paths must be the exact CLI --input/--output strings.
        resp_plain = decrypt_response(key, input_arg, output_arg, response_path.read_bytes())
        try:
            result = json.loads(resp_plain.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SkinCoreError("skin-core response JSON invalid") from exc

        if not isinstance(result, dict):
            raise SkinCoreError("skin-core response must be a JSON object")
        return result
