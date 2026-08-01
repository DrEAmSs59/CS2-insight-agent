# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Unit tests for skin-core subprocess launcher (mocked Popen; no real exe)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.skin_core_client import (
    SkinCoreNotFound,
    _should_set_dev_env,
    resolve_skin_core_exe,
    run_rewrite_owned_batch,
)
from app.skin_core_crypto import (
    REQUEST_MAGIC,
    RESPONSE_MAGIC,
    VERSION,
    build_session_key_frame,
    decrypt_frame,
    encrypt_frame,
)


FIXED_KEY = bytes(range(32))


def _encrypt_response(key: bytes, input_path: str, output_path: str, plaintext: bytes) -> bytes:
    aad = RESPONSE_MAGIC + bytes([VERSION]) + input_path.encode("utf-8") + output_path.encode("utf-8")
    return encrypt_frame(RESPONSE_MAGIC, key, aad, plaintext)


def test_resolve_prefers_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    exe = tmp_path / "custom-skin-core.exe"
    exe.write_bytes(b"MZ")
    monkeypatch.setenv("CS2_SKIN_CORE_EXE", str(exe))
    assert resolve_skin_core_exe() == exe.resolve()


def test_resolve_bundle_resources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    bundle_root = tmp_path / "bundle"
    tools = bundle_root / "tools"
    tools.mkdir(parents=True)
    exe = tools / "skin-core.exe"
    exe.write_bytes(b"MZ")
    monkeypatch.setenv("CS2_INSIGHT_BUNDLE_DATA_DIR", str(bundle_root / "data"))
    assert resolve_skin_core_exe() == exe.resolve()


def test_resolve_repo_bundle_resources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_BUNDLE_DATA_DIR", raising=False)
    repo = tmp_path / "repo"
    exe = repo / "frontend" / "src-tauri" / "bundle-resources" / "tools" / "skin-core.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    monkeypatch.setattr("app.skin_core_client._REPO_ROOT", repo)
    monkeypatch.setattr("app.skin_core_client._DEV_ANYSKIN_ROOTS", ())
    assert resolve_skin_core_exe() == exe.resolve()


def test_resolve_dev_anyskin_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_BUNDLE_DATA_DIR", raising=False)
    repo = tmp_path / "insight"
    repo.mkdir()
    anyskin = tmp_path / "CS2-demo-anyskin"
    exe = anyskin / "dist" / "skin-core.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    monkeypatch.setattr("app.skin_core_client._REPO_ROOT", repo)
    monkeypatch.setattr("app.skin_core_client._DEV_ANYSKIN_ROOTS", (anyskin,))
    assert resolve_skin_core_exe() == exe.resolve()


def test_resolve_raises_when_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_BUNDLE_DATA_DIR", raising=False)
    monkeypatch.setattr("app.skin_core_client._REPO_ROOT", tmp_path / "empty-repo")
    monkeypatch.setattr("app.skin_core_client._DEV_ANYSKIN_ROOTS", ())
    with pytest.raises(SkinCoreNotFound):
        resolve_skin_core_exe()


