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
    add_kill_feedback_track_to_payload,
    add_radar_track_to_payload,
    build_demo_voice_hud_vpk,
    build_voice_payload,
    demo_has_voice_packets,
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


def test_voice_payload_reuses_tick_roster_when_player_info_is_empty():
    # The shared roster fallback intentionally rejects tiny GOTV/disconnect
    # placeholder IDs, so exercise it with real SteamID64-shaped values.
    steam_a = 76561198000000001
    steam_b = 76561198000000002

    class _TickFallbackParser:
        def __init__(self, _path: str):
            pass

        @staticmethod
        def parse_voice():
            return [
                {"tick": 10, "steamid": steam_a, "bytes": b"one"},
                {"tick": 12, "steamid": steam_b, "bytes": b"two"},
            ]

        @staticmethod
        def parse_player_info():
            return {"steamid": [], "name": [], "team_number": []}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "round_announce_match_start":
                return {"tick": [1]}
            if name == "player_death":
                return {
                    "tick": [10, 20],
                    "attacker_name": ["one", "two"],
                    "attacker_steamid": [steam_a, steam_b],
                    "attacker_user_id": [0, 1],
                    "attackerteam": [2, 3],
                    "user_name": ["two", "one"],
                    "user_steamid": [steam_b, steam_a],
                    "user_user_id": [1, 0],
                    "userteam": [3, 2],
                }
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"] and ticks is None:
                return {
                    "tick": [1, 1],
                    "steamid": [steam_a, steam_b],
                    "last_place_name": ["CTSpawn", "TSpawn"],
                }
            tick = ticks[0]
            return {
                "tick": [tick, tick],
                "name": ["one", "two"],
                "steamid": [steam_a, steam_b],
                "user_id": [0, 1],
                "team_num": [2, 3],
                "CCSPlayerController.m_iTeamNum": [2, 3],
                "player_color": ["blue", "orange"],
            }

    payload, stats = build_voice_payload(
        "match.dem",
        parser_factory=_TickFallbackParser,
    )
    _locations, speakers, _input_tracks, roster = json.loads(payload)

    assert stats["voice_packets"] == 2
    assert stats["speakers"] == 2
    assert {(row[0], row[2]) for row in roster} == {
        (str(steam_a), 2),
        (str(steam_b), 3),
    }
    assert {row[1] for row in roster} == {0, 1}
    assert {row[1] for row in speakers} == {str(steam_a), str(steam_b)}


def test_demo_voice_probe_requires_a_non_empty_audio_packet():
    class _NoVoiceParser:
        def __init__(self, _path: str):
            pass

        @staticmethod
        def parse_voice():
            return [
                {"tick": 10, "steamid": 111, "bytes": b""},
                {"tick": 20, "steamid": 111, "bytes": None},
            ]

    assert demo_has_voice_packets("match.dem", parser_factory=_FakeParser) is True
    assert demo_has_voice_packets("silent.dem", parser_factory=_NoVoiceParser) is False


def test_unmapped_voice_packet_is_not_mistaken_for_a_silent_demo():
    class _UnmappedVoiceParser:
        def __init__(self, _path: str):
            pass

        @staticmethod
        def parse_voice():
            return [{"tick": 10, "steamid": 999, "bytes": b"voice"}]

        @staticmethod
        def parse_player_info():
            return {
                "steamid": [111],
                "name": ["known"],
                "team_number": [2],
            }

    _payload, stats = build_voice_payload(
        "match.dem",
        parser_factory=_UnmappedVoiceParser,
    )

    assert stats["voice_packets"] == 1
    assert stats["speakers"] == 0


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
    assert end - start == 8_000_000
    assert b"CS2InsightDemoVoice" in script
    assert b"CS2InsightInputHud" in script
    assert b"CS2InsightRadarHud" in script
    assert b"updateRadarHud" in script
    assert b"GetHudPlayerXuid" in script
    assert b"const povXuid = currentPovXuid(state)" in script
    assert b"const povTeam = resolvePovTeam(povXuid, state.nTick)" in script
    assert b"povTeam === 2 && sample.spottedByT" in script
    assert b"povTeam === 3 && sample.spottedByCT" in script
    assert b"updateVoiceAudience" in script
    assert b"MAX_VISIBLE_VOICE_NOTICES = 3" in script
    assert b"row * VOICE_NOTICE_ROW_HEIGHT" in script
    assert b"roster.forEach(function (player)" in script
    assert b"GameStateAPI.ToggleMute(player.xuid)" in script
    assert b"tv_listen_voice_indices -1" not in script
    assert b'const KILL_CONFIRMATION_EVENT = "UI.KillCard.1"' in script
    assert (
        b'ConsoleCommand("snd_sos_start_soundevent " + KILL_CONFIRMATION_EVENT)'
        in script
    )
    assert b"FLASH_FULL_OPAQUE_THRESHOLD_TICKS = 192" in script
    assert b"FLASH_FADE_TICKS = 128" in script
    assert b"FLASH_ACTIVE_REFRESH_SECONDS = 0.016" in script
    assert b"FLASH_IDLE_REFRESH_SECONDS = 0.05" in script
    assert b"blind ? FLASH_ACTIVE_REFRESH_SECONDS : FLASH_IDLE_REFRESH_SECONDS" in script
    assert b"if (elapsed <= holdTicks)" in script
    assert b"return Math.pow(1 - fadeProgress, 1.2)" in script
    assert b"Math.min(1, flashWashOpacity(blind, tick))" in script
    assert b"if (opacity <= 0.01)" not in script
    assert b"CS2InsightPovSoundRing" not in script
    assert b'FindChildTraverse("RI_PlayerSoundContainer")' not in script
    assert b'ConsoleCommand("cl_drawhud_force_radar 0")' not in script
    assert b'["SHIFT", 0, 0' in script
    assert b'["SPACE", 82, 112' in script
    assert b'["R", 194, 0' in script
    assert b"onlyWhenActive" in script
    assert b"765611" not in script


