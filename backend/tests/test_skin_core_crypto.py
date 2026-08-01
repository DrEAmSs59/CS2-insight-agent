# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""AES-GCM frame helpers mirroring CS2-demo-anyskin skin_crypto / SKIN_CORE_IPC.

Interop note: closed-repo Task 1 did not ship a checked-in hex golden vector.
Python round-trips cover layout + AEAD here. When available, copy Rust vectors
into ``backend/tests/fixtures/skin_frame_roundtrip.json`` and load them below.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from app.skin_core_crypto import (
    REQUEST_MAGIC,
    RESPONSE_MAGIC,
    SESSION_MAGIC,
    VERSION,
    build_session_key_frame,
    decrypt_frame,
    decrypt_response,
    encrypt_frame,
    encrypt_request,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLDEN_PATH = FIXTURES / "skin_frame_roundtrip.json"


def test_session_magic_and_auth_frame_layout():
    assert SESSION_MAGIC == b"CS2SKIN1"
    key = bytes(range(32))
    frame = build_session_key_frame(key)
    assert frame[:8] == SESSION_MAGIC
    assert struct.unpack_from("<I", frame, 8)[0] == 32
    assert frame[12:] == key
    assert len(frame) == 44


def test_encrypt_request_round_trip():
    key = bytes([0x42] * 32)
    plaintext = b'{"schema_version":1,"ok":true}'
    blob = encrypt_request(key, "in.dem", "out.dem", plaintext)
    assert blob[:8] == REQUEST_MAGIC
    assert blob[8] == VERSION
    assert len(blob) > 8 + 1 + 12

    aad = REQUEST_MAGIC + bytes([VERSION]) + b"in.dem" + b"out.dem"
    recovered = decrypt_frame(REQUEST_MAGIC, key, aad, blob)
    assert recovered == plaintext


def test_decrypt_response_round_trip():
    key = bytes([0x42] * 32)
    plaintext = b'{"schema_version":1,"ok":true,"sha256":"abc"}'
    aad = RESPONSE_MAGIC + bytes([VERSION]) + b"in.dem" + b"out.dem"
    blob = encrypt_frame(RESPONSE_MAGIC, key, aad, plaintext)
    assert decrypt_response(key, "in.dem", "out.dem", blob) == plaintext


def test_reject_wrong_magic_and_bad_aad():
    key = bytes([0x42] * 32)
    plaintext = b'{"ok":true}'
    blob = encrypt_request(key, "in.dem", "out.dem", plaintext)
    bad = bytearray(blob)
    bad[:8] = RESPONSE_MAGIC
    aad = REQUEST_MAGIC + bytes([VERSION]) + b"in.dem" + b"out.dem"
    with pytest.raises(ValueError):
        decrypt_frame(REQUEST_MAGIC, key, aad, bytes(bad))

    with pytest.raises(ValueError):
        decrypt_response(key, "other.dem", "out.dem", encrypt_frame(
            RESPONSE_MAGIC,
            key,
            RESPONSE_MAGIC + bytes([VERSION]) + b"in.dem" + b"out.dem",
            plaintext,
        ))


def test_optional_rust_golden_fixture_when_present():
    """Load cross-language golden vectors when the fixture file exists."""
    if not GOLDEN_PATH.is_file():
        pytest.skip(
            "Rust golden vectors not yet copied to "
            "backend/tests/fixtures/skin_frame_roundtrip.json"
        )
    data = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    key = bytes.fromhex(data["key_hex"])
    blob = bytes.fromhex(data["blob_hex"])
    plaintext = data["plaintext"].encode("utf-8")
    magic = data["magic"].encode("ascii")
    aad = (
        magic
        + bytes([data["version"]])
        + data["input_path"].encode("utf-8")
        + data["output_path"].encode("utf-8")
    )
    assert decrypt_frame(magic, key, aad, blob) == plaintext
