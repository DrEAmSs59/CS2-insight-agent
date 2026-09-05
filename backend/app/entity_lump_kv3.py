"""Scale ``light_environment`` direct brightness inside compiled entity lumps.

CS2 ``r_directlighting`` is only 0/1. Rain therefore edits the compiled
``default_ents.vents_c`` KV3 and halves the environment sun's stored
``brightness`` double, leaving bounce/sky terms and other lights unchanged.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any

import cramjam
import lz4.block

from .skybox_resources import SkyboxResourceError, _resource_blocks


class EntityLumpKv3Error(RuntimeError):
    """The compiled entity lump could not be parsed or patched safely."""


@dataclass(frozen=True)
class LightEnvironmentInfo:
    classname: str
    brightness: float
    brightnessscale: float


_NULL = 1
_BOOLEAN = 2
_INT64 = 3
_UINT64 = 4
_DOUBLE = 5
_STRING = 6
_BINARY_BLOB = 7
_ARRAY = 8
_OBJECT = 9
_ARRAY_TYPED = 10
_INT32 = 11
_UINT32 = 12
_BOOLEAN_TRUE = 13
_BOOLEAN_FALSE = 14
_INT64_ZERO = 15
_INT64_ONE = 16
_DOUBLE_ZERO = 17
_DOUBLE_ONE = 18
_FLOAT = 19
_INT16 = 20
_UINT16 = 21
_INT32_AS_BYTE = 22
_ARRAY_TYPE_BYTE_LENGTH = 23
_ARRAY_TYPE_AUXILIARY_BUFFER = 24

_TRAILER = 0xFFEEDD00
_DATA_COMPRESSED_TOTAL_OFFSET = 52
_DATA_COMPRESSED_BUFFER2_OFFSET = 84
_DATA_HEADER_SIZE = 120


def _align(offset: int, alignment: int) -> int:
    alignment -= 1
    offset += alignment
    return offset & ~alignment


@dataclass
class _Buf:
    bytes1: memoryview
    bytes2: memoryview
    bytes4: memoryview
    bytes8: memoryview
    bytes8_origin: int = 0
    bytes8_taken: int = 0

    def take1(self) -> int:
        value = int(self.bytes1[0])
        self.bytes1 = self.bytes1[1:]
        return value

    def take2(self) -> int:
        value = struct.unpack_from("<H", self.bytes2, 0)[0]
        self.bytes2 = self.bytes2[2:]
        return value

    def take4(self) -> int:
        value = struct.unpack_from("<i", self.bytes4, 0)[0]
        self.bytes4 = self.bytes4[4:]
        return value

    def take_u32(self) -> int:
        value = struct.unpack_from("<I", self.bytes4, 0)[0]
        self.bytes4 = self.bytes4[4:]
        return value

    def take8(self) -> bytes:
        value = bytes(self.bytes8[:8])
        self.bytes8 = self.bytes8[8:]
        self.bytes8_taken += 8
        return value

    def take_f64(self) -> tuple[float, int]:
        offset = self.bytes8_origin + self.bytes8_taken
        value = struct.unpack_from("<d", self.bytes8, 0)[0]
        self.take8()
        return value, offset


@dataclass
class _Ctx:
    strings: list[str]
    types: memoryview
    object_lengths: memoryview
    binary_blobs: memoryview
    binary_blob_lengths: memoryview
    buffer: _Buf
    aux: _Buf
    environments: list[dict[str, Any]] = field(default_factory=list)


def _split_buffer(
    span: bytes,
    *,
    count1: int,
    count2: int,
    count4: int,
    count8: int,
    start: int = 0,
) -> tuple[_Buf, int]:
    offset = start
    bytes1 = span[offset : offset + count1]
    offset += count1
    if count2:
        offset = _align(offset, 2)
        bytes2 = span[offset : offset + count2 * 2]
        offset += count2 * 2
    else:
        bytes2 = b""
    if count4:
        offset = _align(offset, 4)
        bytes4 = span[offset : offset + count4 * 4]
        offset += count4 * 4
    else:
        bytes4 = b""
    bytes8_origin = offset
    if count8:
        offset = _align(offset, 8)
        bytes8_origin = offset
        bytes8 = span[offset : offset + count8 * 8]
        offset += count8 * 8
    else:
        bytes8 = b""
    return (
        _Buf(
            memoryview(bytes1),
            memoryview(bytes2),
            memoryview(bytes4),
            memoryview(bytes8),
            bytes8_origin=bytes8_origin,
        ),
        offset,
    )


def _read_type(ctx: _Ctx) -> int:
    databyte = int(ctx.types[0])
    ctx.types = ctx.types[1:]
    if databyte & 0x80:
        databyte &= 0x3F
        ctx.types = ctx.types[1:]
    return databyte


def _read_node(ctx: _Ctx) -> Any:
    return _read_value(ctx, _read_type(ctx))


def _read_value(ctx: _Ctx, datatype: int) -> Any:
    buf = ctx.buffer
    if datatype == _NULL:
        return None
    if datatype == _BOOLEAN_TRUE:
        return True
    if datatype == _BOOLEAN_FALSE:
        return False
    if datatype == _INT64_ZERO:
        return 0
    if datatype == _INT64_ONE:
        return 1
    if datatype == _DOUBLE_ZERO:
        return 0.0
    if datatype == _DOUBLE_ONE:
        return 1.0
    if datatype == _BOOLEAN:
        return buf.take1() == 1
    if datatype == _INT32_AS_BYTE:
        return buf.take1()
    if datatype in (_INT16, _UINT16):
        return buf.take2()
    if datatype == _INT32:
        return buf.take4()
    if datatype == _UINT32:
        return buf.take_u32()
    if datatype == _FLOAT:
        raw = buf.take4()
        return struct.unpack("<f", struct.pack("<i", raw))[0]
    if datatype in (_INT64, _UINT64):
        return buf.take8()
    if datatype == _DOUBLE:
        value, offset = buf.take_f64()
        return ("double", value, offset)
    if datatype == _STRING:
        string_id = buf.take4()
        if string_id == -1:
            return ""
        return ctx.strings[string_id]
    if datatype == _BINARY_BLOB:
        length = struct.unpack_from("<i", ctx.binary_blob_lengths, 0)[0]
        ctx.binary_blob_lengths = ctx.binary_blob_lengths[4:]
        blob = bytes(ctx.binary_blobs[:length])
        ctx.binary_blobs = ctx.binary_blobs[length:]
        return blob
    if datatype == _ARRAY:
        length = buf.take4()
        return [_read_node(ctx) for _ in range(length)]
    if datatype in (_ARRAY_TYPED, _ARRAY_TYPE_BYTE_LENGTH):
        length = buf.take1() if datatype == _ARRAY_TYPE_BYTE_LENGTH else buf.take4()
        subtype = _read_type(ctx)
        return [_read_value(ctx, subtype) for _ in range(length)]
    if datatype == _ARRAY_TYPE_AUXILIARY_BUFFER:
        length = buf.take1()
        subtype = _read_type(ctx)
        ctx.aux, ctx.buffer = ctx.buffer, ctx.aux
        try:
            return [_read_value(ctx, subtype) for _ in range(length)]
        finally:
            ctx.aux, ctx.buffer = ctx.buffer, ctx.aux
    if datatype == _OBJECT:
        length = struct.unpack_from("<i", ctx.object_lengths, 0)[0]
        ctx.object_lengths = ctx.object_lengths[4:]
        obj: dict[str, Any] = {}
        double_offsets: dict[str, int] = {}
        for _ in range(length):
            field_type = _read_type(ctx)
            string_id = buf.take4()
            name = "" if string_id == -1 else ctx.strings[string_id]
            value = _read_value(ctx, field_type)
            if isinstance(value, tuple) and value and value[0] == "double":
                _tag, number, offset = value
                obj[name] = number
                double_offsets[name] = offset
            else:
                obj[name] = value
        if obj.get("classname") == "light_environment":
            ctx.environments.append(
                {
                    "values": obj,
                    "double_offsets": double_offsets,
                }
            )
        return obj
    raise EntityLumpKv3Error(f"unsupported KV3 node type: {datatype}")


def _decompress_kv3(method: int, payload: bytes, uncompressed: int) -> bytes:
    try:
        if method == 1:
            return lz4.block.decompress(payload, uncompressed_size=uncompressed)
        if method == 2:
            return bytes(cramjam.zstd.decompress(payload, output_len=uncompressed))
    except (ValueError, lz4.block.LZ4BlockError, cramjam.DecompressionError) as exc:
        raise EntityLumpKv3Error("compiled entity lump KV3 buffers are corrupt") from exc
    raise EntityLumpKv3Error(f"unsupported KV3 compression method: {method}")


def _compress_kv3(method: int, payload: bytes) -> bytes:
    if method == 1:
        return lz4.block.compress(payload, store_size=False)
    if method == 2:
        return bytes(cramjam.zstd.compress(payload))
    raise EntityLumpKv3Error(f"unsupported KV3 compression method: {method}")


def _parse(body: bytes) -> tuple[bytes, bytes, bytes, bytes, _Ctx, LightEnvironmentInfo]:
    try:
        blocks, _declared = _resource_blocks(body)
    except SkyboxResourceError as exc:
        raise EntityLumpKv3Error("compiled entity lump is not a Source 2 resource") from exc
    if "DATA" not in blocks:
        raise EntityLumpKv3Error("compiled entity lump is missing a DATA block")
    data_off, data_sz = blocks["DATA"]
    data = body[data_off : data_off + data_sz]
    if len(data) < _DATA_HEADER_SIZE:
        raise EntityLumpKv3Error("compiled entity lump DATA block is truncated")
    magic = struct.unpack_from("<I", data, 0)[0]
    if (magic & 0xFFFFFF00) != 0x4B563300 or (magic & 0xFF) != 5:
        raise EntityLumpKv3Error("compiled entity lump is not binary KV3 version 5")
    pos = 20
    method = struct.unpack_from("<I", data, pos)[0]
    pos += 4
    pos += 4
    count_bytes1, count_bytes4, count_bytes8, count_types = struct.unpack_from(
        "<4i", data, pos
    )
    pos += 16
    pos += 4
    _size_uncomp_total, _size_comp_total, count_blocks, _size_blobs = struct.unpack_from(
        "<4i", data, pos
    )
    pos += 16
    count_bytes2, _size_block_comp = struct.unpack_from("<2i", data, pos)
    pos += 8
    (
        size_uncomp1,
        size_comp1,
        size_uncomp2,
        size_comp2,
        count_bytes1_b2,
        count_bytes2_b2,
        count_bytes4_b2,
        count_bytes8_b2,
        _unk13,
        count_objects_b2,
        _count_arrays_b2,
        _unk16,
    ) = struct.unpack_from("<12i", data, pos)
    pos += 48
    buf1 = _decompress_kv3(method, data[pos : pos + size_comp1], size_uncomp1)
    pos += size_comp1
    buf2 = _decompress_kv3(method, data[pos : pos + size_comp2], size_uncomp2)
    pos += size_comp2
    trailer = data[pos:]
    aux, _aux_end = _split_buffer(
        buf1,
        count1=count_bytes1,
        count2=count_bytes2,
        count4=count_bytes4,
        count8=count_bytes8,
    )
    if len(aux.bytes4) < 4:
        raise EntityLumpKv3Error("compiled entity lump string table is truncated")
    count_strings = struct.unpack_from("<i", aux.bytes4, 0)[0]
    aux.bytes4 = aux.bytes4[4:]
    strings: list[str] = []
    rest = bytes(aux.bytes1)
    cursor = 0
    for _ in range(count_strings):
        end = rest.find(b"\0", cursor)
        if end < 0:
            raise EntityLumpKv3Error("compiled entity lump string table is truncated")
        strings.append(rest[cursor:end].decode("utf-8"))
        cursor = end + 1
    aux.bytes1 = memoryview(rest[cursor:])
    object_len_bytes = count_objects_b2 * 4
    object_lengths = memoryview(buf2[:object_len_bytes])
    main, main_end = _split_buffer(
        buf2,
        count1=count_bytes1_b2,
        count2=count_bytes2_b2,
        count4=count_bytes4_b2,
        count8=count_bytes8_b2,
        start=object_len_bytes,
    )
    types = memoryview(buf2[main_end : main_end + count_types])
    after_types = main_end + count_types
    blob_len_bytes = count_blocks * 4
    binary_blob_lengths = memoryview(buf2[after_types : after_types + blob_len_bytes])
    ctx = _Ctx(
        strings=strings,
        types=types,
        object_lengths=object_lengths,
        binary_blobs=memoryview(b""),
        binary_blob_lengths=binary_blob_lengths,
        buffer=main,
        aux=aux,
    )
    try:
        _read_node(ctx)
    except (EntityLumpKv3Error, struct.error, IndexError, UnicodeDecodeError) as exc:
        raise EntityLumpKv3Error("compiled entity lump KV3 walk failed") from exc
    if (
        ctx.types
        or ctx.object_lengths
        or ctx.buffer.bytes1
        or ctx.buffer.bytes2
        or ctx.buffer.bytes4
        or ctx.buffer.bytes8
        or ctx.binary_blob_lengths
    ):
        raise EntityLumpKv3Error("compiled entity lump KV3 walk left unread bytes")
    if len(ctx.environments) != 1:
        raise EntityLumpKv3Error(
            f"expected exactly one light_environment, found {len(ctx.environments)}"
        )
    env = ctx.environments[0]
    values = env["values"]
    info = LightEnvironmentInfo(
        classname=str(values.get("classname") or ""),
        brightness=float(values.get("brightness") or 0.0),
        brightnessscale=float(values.get("brightnessscale") or 1.0),
    )
    return body, data, buf2, trailer, ctx, info


def inspect_light_environment(body: bytes) -> LightEnvironmentInfo:
    *_rest, info = _parse(body)
    return info


def _replace_data_block(body: bytes, new_data: bytes) -> bytes:
    blocks, _declared = _resource_blocks(body)
    data_off, data_sz = blocks["DATA"]
    if data_off + data_sz != len(body):
        raise EntityLumpKv3Error("compiled entity lump DATA block is not the final block")
    new_body = bytearray(body[:data_off] + new_data)
    struct.pack_into("<I", new_body, 0, len(new_body))
    declared_size, _header_version, _resource_version, block_offset, block_count = (
        struct.unpack_from("<IHHII", body, 0)
    )
    table_start = 8 + block_offset
    for index in range(block_count):
        entry = table_start + index * 12
        if bytes(new_body[entry : entry + 4]) == b"DATA":
            struct.pack_into("<I", new_body, entry + 8, len(new_data))
            return bytes(new_body)
    raise EntityLumpKv3Error("compiled entity lump DATA block table entry is missing")


def scale_light_environment_direct_brightness(
    body: bytes,
    factor: float = 0.5,
) -> bytes:
    if factor <= 0:
        raise EntityLumpKv3Error("direct brightness scale factor must be positive")
    original, data, buf2, trailer, ctx, info = _parse(body)
    env = ctx.environments[0]
    offsets: dict[str, int] = env["double_offsets"]
    if "brightness" not in offsets:
        raise EntityLumpKv3Error("light_environment brightness is not a stored double")
    patched = bytearray(buf2)
    struct.pack_into("<d", patched, offsets["brightness"], info.brightness * factor)
    method = struct.unpack_from("<I", data, 20)[0]
    compressed = _compress_kv3(method, bytes(patched))
    old_comp2 = struct.unpack_from("<i", data, _DATA_COMPRESSED_BUFFER2_OFFSET)[0]
    old_total = struct.unpack_from("<i", data, _DATA_COMPRESSED_TOTAL_OFFSET)[0]
    header = bytearray(data[:_DATA_HEADER_SIZE])
    struct.pack_into("<i", header, _DATA_COMPRESSED_BUFFER2_OFFSET, len(compressed))
    struct.pack_into(
        "<i",
        header,
        _DATA_COMPRESSED_TOTAL_OFFSET,
        old_total - old_comp2 + len(compressed),
    )
    size_comp1 = struct.unpack_from("<i", data, 76)[0]
    buf1_comp = data[_DATA_HEADER_SIZE : _DATA_HEADER_SIZE + size_comp1]
    new_data = bytes(header) + buf1_comp + compressed + trailer
    return _replace_data_block(original, new_data)
