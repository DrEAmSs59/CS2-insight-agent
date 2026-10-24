"""Reject old interpreters before installing or reusing desktop runtime files."""

import struct
import sys


def verify_python_version(version=None, pointer_bits=None):
    version = sys.version_info[:3] if version is None else version
    pointer_bits = struct.calcsize("P") * 8 if pointer_bits is None else pointer_bits
    if version[:2] != (3, 12) or version < (3, 12, 15) or pointer_bits != 64:
        raise RuntimeError("Desktop packaging requires 64-bit CPython 3.12.15+ (3.12.x).")


if __name__ == "__main__":
    verify_python_version()
    print(f"[desktop] Python {sys.version.split()[0]}: {sys.executable}")
