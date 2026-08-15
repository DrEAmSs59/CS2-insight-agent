from __future__ import annotations

from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.demo_voice_hud import (  # noqa: E402
    VOICE_DATA_BEGIN,
    VOICE_DATA_END,
    VOICE_SCRIPT_PATH,
    read_inline_vpk,
    write_inline_vpk,
)


TEMPLATE = ROOT / "pov" / "pov_voice_template.vpk"
STATIC_PACKAGE = ROOT / "pov" / "pov_default.vpk"
INJECTION = ROOT / "pov" / "voice_hud_injection.js"
STOCK_HUD_ALERTS_STYLE_PATH = "panorama/styles/hud/hudalerts.vcss_c"
HUD_ALERTS_RESOURCES = {
    "panorama/layout/hud/hudalerts.vxml_c": ROOT / "pov" / "hudalerts.vxml_c",
    "panorama/scripts/hud/hudalerts_insight.vjs_c": ROOT / "pov" / "hudalerts_insight.vjs_c",
    "panorama/styles/hud/hudalerts_insight.vcss_c": ROOT / "pov" / "hudalerts_insight.vcss_c",
}
PAYLOAD_CAPACITY = 8_000_000


def replace_data_block(resource: bytes, script: bytes) -> bytes:
    if len(resource) < 16:
        raise RuntimeError("compiled Panorama resource is truncated")
    total_size = struct.unpack_from("<I", resource, 0)[0]
    block_count = struct.unpack_from("<I", resource, 12)[0]
    if total_size != len(resource) or block_count <= 0 or block_count > 64:
        raise RuntimeError("compiled Panorama resource header is unsupported")

    descriptors: list[tuple[int, bytes, int, int]] = []
    for index in range(block_count):
        descriptor = 16 + index * 12
        if descriptor + 12 > len(resource):
            raise RuntimeError("compiled Panorama block table is truncated")
        name = resource[descriptor : descriptor + 4]
        relative_offset, size = struct.unpack_from("<II", resource, descriptor + 4)
        start = descriptor + 4 + relative_offset
        end = start + size
        if start < 0 or end > len(resource):
            raise RuntimeError(f"compiled Panorama block {name!r} exceeds the resource")
        descriptors.append((descriptor, name, start, size))

    data = next((item for item in descriptors if item[1] == b"DATA"), None)
    if data is None:
        raise RuntimeError("compiled Panorama resource has no DATA block")
    descriptor, _, data_start, old_size = data
    old_end = data_start + old_size
    delta = len(script) - old_size
    rebuilt = bytearray(resource[:data_start] + script + resource[old_end:])
    struct.pack_into("<I", rebuilt, 0, len(rebuilt))
    struct.pack_into("<I", rebuilt, descriptor + 8, len(script))
    for other_descriptor, name, start, _ in descriptors:
        if name != b"DATA" and start >= old_end:
            relative_offset = struct.unpack_from("<I", rebuilt, other_descriptor + 4)[0]
            struct.pack_into("<I", rebuilt, other_descriptor + 4, relative_offset + delta)
    return bytes(rebuilt)


def main() -> None:
    entries = read_inline_vpk(TEMPLATE.read_bytes())
    compiled = entries[VOICE_SCRIPT_PATH]

    block_count = struct.unpack_from("<I", compiled, 12)[0]
    data_source = None
    for index in range(block_count):
        descriptor = 16 + index * 12
        name = compiled[descriptor : descriptor + 4]
        relative_offset, size = struct.unpack_from("<II", compiled, descriptor + 4)
        start = descriptor + 4 + relative_offset
        if name == b"DATA":
            data_source = compiled[start : start + size]
            break
    if data_source is None:
        raise RuntimeError("template has no Panorama DATA source")

    marker = data_source.find(VOICE_DATA_BEGIN)
    if marker < 0:
        raise RuntimeError("template source contains no payload marker")
    candidates = [
        position
        for position in (
            data_source.find(b"/*__CS2_INSIGHT_INJECTION_BEGIN__*/", 0, marker),
            data_source.find(b"// Injected into the stock Panorama", 0, marker),
            data_source.rfind(b";(function CS2InsightDemoVoiceHud()", 0, marker),
            data_source.rfind(b",function(){const packed=", 0, marker),
        )
        if position >= 0
    ]
    injection_start = min(candidates, default=-1)
    if injection_start < 0:
        raise RuntimeError("could not separate the stock demo controller from its injection")
    stock_source = data_source[:injection_start].rstrip()

    injection = INJECTION.read_bytes()
    begin = injection.find(VOICE_DATA_BEGIN)
    end = injection.find(VOICE_DATA_END, begin + len(VOICE_DATA_BEGIN))
    if begin < 0 or end < 0:
        raise RuntimeError("human-readable injection contains no payload markers")
    payload_start = begin + len(VOICE_DATA_BEGIN)
    empty_payload = b"[[], [], [], []]"
    if len(empty_payload) > PAYLOAD_CAPACITY:
        raise RuntimeError("empty payload exceeds configured capacity")
    injection = b"".join(
        (
            injection[:payload_start],
            empty_payload,
            b" " * (PAYLOAD_CAPACITY - len(empty_payload)),
            injection[end:],
        )
    )
    combined_source = stock_source + b"\n" + injection
    entries[VOICE_SCRIPT_PATH] = replace_data_block(compiled, combined_source)
    entries.pop(STOCK_HUD_ALERTS_STYLE_PATH, None)
    for resource_path, source_path in HUD_ALERTS_RESOURCES.items():
        entries[resource_path] = source_path.read_bytes()
    TEMPLATE.write_bytes(write_inline_vpk(entries))

    static_entries = read_inline_vpk(STATIC_PACKAGE.read_bytes())
    static_entries.pop(STOCK_HUD_ALERTS_STYLE_PATH, None)
    for resource_path, source_path in HUD_ALERTS_RESOURCES.items():
        static_entries[resource_path] = source_path.read_bytes()
    STATIC_PACKAGE.write_bytes(write_inline_vpk(static_entries))
    print(f"template={TEMPLATE}")
    print(f"static_package={STATIC_PACKAGE}")
    print("hudalerts_resources=" + ",".join(HUD_ALERTS_RESOURCES))
    print(f"payload_capacity={PAYLOAD_CAPACITY}")
    print(f"panorama_source_bytes={len(combined_source)}")
    print(f"vpk_bytes={TEMPLATE.stat().st_size}")


if __name__ == "__main__":
    main()