def test_run_rewrite_pipes_session_key_and_decrypts_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    exe = tmp_path / "skin-core.exe"
    exe.write_bytes(b"MZ")
    monkeypatch.setenv("CS2_SKIN_CORE_EXE", str(exe))
    monkeypatch.delenv("CS2_SKIN_CORE_DEV", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_DEV", raising=False)

    def fake_urandom(n: int) -> bytes:
        if n == 32:
            return FIXED_KEY
        return bytes((i * 17 + 3) % 256 for i in range(n))

    monkeypatch.setattr("app.skin_core_client.os.urandom", fake_urandom)
    # encrypt_request uses the shared os module for nonces
    monkeypatch.setattr("app.skin_core_crypto.os.urandom", fake_urandom)

    input_dem = tmp_path / "in.dem"
    output_dem = tmp_path / "out.dem"
    input_dem.write_bytes(b"dem")
    demopy = tmp_path / "python.exe"
    demopy.write_bytes(b"MZ")

    captured: dict = {}

    def fake_popen(cmd, stdin=None, stdout=None, stderr=None, env=None, **kwargs):
        captured["cmd"] = list(cmd)
        captured["stdin"] = stdin
        captured["env"] = env
        # Resolve CLI path strings used as AAD.
        input_arg = cmd[cmd.index("--input") + 1]
        output_arg = cmd[cmd.index("--output") + 1]
        response_path = Path(cmd[cmd.index("--response") + 1])
        request_path = Path(cmd[cmd.index("--request") + 1])
        assert request_path.is_file()
        # Request must decrypt with FIXED_KEY + exact CLI path strings.
        aad = REQUEST_MAGIC + bytes([VERSION]) + input_arg.encode("utf-8") + output_arg.encode("utf-8")
        plaintext = decrypt_frame(REQUEST_MAGIC, FIXED_KEY, aad, request_path.read_bytes())
        body = json.loads(plaintext.decode("utf-8"))
        assert body["schema_version"] == 1
        assert body["steam_id64"] == "76561198000000001"
        assert len(body["items"]) == 1
        assert "custom_name" not in body["items"][0]

        ok_payload = json.dumps(
            {
                "schema_version": 1,
                "ok": True,
                "sha256": "abc123",
                "items_rewritten": 1,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        response_path.write_bytes(_encrypt_response(FIXED_KEY, input_arg, output_arg, ok_payload))

        proc = MagicMock()
        proc.stdin = MagicMock()

        def communicate(input=None, timeout=None):
            captured["auth_frame"] = input
            return (b"output=\n", b"")

        proc.communicate = communicate
        proc.returncode = 0
        return proc

    monkeypatch.setattr("app.skin_core_client.subprocess.Popen", fake_popen)

    items = [
        {
            "item_id64": "42",
            "definition_index": 7,
            "paint_kit": 340,
            "pattern_seed": 12,
            "wear": 0.01,
        }
    ]
    result = run_rewrite_owned_batch(
        input_dem=str(input_dem),
        output_dem=str(output_dem),
        steam_id64="76561198000000001",
        items=items,
        demoparser2_python=str(demopy),
    )

    assert result["ok"] is True
    assert result["sha256"] == "abc123"
    assert result["items_rewritten"] == 1

    cmd = captured["cmd"]
    assert cmd[0] == str(exe.resolve()) or cmd[0] == str(exe)
    assert cmd[1] == "rewrite-owned-batch"
    assert "--input" in cmd and "--output" in cmd
    assert "--request" in cmd and "--response" in cmd
    assert "--demoparser2-python" in cmd
    assert captured["stdin"] is not None  # PIPE
    assert captured["auth_frame"] == build_session_key_frame(FIXED_KEY)
    # Arbitrary CS2_SKIN_CORE_EXE path is not auto-DEV; PE allowlist applies.
    assert "CS2_SKIN_CORE_DEV" not in (captured["env"] or {})


def test_should_set_dev_env_explicit_and_bundled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_DEV", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_DEV", raising=False)

    bundled = tmp_path / "frontend" / "src-tauri" / "bundle-resources" / "tools" / "skin-core.exe"
    bundled.parent.mkdir(parents=True)
    bundled.write_bytes(b"MZ")
    assert _should_set_dev_env(bundled) is False

    monkeypatch.setenv("CS2_SKIN_CORE_DEV", "1")
    assert _should_set_dev_env(bundled) is True
    monkeypatch.delenv("CS2_SKIN_CORE_DEV", raising=False)

    monkeypatch.setenv("CS2_INSIGHT_DEV", "1")
    assert _should_set_dev_env(bundled) is True
    monkeypatch.delenv("CS2_INSIGHT_DEV", raising=False)

    anyskin = tmp_path / "CS2-demo-anyskin" / "dist" / "skin-core.exe"
    anyskin.parent.mkdir(parents=True)
    anyskin.write_bytes(b"MZ")
    assert _should_set_dev_env(anyskin) is True

    arbitrary = tmp_path / "elsewhere" / "skin-core.exe"
    arbitrary.parent.mkdir(parents=True)
    arbitrary.write_bytes(b"MZ")
    assert _should_set_dev_env(arbitrary) is False


def test_run_sets_dev_env_for_anyskin_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_BUNDLE_DATA_DIR", raising=False)
    monkeypatch.delenv("CS2_SKIN_CORE_DEV", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_DEV", raising=False)

    anyskin = tmp_path / "CS2-demo-anyskin"
    exe = anyskin / "dist" / "skin-core.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    monkeypatch.setattr("app.skin_core_client._REPO_ROOT", tmp_path / "insight")
    monkeypatch.setattr("app.skin_core_client._DEV_ANYSKIN_ROOTS", (anyskin,))

    def fake_urandom(n: int) -> bytes:
        if n == 32:
            return FIXED_KEY
        return bytes((i * 17 + 3) % 256 for i in range(n))

    monkeypatch.setattr("app.skin_core_client.os.urandom", fake_urandom)
    monkeypatch.setattr("app.skin_core_crypto.os.urandom", fake_urandom)

    input_dem = tmp_path / "in.dem"
    output_dem = tmp_path / "out.dem"
    input_dem.write_bytes(b"dem")
    captured: dict = {}

    def fake_popen(cmd, stdin=None, stdout=None, stderr=None, env=None, **kwargs):
        captured["env"] = env
        input_arg = cmd[cmd.index("--input") + 1]
        output_arg = cmd[cmd.index("--output") + 1]
        response_path = Path(cmd[cmd.index("--response") + 1])
        ok_payload = json.dumps({"schema_version": 1, "ok": True}, separators=(",", ":")).encode("utf-8")
        response_path.write_bytes(_encrypt_response(FIXED_KEY, input_arg, output_arg, ok_payload))
        proc = MagicMock()

        def communicate(input=None, timeout=None):
            return (b"", b"")

        proc.communicate = communicate
        proc.returncode = 0
        return proc

    monkeypatch.setattr("app.skin_core_client.subprocess.Popen", fake_popen)
    run_rewrite_owned_batch(
        input_dem=str(input_dem),
        output_dem=str(output_dem),
        steam_id64="1",
        items=[{"item_id64": "1", "definition_index": 7, "paint_kit": 1, "pattern_seed": 0, "wear": 0.1}],
        demoparser2_python="python",
    )
    assert captured["env"].get("CS2_SKIN_CORE_DEV") == "1"


def test_run_raises_skin_core_not_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CS2_SKIN_CORE_EXE", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_BUNDLE_DATA_DIR", raising=False)
    monkeypatch.setattr("app.skin_core_client._REPO_ROOT", tmp_path / "empty")
    monkeypatch.setattr("app.skin_core_client._DEV_ANYSKIN_ROOTS", ())
    with pytest.raises(SkinCoreNotFound):
        run_rewrite_owned_batch(
            input_dem=str(tmp_path / "in.dem"),
            output_dem=str(tmp_path / "out.dem"),
            steam_id64="1",
            items=[{"item_id64": "1", "definition_index": 7, "paint_kit": 1, "pattern_seed": 0, "wear": 0.1}],
            demoparser2_python="python",
        )