def test_disabled_voice_omits_speaking_schedule_but_keeps_other_payload_data():
    template_path = Path(__file__).resolve().parents[2] / "pov" / "pov_voice_template.vpk"
    build = build_demo_voice_hud_vpk(
        "match.dem",
        template_path,
        parser_factory=_FakeParser,
        voice_enabled=False,
    )
    script = read_inline_vpk(build.vpk_bytes)[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)
    payload = json.loads(script[start:end].rstrip())

    assert payload[0] == [""]
    assert payload[1] == []
    assert payload[3] == [["111", 0, 2], ["222", 1, 3]]
    assert build.voice_packets == 0
    assert build.speakers == 0
    assert build.intervals == 0


def test_radar_track_is_appended_at_payload_index_eight(monkeypatch):
    class _RadarParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"map_name": "de_dust2", "tick_rate": 64}

        @staticmethod
        def parse_event(name):
            if name == "round_start":
                return {"tick": [8, 64]}
            if name == "round_end":
                return {"tick": [24, 80]}
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"]:
                return _FakeParser.parse_ticks(fields)
            # 8Hz stride at 64 tickrate => every 8 ticks from 8..80
            sample_ticks = ticks or []
            out = {
                "tick": [],
                "steamid": [],
                "X": [],
                "Y": [],
                "yaw": [],
                "is_alive": [],
                "player_color": [],
                "team_num": [],
            }
            for tick in sample_ticks:
                out["tick"].extend([tick, tick])
                out["steamid"].extend([111, 222])
                out["X"].extend([100 + tick, 200 + tick])
                out["Y"].extend([300 + tick, 400 + tick])
                out["yaw"].extend([45, 90])
                out["is_alive"].extend([True, tick < 70])
                out["player_color"].extend(["yellow", "blue"])
                out["team_num"].extend([2, 3])
            return out

    monkeypatch.setattr(
        "app.radar.radar_map_assets.lookup_map_data",
        lambda _map: {"pos_x": -2476, "pos_y": 3239, "scale": 4.4},
    )
    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_RadarParser)
    payload, stats = add_radar_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_RadarParser,
    )
    packed = json.loads(payload)
    assert len(packed) >= 9
    radar = packed[8]
    assert radar[0] == "de_dust2"
    assert radar[1] == [-2476, 3239, 4400]
    assert radar[2] == 8
    assert stats["radar_players"] == 2
    assert stats["radar_samples"] > 0
    assert stats["radar_map"] == "de_dust2"
    xuids = {row[0] for row in radar[3]}
    assert xuids == {"111", "222"}
    assert all(isinstance(row[3], str) and row[3] for row in radar[3])


