# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""AES-256-GCM frame helpers for skin-core IPC (mirror of Rust skin_crypto)."""

from __future__ import annotations

import os
import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SESSION_MAGIC = b"CS2SKIN1"
REQUEST_MAGIC = b"SKINREQ1"
RESPONSE_MAGIC = b"SKINRES1"
VERSION = 1

_SESSION_KEY_LEN = 32
_NONCE_LEN = 12
_HEADER_LEN = 8 + 1 + _NONCE_LEN


def build_session_key_frame(key: bytes) -> bytes:
    """Build the one-shot stdin auth frame: magic || u32le(32) || key[32]."""
    if len(key) != _SESSION_KEY_LEN:
        raise ValueError(f"session key must be {_SESSION_KEY_LEN} bytes")
    return SESSION_MAGIC + struct.pack("<I", _SESSION_KEY_LEN) + key


def build_frame_aad(magic: bytes, input_path: str, output_path: str) -> bytes:
    """AAD = magic[8] || version[1] || input_utf8 || output_utf8."""
    if len(magic) != 8:
        raise ValueError("frame magic must be 8 bytes")
    return (
        magic
        + bytes([VERSION])
        + input_path.encode("utf-8")
        + output_path.encode("utf-8")
    )


def encrypt_frame(magic: bytes, key: bytes, aad: bytes, plaintext: bytes) -> bytes:
    """Layout: magic || version || nonce[12] || ciphertext+tag."""
    if len(magic) != 8:
        raise ValueError("frame magic must be 8 bytes")
    if len(key) != _SESSION_KEY_LEN:
        raise ValueError(f"AES-256-GCM key must be {_SESSION_KEY_LEN} bytes")
    nonce = os.urandom(_NONCE_LEN)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad)
    return magic + bytes([VERSION]) + nonce + ciphertext


def decrypt_frame(expected_magic: bytes, key: bytes, aad: bytes, blob: bytes) -> bytes:
    if len(expected_magic) != 8:
        raise ValueError("frame magic must be 8 bytes")
    if len(blob) < _HEADER_LEN:
        raise ValueError("skin frame too short")
    if blob[:8] != expected_magic:
        raise ValueError("skin frame magic mismatch")
    if blob[8] != VERSION:
        raise ValueError(f"skin frame unsupported version: {blob[8]}")
    if len(key) != _SESSION_KEY_LEN:
        raise ValueError(f"AES-256-GCM key must be {_SESSION_KEY_LEN} bytes")
    nonce = blob[9 : 9 + _NONCE_LEN]
    ciphertext = blob[_HEADER_LEN:]
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except InvalidTag as exc:
        raise ValueError("skin frame authentication failed") from exc


def encrypt_request(
    key: bytes,
    input_path: str,
    output_path: str,
    plaintext: bytes,
) -> bytes:
    aad = build_frame_aad(REQUEST_MAGIC, input_path, output_path)
    return encrypt_frame(REQUEST_MAGIC, key, aad, plaintext)


def decrypt_response(
    key: bytes,
    input_path: str,
    output_path: str,
    blob: bytes,
) -> bytes:
    aad = build_frame_aad(RESPONSE_MAGIC, input_path, output_path)
    return decrypt_frame(RESPONSE_MAGIC, key, aad, blob)
