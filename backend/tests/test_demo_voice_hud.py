import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.demo_voice_hud import (
    DemoVoiceHudBuild,
    DemoVoiceHudError,
    VOICE_DATA_BEGIN,
    VOICE_DATA_END,
    VOICE_SCRIPT_PATH,
    add_input_tracks_to_payload,
    build_voice_payload,
    inject_voice_payload,
    read_inline_vpk,
    write_inline_vpk,
)
from app import pov_hud_manager
from app.pov_hud_manager import PovHudManager


class _FakeParser:
    def __init__(self, _path: str):
        pass

    @staticmethod
    def parse_voice():
        return [
            {"tick": 10, "steamid": 222, "bytes": b"voice"},
            {"tick": 18, "steamid": 222, "bytes": b"voice"},
            {"tick": 50, "steamid": 222, "bytes": b"voice"},
            {"tick": 12, "steamid": 111, "bytes": b"voice"},
            {"tick": 13, "steamid": 111, "bytes": b""},
        ]

    @staticmethod
    def parse_ticks(_fields):
        return {
            "tick": [1, 1, 20, 20, 40, 40],
            "steamid": [111, 222, 111, 222, 111, 222],
            "last_place_name": ["CTSpawn", "TSpawn", "BombsiteA", "Middle", "BombsiteA", "Middle"],
        }

    @staticmethod
    def parse_player_info():
        return {
            "steamid": [111, 222],
            "name": ["one", "two"],
            "team_number": [2, 3],
        }


def test_voice_payload_compacts_intervals_and_location_changes():
    payload, stats = build_voice_payload("match.dem", parser_factory=_FakeParser)
    location_tokens, speakers, input_tracks, roster = json.loads(payload)

    assert stats == {
        "voice_packets": 4,
        "speakers": 2,
        "intervals": 3,
        "location_changes": 4,
        "payload_bytes": len(payload),
        "location_parse_failed": 0,
    }
    assert location_tokens == ["", "CTSpawn", "BombsiteA", "TSpawn", "Middle"]
    assert speakers == [
        [0, "111", "c.c", "1.1,j.2"],
        [1, "222", "a.k,14.c", "1.3,j.4"],
    ]
    assert input_tracks == []
    assert roster == [["111", 0, 2], ["222", 1, 3]]


def test_exact_input_tracks_are_mapped_from_usercmd_slots_to_xuids():
    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_FakeParser)
    payload, stats = add_input_tracks_to_payload(
        voice_payload,
        "match.dem",
        {
            "commands": 100,
            "button_updates": 25,
            "subtick_steps": 12,
            "tracks": [
                {"slot": 1, "changes": 3, "encoded": "a.1,2.0,4.8"},
                {"slot": 0, "changes": 2, "encoded": "b.2,1.0"},
            ],
        },
        parser_factory=_FakeParser,
    )

    packed = json.loads(payload)
    assert packed[2] == [["222", "a.1,2.0,4.8"], ["111", "b.2,1.0"]]
    assert stats == {
        "input_tracks": 2,
        "input_changes": 5,
        "input_commands": 100,
        "input_button_updates": 25,
        "input_subtick_steps": 12,
    }


def test_inline_vpk_round_trip_preserves_entries_and_checks_crc():
    entries = {
        "panorama/scripts/hud/test.vts_c": b"script",
        "panorama/styles/hud/test.vcss_c": b"style",
    }
    packed = write_inline_vpk(entries)

    assert read_inline_vpk(packed) == entries

    damaged = bytearray(packed)
    damaged[-1] ^= 1
    with pytest.raises(DemoVoiceHudError, match="CRC"):
        read_inline_vpk(bytes(damaged))


def test_voice_payload_injection_is_bounded_and_rebuilds_vpk():
    template_script = b"before" + VOICE_DATA_BEGIN + (b" " * 12) + VOICE_DATA_END + b"after"
    template = write_inline_vpk({VOICE_SCRIPT_PATH: template_script})

    generated = inject_voice_payload(template, b"[[\"A\"],[]]")
    script = read_inline_vpk(generated)[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)
    assert script[start:end].rstrip() == b"[[\"A\"],[]]"

    with pytest.raises(DemoVoiceHudError, match="template holds 12"):
        inject_voice_payload(template, b"x" * 13)


def test_checked_in_voice_template_contains_only_an_empty_payload():
    template_path = Path(__file__).resolve().parents[2] / "pov" / "pov_voice_template.vpk"
    entries = read_inline_vpk(template_path.read_bytes())
    script = entries[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)

    assert script[start:end].rstrip() == b"[[], [], [], []]"
    assert end - start == 400_000
    assert b"CS2InsightDemoVoice" in script
    assert b"CS2InsightInputHud" in script
    assert b"GetHudPlayerXuid" in script
    assert b"updateVoiceAudience" in script
    assert b"tv_listen_voice_indices -1" not in script
    assert b'["SHIFT", 0, 0' in script
    assert b'["SPACE", 82, 112' in script
    assert b'["R", 194, 0' in script
    assert b"onlyWhenActive" in script
    assert b"765611" not in script


def test_pov_manager_installs_generated_voice_package(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    (csgo / "gameinfo.gi").write_text(
        "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n",
        encoding="utf-8",
    )
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    (pov_dir / "pov_default.vpk").write_bytes(b"static")
    template = pov_dir / "pov_voice_template.vpk"
    template.write_bytes(b"template")

    built = DemoVoiceHudBuild(
        vpk_bytes=b"generated",
        voice_packets=4,
        speakers=2,
        intervals=3,
        location_changes=4,
        payload_bytes=50,
        location_parse_failed=0,
    )
    calls = []

    def fake_build(demo_path, template_path, *, input_track_report=None):
        calls.append((Path(demo_path), Path(template_path), input_track_report))
        return built

    monkeypatch.setattr(pov_hud_manager, "build_demo_voice_hud_vpk", fake_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    manager.install(demo_path=demo)

    assert calls == [(demo, template, None)]
    assert (csgo / "pov.vpk").read_bytes() == b"generated"
    manifest = json.loads(manager.get_manifest_path().read_text(encoding="utf-8"))
    assert manifest["demo_voice_hud_generated"] is True
    assert manifest["demo_voice_hud"]["speakers"] == 2