def test_radar_spotted_side_follows_live_team_and_any_current_pov(monkeypatch):
    class _SwitchingRadarParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"map_name": "de_dust2", "tick_rate": 64}

        @staticmethod
        def parse_event(name):
            if name == "round_start":
                return {"tick": [8, 48]}
            if name == "round_end":
                return {"tick": [40, 80]}
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"]:
                return _FakeParser.parse_ticks(fields)
            out = {
                "tick": [],
                "steamid": [],
                "X": [],
                "Y": [],
                "yaw": [],
                "is_alive": [],
                "player_color": [],
                "team_num": [],
                "spotted": [],
                "approximate_spotted_by": [],
            }
            for tick in ticks or []:
                # parse_player_info below is an end-of-demo snapshot (T, CT).
                # Before tick 48 the live sides are reversed; afterwards they
                # match that static snapshot. Both players currently see one
                # another so either POV side must receive its matching bit.
                teams = [3, 2] if tick < 48 else [2, 3]
                out["tick"].extend([tick, tick])
                out["steamid"].extend([111, 222])
                out["X"].extend([100 + tick, 200 + tick])
                out["Y"].extend([300 + tick, 400 + tick])
                out["yaw"].extend([45, 90])
                out["is_alive"].extend([True, True])
                out["player_color"].extend(["yellow", "blue"])
                out["team_num"].extend(teams)
                out["spotted"].extend([True, True])
                out["approximate_spotted_by"].extend([[222], [111]])
            return out

    monkeypatch.setattr(
        "app.radar.radar_map_assets.lookup_map_data",
        lambda _map: {"pos_x": -2476, "pos_y": 3239, "scale": 4.4},
    )
    voice_payload, _ = build_voice_payload(
        "match.dem",
        parser_factory=_SwitchingRadarParser,
    )
    payload, _ = add_radar_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_SwitchingRadarParser,
    )
    radar = json.loads(payload)[8]
    stride = radar[2]
    flags_by_xuid = {}
    for xuid, _color, start_token, encoded in radar[3]:
        tick = int(start_token, 36)
        flags_by_tick = {}
        for token in encoded.split(","):
            flags_by_tick[tick] = int(token.split(".")[3], 36)
            tick += stride
        flags_by_xuid[xuid] = flags_by_tick

    def live_team(xuid: str, tick: int) -> int:
        return 3 if flags_by_xuid[xuid][tick] & 16 else 2

    def current_pov_sees_enemy(viewer: str, enemy: str, tick: int) -> bool:
        viewer_team = live_team(viewer, tick)
        assert viewer_team != live_team(enemy, tick)
        spotted_bit = 4 if viewer_team == 2 else 8
        return bool(flags_by_xuid[enemy][tick] & spotted_bit)

    # Before the swap 111 is CT and 222 is T, despite the opposite static roster.
    assert live_team("111", 8) == 3
    assert live_team("222", 8) == 2
    assert current_pov_sees_enemy("111", "222", 8)
    assert current_pov_sees_enemy("222", "111", 8)

    # After the swap, selecting either player immediately uses that player's
    # new live side and the corresponding spotted bit.
    assert live_team("111", 64) == 2
    assert live_team("222", 64) == 3
    assert current_pov_sees_enemy("111", "222", 64)
    assert current_pov_sees_enemy("222", "111", 64)


def test_kill_feedback_track_is_appended_at_payload_index_nine():
    class _KillParser(_FakeParser):
        @staticmethod
        def parse_event(name):
            if name != "player_death":
                return {"tick": []}
            return {
                "tick": [100, 120, 140, 160],
                "attacker_steamid": [111, 222, 111, 111],
                "user_steamid": [222, 111, 111, 222],
                "headshot": [True, False, False, True],
                "dmg_armor": [0, 4, 0, 2],
            }

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_KillParser)
    payload, stats = add_kill_feedback_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_KillParser,
    )
    packed = json.loads(payload)
    assert len(packed) >= 10
    track = packed[9]
    assert track[0] == ["111", "222"]
    # suicide at tick 140 is dropped; remaining: 100 HS, 120 body+armor, 160 HS+armor
    assert track[1] == "2s.0.1,k.1.2,14.0.3"
    assert stats["kill_feedback_events"] == 3
    assert stats["kill_feedback_parse_failed"] == 0


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

    def fake_build(demo_path, template_path, *, input_track_report=None, voice_enabled=True):
        calls.append((Path(demo_path), Path(template_path), input_track_report, voice_enabled))
        return built

    monkeypatch.setattr(pov_hud_manager, "build_demo_voice_hud_vpk", fake_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    result = manager.install(demo_path=demo)

    assert result is built
    assert calls == [(demo, template, None, True)]
    assert (csgo / "pov.vpk").read_bytes() == b"generated"
    manifest = json.loads(manager.get_manifest_path().read_text(encoding="utf-8"))
    assert manifest["demo_voice_hud_generated"] is True
    assert manifest["demo_voice_hud"]["speakers"] == 2
