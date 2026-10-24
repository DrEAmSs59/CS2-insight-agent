"""Edit compiled Panorama DATA without invalidating later resource blocks."""

import struct
from typing import Callable


def rewrite_panorama_data(resource: bytes, edit: Callable[[bytes], bytes]) -> bytes:
    if len(resource) < 16:
        raise ValueError("compiled Panorama resource is truncated")
    total_size = struct.unpack_from("<I", resource, 0)[0]
    count = struct.unpack_from("<I", resource, 12)[0]
    if total_size != len(resource) or not 0 < count <= 64:
        raise ValueError("compiled Panorama resource header is unsupported")
    table_end = 16 + count * 12
    if table_end > len(resource):
        raise ValueError("compiled Panorama block table is truncated")
    blocks = []
    for index in range(count):
        descriptor = 16 + index * 12
        name = resource[descriptor:descriptor + 4]
        offset, size = struct.unpack_from("<II", resource, descriptor + 4)
        start = descriptor + 4 + offset
        if start < table_end or start + size > len(resource):
            raise ValueError(f"compiled Panorama block {name!r} exceeds the resource")
        blocks.append((descriptor, name, start, size))
    data_blocks = [block for block in blocks if block[1] == b"DATA"]
    if len(data_blocks) != 1:
        raise ValueError("compiled Panorama resource must have exactly one DATA block")
    descriptor, _, start, size = data_blocks[0]
    end = start + size
    if any(other != descriptor and length and pos < end and pos + length > start
           for other, _, pos, length in blocks):
        raise ValueError("compiled Panorama DATA overlaps another block")
    data = edit(resource[start:end])
    rebuilt = bytearray(resource[:start] + data + resource[end:])
    delta = len(data) - size
    struct.pack_into("<I", rebuilt, 0, len(rebuilt))
    struct.pack_into("<I", rebuilt, descriptor + 8, len(data))
    for other, _, pos, _ in blocks:
        if other != descriptor and pos >= end:
            offset = struct.unpack_from("<I", resource, other + 4)[0]
            struct.pack_into("<I", rebuilt, other + 4, offset + delta)
    return bytes(rebuilt)
