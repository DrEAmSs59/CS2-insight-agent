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
    _build_player_sound_track,
    _kill_cash_award,
    _weapon_fire_sound_radius,
    add_advanced_playback_track_to_payload,
    add_flash_blind_track_to_payload,
    add_input_tracks_to_payload,
    add_kill_feedback_track_to_payload,
    add_radio_track_to_payload,
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


def test_advanced_playback_payload_indexes_players_kills_deaths_and_utility():
    class _AdvancedParser(_FakeParser):
        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "round_announce_match_start":
                return {"tick": [10]}
            if name == "round_start":
                return {"tick": [20, 200]}
            if name == "player_death":
                return {
                    "tick": [100],
                    "attacker_steamid": [111],
                    "user_steamid": [222],
                    "weapon": ["ak47"],
                    "headshot": [True],
                    "thrusmoke": [True],
                    "penetrated": [2],
                    "noscope": [True],
                    "attackerblind": [True],
                    "assistedflash": [True],
                }
            if name == "grenade_thrown":
                return {
                    "tick": [120],
                    "user_steamid": [111],
                    "weapon": ["smokegrenade"],
                }
            if name == "weapon_fire":
                return {
                    "tick": [110],
                    "user_steamid": [111],
                    "weapon": ["smokegrenade"],
                }
            return {"tick": []}

        @staticmethod
        def parse_header():
            return {"playback_ticks": 6400, "playback_time": 100.0}

    voice_payload, _voice_stats = build_voice_payload(
        "match.dem",
        parser_factory=_AdvancedParser,
    )
    payload, stats = add_advanced_playback_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_AdvancedParser,
    )
    advanced = json.loads(payload)[12]

    assert stats["advanced_playback_enabled"] == 1
    assert stats["advanced_playback_players"] == 2
    assert stats["advanced_playback_events"] == 2
    assert stats["advanced_playback_rounds"] == 2
    assert stats["advanced_playback_total_tick"] == 6400
    assert advanced[0] == 1
    assert advanced[1] == 64000
    assert advanced[2] == [
        ["111", "one", 2, 0],
        ["222", "two", 3, 1],
    ]
    assert "ak47" in advanced[3]
    assert "smokegrenade" in advanced[3]
    assert len(advanced[4].split(",")) == 2
    kill_fields = advanced[4].split(",")[0].split(".")
    assert int(kill_fields[5], 36) == 63
    assert advanced[5] == 6400
    assert advanced[6] == [[1, 20, 199], [2, 200, 6400]]


def test_voice_payload_reuses_tick_roster_when_player_info_is_empty():
    steam_id_one = 76561198000000111
    steam_id_two = 76561198000000222

    class _TickFallbackParser:
        def __init__(self, _path: str):
            pass

        @staticmethod
        def parse_voice():
            return [
                {"tick": 10, "steamid": steam_id_one, "bytes": b"one"},
                {"tick": 12, "steamid": steam_id_two, "bytes": b"two"},
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
                    "attacker_steamid": [steam_id_one, steam_id_two],
                    "attacker_user_id": [0, 1],
                    "attackerteam": [2, 3],
                    "user_name": ["two", "one"],
                    "user_steamid": [steam_id_two, steam_id_one],
                    "user_user_id": [1, 0],
                    "userteam": [3, 2],
                }
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"] and ticks is None:
                return {
                    "tick": [1, 1],
                    "steamid": [steam_id_one, steam_id_two],
                    "last_place_name": ["CTSpawn", "TSpawn"],
                }
            tick = ticks[0]
            return {
                "tick": [tick, tick],
                "name": ["one", "two"],
                "steamid": [steam_id_one, steam_id_two],
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
        (str(steam_id_one), 2),
        (str(steam_id_two), 3),
    }
    assert {row[1] for row in roster} == {0, 1}
    assert {row[1] for row in speakers} == {str(steam_id_one), str(steam_id_two)}


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
    injection_source = template_path.with_name("voice_hud_injection.js").read_bytes()
    entries = read_inline_vpk(template_path.read_bytes())
    alert_script = entries["panorama/scripts/hud/hudalerts_insight.vjs_c"]
    alert_style = entries["panorama/styles/hud/hudalerts_insight.vcss_c"]
    script = entries[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)

    assert script[start:end].rstrip() == b"[[], [], [], []]"
    assert "panorama/layout/hud/hudalerts.vxml_c" in entries
    assert "panorama/styles/hud/hudalerts.vcss_c" not in entries
    assert "panorama/styles/hud/hudhealthammocenter.vcss_c" not in entries
    assert "panorama/styles/hud/hudradar.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter-equipmentinfo.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter.vcss_c" in entries
    assert b"CSGOHudAlerts.CS2InsightSeekSuppress" in alert_style
    assert b"CSGOHudAlerts.CS2InsightPausedSeekSuppress" in alert_style
    assert b"PanoramaGameTimeJumpEvent" in alert_script
    assert b"SEEK_SETTLE_SAMPLES = 60" in alert_script
    assert b"HIDDEN_STABLE_SAMPLES = 10" in alert_script
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
    assert b"FLASH_BUILD_UP_SECONDS = (255 / 45) / 60" in script
    assert b"FLASH_CERTAIN_BLIND_SECONDS = 3" in script
    assert b"FLASH_PAYLOAD_VERSION = 2" in script
    assert b"FLASH_FULL_DURATION_TICKS" not in script
    assert b"FLASH_ACTIVE_REFRESH_SECONDS = 0.016" in script
    assert b"FLASH_IDLE_REFRESH_SECONDS = 0.05" in script
    assert b"blind ? FLASH_ACTIVE_REFRESH_SECONDS : FLASH_IDLE_REFRESH_SECONDS" in script
    assert b"const wasActive = Boolean(state && event.tick < state.endTick)" in script
    assert b"endTick: event.tick + event.durationTicks" in script
    assert b"Math.pow(remainingSeconds / FLASH_CERTAIN_BLIND_SECONDS, 2)" in script
    assert b"const afterimage = strength * (1 - Math.pow(1 - screenshot, 4))" in script
    assert b"let cover = 1 - (1 - white) * (1 - afterimage)" in script
    assert b"Math.min(1, flashWashOpacity(blind, tick))" in script
    assert b"if (opacity <= 0.01)" not in script
    assert b'findHudTraverse("ChatHistoryText")' in script
    assert b'"PanoramaGameTimeJumpEvent"' not in script
    assert b"TRANSIENT_HUD_TICK_JUMP_THRESHOLD = 64" in script
    assert b"TRANSIENT_HUD_RESUME_GRACE_TICKS = 32" in script
    assert b'STOCK_HUD_ALERT_SUPPRESS_CLASS = "CS2InsightPausedSeekSuppress"' in script
    assert b"STOCK_HUD_ALERT_RESUME_GRACE_TICKS = 128" in script
    assert b"STOCK_HUD_ALERT_HIDDEN_STABLE_FRAMES = 10" in script
    assert b"if (!hud || state.bIsPaused || tick <= transientHudSuppressUntilTick)" in script
    assert b"$.Schedule(0.016, watchDemoTimeJumps)" in script
    assert b"$.Schedule(0, watchDemoTimeJumps)" in script
    assert b'findHudTraverse("AlertText")' in script
    assert b"armStockHudAlertSeekSuppress(state, tick)" in script
    assert b"updateStockHudAlertSeekSuppress(state, tick)" in script
    assert b'GameInterfaceAPI.ConsoleCommand("hud_reloadscheme")' not in script
    assert b"CS2InsightPovSoundRing" in script
    assert b'FindChildTraverse("RI_PlayerSoundContainer")' in script
    assert b"radarTrack.nativeSoundComplete" in script
    assert b"belongsToNativeSoundRoot(pack)" in script
    assert b"updatePovSoundRings(nativeRadar, tick, povXuid, povSample)" in script
    assert b"nativeSoundComplete describes the event source, not Panorama playback" in script
    assert b"setNativeSoundRingsVisible(nativeRadar, false)" in script
    assert b"setNativeSoundRingsVisible(nativeRadar, true)" in script
    assert b"updatePovUnclipFx(nativeRadar, tick, povXuid, povSample, povTeam)" in script
    assert b"const MAX_POV_SOUND_RINGS = 10" in script
    assert b"fx.soundRings[soundIndex]" in script
    assert b"return active.slice(0, MAX_POV_SOUND_RINGS)" in script
    assert b"Math.abs(candidate.radius - existing.radius)" not in script
    assert b"function annotateContinuousStepSounds(sounds, tickRate)" in script
    assert b"rows[index].stepStateEndTick = last.tick + releaseTicks" in script
    assert b"const activeSteps = {}" in script
    assert b'? "1"' in script
    assert b"function assignPovSoundsToSlots(fx, active)" in script
    assert b"ring._insightSoundKey !== soundKey" in script
    assert b"panelRadius >= maxClassThreshold" in script
    assert b"ring.SetParent(anchor)" in script
    assert b"const POV_RADAR_SCALE = 0.4" in script
    assert b"return POV_RADAR_SCALE" in script
    assert b"function radarScaleFromNativeTransform" not in script
    assert b'GetSettingFloat("cl_radar_scale")' not in script
    assert b'GameInterfaceAPI.GetSettingFloat("cl_radar_icon_scale_min")' in script
    assert b"function nativeRadarIconScale(centeredScale)" in script
    assert b"const panelRadius = Math.floor(" in script
    assert b"const visualPanelRadius = Number(sound.radius) <= 120" in script
    assert b"? Math.max(12, panelRadius)" in script
    assert b"diameter: 2 * Math.max(0, visualPanelRadius) * iconScale" in script
    assert b'ring.style.border = "1px solid #ffffff40"' in script
    assert b"2px solid #ffffff80" not in script
    assert b"hostWidth / RADAR_MAP_SIZE" not in script
    assert b'fx.rotated.style.transform = "rotateZ("' in script
    assert b'fx.frustum.style.width = "128px"' in script
    assert b'fx.anchor.style.position = "50% 50% 0px"' in script
    assert b'fx.anchor.style.x = "0px"' not in script
    assert b'fx.anchor.style.y = "0px"' not in script
    assert b'ConsoleCommand("cl_drawhud_force_radar 0")' not in script
    assert b'["SHIFT", 0, 0' in script
    assert b'["SPACE", 82, 112' in script
    assert b'["R", 194, 0' in script
    assert b"onlyWhenActive" in script
    assert b'findHudTraverse("VisiblePlayerIDs")' in script
    assert b'GameInterfaceAPI.ConsoleCommand(commands[index])' in script
    assert b'"cl_drawhud_force_teamid_overhead 1"' in script
    assert b'"mp_forcecamera 0"' in script
    assert b'overheadNativeCvarApplyAttempts < 4' in script
    assert b'FindChildrenWithClassTraverse("playerid")' in script
    assert b'"#Panorama_HUD_playerid_overhead_money"' in script
    assert b'"#Panorama_HUD_playerid_overhead_health"' not in script
    assert b'GameStateAPI.GetPlayerMoney(xuid)' in script
    assert b'firstChildWithClass(playerPanel, "playerid__name")' in script
    assert b'playerPanel.BHasClass("playerid--team-ct")' in script
    assert b'setPlayerOverheadContentVisible(playerPanel, visible)' in script
    assert b'label.text = text' in script
    assert b'playerPanel.SetHasClass("money", active)' in script
    assert b'playerPanel.SetHasClass("normal-health", false)' in script
    assert b'playerPanel.SetHasClass("low-health", false)' in script
    assert b'label.style.color = "white"' in script
    assert b'#b0dc88ff' not in script
    assert b'setNativePlayerEconomy(' in script
    assert b'label.style.width = "300px"' not in script
    assert b"$.Schedule(0, updateOverheadInfoHud)" in script
    assert b"const encodedRadio = packed[11] || null" in script
    assert b"function decodeRadioTrack(raw)" in script
    assert b"function safelyDecodeRadioTrack()" in script
    assert b"catch (errRadioDecode)" in script
    assert b"Do not re-sort equal-tick" in script
    assert b".localeCompare(" not in script
    assert b"function updateRadioHud()" in script
    assert b"return povTeam !== 0 && event.team === povTeam" in script
    assert b'const messages = String(raw[4] || "")' in script
    assert b'kind === 0 ? "chat" : "server"' in script
    assert b"function chatEventHtml(event)" in script
    assert b"function serverEventHtml(event)" in script
    assert b'|| !event.teamOnly' in script
    assert b'radioHud.GetParent() === root' in script
    assert b'hud.style.width = "560px"' in script
    assert b'hud.style.height = "300px"' in script
    assert b'hud.style.marginLeft = "0px"' in script
    assert b"const RADIO_PANEL_Y_OFFSET = 182 + VOICE_NOTICE_ROW_HEIGHT" in script
    assert b'hud.style.marginBottom = RADIO_PANEL_Y_OFFSET + "px"' in script
    assert b'radioHud.style.marginBottom = RADIO_PANEL_Y_OFFSET + "px"' in script
    assert b"activeVoiceNoticeRows" not in script
    assert b'history.style.height = "100%"' in script
    assert b'history.style.verticalAlign = "bottom"' in script
    assert b'rowStack.style.height = "fit-children"' in script
    assert b'rowStack.style.verticalAlign = "bottom"' in script
    assert b'rowStack.style.paddingLeft = "8px"' in script
    assert b'rowStack.style.paddingBottom = "0px"' in script
    assert b'rowStack.style.flowChildren = "down"' in script
    assert b"rowIndex < MAX_VISIBLE_RADIO_MESSAGES" in script
    assert b"row.html = true" in script
    assert b'row.style.fontFamily = "Stratum2, \'Arial Unicode MS\'"' in script
    assert b'row.style.fontWeight = "medium"' in script
    assert b'row.style.textShadow = "0px 0px 1px 1.0 #0000003a"' in script
    assert b"const RADIO_MESSAGE_SECONDS = 15.5" in script
    assert b"const RADIO_FADE_IN_END = 0.05" in script
    assert b"const RADIO_FADE_OUT_START = 0.90" in script
    assert b"const RADIO_FADE_OUT_END = 0.95" in script
    assert b"const NATIVE_VOICE_ALERT_PANEL_COUNT = 16" in script
    assert b'findHudTraverse("AlertPanel" + (index + 1))' in script
    assert b"function suppressNativeLowerLeft()" in script
    assert b'panel.style.opacity = "0"' in script
    assert b"nativeVoiceAlertHost" not in script
    assert b'nativeChatHistoryText.style.opacity = "0"' in script
    assert b"nativeChatHistoryText.visible = false" in script
    assert b"Number(panel.actuallayoutheight)" not in script
    assert b"function refreshNativeVoiceAlertStates()" not in script
    assert b"function reserveNativeVoiceAlertLane(nativeStates)" not in script
    assert b"suppressNativeLowerLeft();" in script
    assert b"setChronologicalOffset" not in script
    assert b"state.panel.style" not in script
    assert b'"translateY(-" + distance + "px)"' not in script
    assert b"function radioEventOpacity(event, tick)" in script
    assert b"visible.length ? RADIO_ACTIVE_REFRESH_SECONDS" in script
    assert b"row.text = event ? lowerLeftEventHtml(event)" in script
    assert b"String(radioEventOpacity(event, tick))" in script
    assert b"event.tick + radioLifetimeTicks <= tick" in script
    assert b"event.tick + cashLifetimeTicks > tick" in script
    assert b"event.attackerXuid === povXuid" in script
    assert b"#Player_Cash_Award_Killed_Enemy_Generic" in script
    assert b"function cashAwardEventHtml(event)" in script
    assert b"CS2InsightAdvancedEdge" in script
    assert b"CS2InsightAdvancedMenu" in script
    assert b"function advancedAdvanceSpecOperation()" in script
    assert b"function advancedSpecTargetSlot(xuid)" in script
    assert b"runtimeSlot + 1 : -1" in script
    assert b'GameInterfaceAPI.ConsoleCommand("spec_player " + operation.targetSlot)' in script
    assert b"advancedSpecCandidates" not in script
    assert b"operation.candidates" not in script
    assert b"function advancedPlayerAliveAtTick(xuid, tick)" in script
    assert b"return Boolean(sample.alive)" in script
    assert "☠ ".encode() in script
    assert "（死亡）".encode() in script
    assert b'button.style.backgroundColor = "#2b1818f2"' in script
    assert b'liveTeam + ":" + (alive ? "1" : "0")' in script
    assert b"function advancedTogglePlayerVoice(xuid)" in script
    assert b"function advancedApplyPlaybackProfile(profile)" in script
    profile_start = script.index(b"function advancedApplyPlaybackProfile(profile)")
    profile_end = script.index(b"function advancedSetVoicePolicy(policy)", profile_start)
    assert b"spec_mode" not in script[profile_start:profile_end]
    assert b"CS2InsightAdvancedProgress" not in script
    assert b"CS2InsightAdvancedProgressSlider" not in script
    assert b"function advancedNumericEntryText(entry)" not in script
    assert b"function advancedSetNumericEntryText(entry, value)" not in script
    assert b'GameInterfaceAPI.ConsoleCommand("demoui false")' not in script
    assert b"demo_ui_mode" not in injection_source
    assert b'DemoControllerHidden' not in injection_source
    assert b'controller.visible = false' not in script
    assert b'"SliderReleased"' not in injection_source
    assert b"advancedSeekFromProgressSlider" not in script
    assert b'advancedProgressFill.style.backgroundColor = "#e07f0a"' not in script
    assert b'advancedCopy("\xe8\xaf\xad\xe9\x9f\xb3\xe5\xbc\x80", "ON")' in script
    assert b'advancedCopy("\xe8\xaf\xad\xe9\x9f\xb3\xe5\x85\xb3", "OFF")' in script
    assert b'advancedMenu.style.height = "fit-children"' in script
    assert b'advancedEventListPanel.style.height = "145px"' in script
    assert b'advancedEventListPanel.style.paddingBottom = "5px"' in script
    assert b"footerSpacer" not in script
    assert b'advancedMenuSelectionLabel' not in script
    assert b'const pageSize = 5' in script
    assert b'for (let slot = 0; slot < pageSize; slot += 1)' in script
    assert b"function advancedCreateEventLocateButton(row, event)" in script
    assert b'"s2r://panorama/images/icons/" + folder + "/" + stem + ".svg"' in script
    assert b'advancedCreateEventIcon(parent, "death_notice", "headshot", 12)' in script
    assert b'advancedCreateEventIcon(parent, "death_notice", "throughsmoke", 12)' in script
    assert b'advancedCreateEventIcon(parent, "death_notice", "penetrate", 12)' in script
    assert b'advancedCreateEventIcon(feed, "equipment", advancedEquipmentIconStem(event.detail), 28)' in script
    assert "advancedCopy(\"投掷\", \"threw\")".encode() in script
    assert b"advancedEventTitle" not in script
    assert b"state.RoundIntervals" not in injection_source
    assert b"Array.isArray(raw[6])" in script
    assert b"function advancedStepRound(delta)" not in script
    assert b"function advancedSubmitRound()" not in script
    assert b"CS2InsightAdvancedRoundPicker" in script
    assert b"function advancedToggleRoundPicker()" in script
    assert b'advancedCopy("\xe5\x9b\x9e\xe5\x90\x88", "Round")' in script
    assert b"advancedRoundPickerPanel.style.flowChildren = \"right-wrap\"" in script
    assert b"advancedSelectPlayer(xuid, { tick: round.start })" in script
    assert "第 \" + roundNumber + \" 回合 ▾".encode() in script
    assert "advancedCopy(\"X光\", \"X-ray\")".encode() not in script
    assert "advancedCopy(\"阵营\", \"Teams\")".encode() in script
    assert "advancedCopy(\"事件\", \"Events\")".encode() in script
    assert b'advancedMenuPinned ? "PIN ON" : "PIN OFF"' in script
    assert b'panel.SetPanelEvent("onactivate", function () { return true; })' in script
    assert b"advancedFocusTextEntry(advancedTickInput)" not in script
    assert b"let advancedMenuPinned = true" in script
    assert b"function advancedOpenNumericPad(entry, submit, title)" not in script
    assert b"CS2InsightAdvancedNumericPad" not in script
    assert script.count(b"_insightNumericButton = true") == 0
    assert b'advancedTickInput.SetAttributeString("textmode", "numeric")' not in script
    assert b'advancedRoundInput.SetAttributeString("textmode", "numeric")' not in script
    assert b"function advancedSliderTick(panel, value)" not in script
    assert b"advancedProgressSlider.min = 0" not in script
    assert b"advancedProgressSlider.max = advancedPlayback.totalTick" not in script
    assert b"advancedProgressSlider.max = 1" not in script
    assert b"advancedQuickOptions.messages" not in script
    assert b'["messages", advancedCopy(' not in script
    assert b"advancedQuickOptions.input" not in script
    assert b'["input", advancedCopy(' not in script
    assert b'"tv_nochat 0"' in script
    assert b"advancedNativeMessagesRestored" in script
    assert b'cl_drawhud_force_radar " + (advancedQuickOptions.radar ? 0 : -1)' in script
    assert script.count(b'"mp_forcecamera 0"') >= 2
    assert b'"cl_radar_square_when_spectating 1"' in script
    assert b'"cl_radar_rotate false"' in script
    assert b'"cl_radar_square_always true"' in script
    assert b'"cl_radar_always_centered 0"' in script
    assert b"restoreNativeRadarForAdvancedSpectator();" in script
    assert b'side.RemoveClass("CS2InsightPovEnemy")' in script
    assert b"spectatorAllPlayers" in script
    assert b'findHudTraverse("HudHealthAmmoCenter")' in script
    assert b"function fixPovHealthHudColor(" not in script
    assert b"function paintHealthFillPanel(" not in script
    assert b"advancedModifiedHealthPanels" not in script
    assert b"Leave the native health fill untouched in both recording POV" in script
    assert b'"HudSpecplayerParentContainer"' in script
    assert b"function guardSpectatorHudProfile()" in script
    assert b"advancedPlayback && !advancedPovVisualsEnabled" in script
    assert b"$.Schedule(0, guardSpectatorHudProfile);" in script
    assert b"function advancedGuardSpectatorHud()" not in script
    assert b"restoreAdvancedHealthPanels" not in script
    assert b'"cl_spec_stats 1"' in script
    assert b'"cl_teamid_overhead_maxdist 9999"' in script
    assert b"_insightOriginalOverheadText" in script
    assert b"_insightOriginalNormalHealthClass" in script
    assert b"advancedNativeOverheadRestored" in script
    assert b'panel.visible = false' in script
    assert b'"RI_BombDefuserPackage"' in script
    assert b"resumeAfterSeek" in script
    assert b"CS2InsightAdvancedDragHandle" in script
    assert b'$.RegisterEventHandler("DragStart", handle' in script
    assert b'$.RegisterEventHandler("DragEnd", handle' in script
    assert b'advancedMenu.style.transform = "translate3d(" + clampedX' in script
    assert b"let advancedMenuPosition = null" in script
    assert b"function advancedInitializeMenuPosition()" not in script
    assert b"function advancedMenuDragTick()" in script
    assert b"function advancedStartMenuDrag()" in script
    assert b'handle.SetPanelEvent("onmousedown", advancedStartMenuDrag)' in script
    assert b"advancedCurrentMenuPosition()" in script
    assert b"advancedSetMenuPosition(position.x, position.y)" in script
    assert b"const moved = advancedMenuDragGhost" in script
    assert b"handle.draggable = true" in script
    assert b"Number(root.actuallayoutwidth || 0) / scaleX" in script
    assert b"Number(advancedMenu.actuallayoutwidth || 0) / scaleX" in script
    assert b'advancedMenu.style.horizontalAlign = "right"' in script
    assert b'advancedMenu.style.verticalAlign = "center"' in script
    assert b'advancedMenu.style.marginRight = "6px"' in script
    assert b"advancedMenu.style.x =" not in script
    assert b"advancedMenu.style.y =" not in script
    assert b"function restrictPovTeamCounterEquipment()" in script
    assert b"function advancedRestoreDemoTeamCounterEquipment()" in script
    assert b'FindChildrenWithClassTraverse("equipinfo__bg-container")' in script
    assert b'renderTeam(3, "CT", "#5ebaf0")' in script
    assert b'renderTeam(2, "T", "#e7bd53")' in script
    assert b'GameInterfaceAPI.ConsoleCommand("demo_gototick " + initialSeekTick)' in script
    assert b'return color ? radioHtmlSpan(color, "\xe2\x97\x8f ") : ""' in script
    assert b'createClassedPanel("Label", notice, "VoiceMarker", "VoiceText")' in script
    assert b'marker.text = markerColor ? "\xe2\x97\x8f " : ""' in script
    assert b'marker.style.color = markerColor || "#ffffff"' in script
    assert b'label.html = true' not in script
    assert b'function voiceNoticeHtml(' not in script
    assert b'return team === 2 ? "#e0b756" : "#ffffff"' in script
    assert b'return team === 2 ? "#ffdf93" : "#ffffff"' in script
    assert b'locationLabel.style.color = "#40ff40"' in script
    assert b'notice.FindChildTraverse("VoiceLocation")' in script
    assert b'notice.SetHasClass("Hidden", !active);' in script
    assert b'const encodedRecordingVoiceMode = String(packed[13] || "team")' in script
    assert b'function activeVoicePolicy()' in script
    assert b'if (policy === "enemy")' in script
    assert b'const allowed = advancedVoiceAllows(slotXuid, povTeam, tick);' in script
    voice_update_start = script.index(b"function update()")
    voice_update_end = script.index(b"function advancedChinese()", voice_update_start)
    assert b"advancedPovVisualsActive" not in script[voice_update_start:voice_update_end]
    assert b'speaker.panel.AddClass("Hidden")' not in script[profile_start:profile_end]
    assert b"reward: Math.max(0, parseInt(fields[3], 36) || 0)" in script
    assert b"if (radioTrack || killFeedbackTrack)" in script
    assert b'join("<br>")' not in script
    assert "﹫".encode() in script
    assert b"Stratum2 Bold" not in script
    assert b"#SFUI_TitlesTXT_Smoke_in_the_hole" in script
    assert b"#Cstrike_TitlesTXT_Planting_Bomb" in script
    assert b"765611" not in script


def test_advanced_playback_template_keeps_pov_counter_but_omits_nonreversible_styles():
    template_path = (
        Path(__file__).resolve().parents[2]
        / "pov"
        / "pov_advanced_playback_template.vpk"
    )
    entries = read_inline_vpk(template_path.read_bytes())
    script = entries[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)

    assert script[start:end].rstrip() == b"[[], [], [], []]"
    assert "panorama/layout/hud/hudalerts.vxml_c" in entries
    assert "panorama/styles/hud/hudhealthammocenter.vcss_c" not in entries
    assert "panorama/styles/hud/hudradar.vcss_c" not in entries
    assert "panorama/styles/hud/hudteamcounter-equipmentinfo.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter.vcss_c" in entries


def test_recording_build_keeps_pov_only_compiled_styles():
    template_path = Path(__file__).resolve().parents[2] / "pov" / "pov_voice_template.vpk"
    build = build_demo_voice_hud_vpk(
        "match.dem",
        template_path,
        parser_factory=_FakeParser,
    )
    entries = read_inline_vpk(build.vpk_bytes)

    assert "panorama/styles/hud/hudhealthammocenter.vcss_c" not in entries
    assert "panorama/styles/hud/hudradar.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter-equipmentinfo.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter.vcss_c" in entries


def test_static_pov_package_resets_only_stale_match_alert_toasts():
    package_path = Path(__file__).resolve().parents[2] / "pov" / "pov_default.vpk"
    entries = read_inline_vpk(package_path.read_bytes())

    alert_script = entries["panorama/scripts/hud/hudalerts_insight.vjs_c"]
    alert_style = entries["panorama/styles/hud/hudalerts_insight.vcss_c"]
    assert "panorama/layout/hud/hudalerts.vxml_c" in entries
    assert "panorama/styles/hud/hudalerts.vcss_c" not in entries
    assert "panorama/styles/hud/hudhealthammocenter.vcss_c" not in entries
    assert "panorama/styles/hud/hudradar.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter-equipmentinfo.vcss_c" in entries
    assert "panorama/styles/hud/hudteamcounter.vcss_c" in entries
    assert b"CSGOHudAlerts.CS2InsightSeekSuppress" in alert_style
    assert b"CSGOHudAlerts.CS2InsightPausedSeekSuppress" in alert_style
    assert b"PanoramaGameTimeJumpEvent" in alert_script


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
    assert payload[13] == "mute"
    assert build.voice_packets == 0
    assert build.speakers == 0
    assert build.intervals == 0


def test_enemy_voice_mode_keeps_schedule_and_is_embedded_in_the_payload():
    template_path = Path(__file__).resolve().parents[2] / "pov" / "pov_voice_template.vpk"
    build = build_demo_voice_hud_vpk(
        "match.dem",
        template_path,
        parser_factory=_FakeParser,
        voice_mode="enemy",
    )
    script = read_inline_vpk(build.vpk_bytes)[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)
    payload = json.loads(script[start:end].rstrip())

    assert payload[1]
    assert payload[13] == "enemy"
    assert build.speakers > 0


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
            if name == "player_sound":
                return {
                    "tick": [16, 24],
                    "user_steamid": [111, 222],
                    "radius": [1100, 120],
                    "duration": [0.1, 0.5],
                    "step": [False, True],
                }
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
    assert stats["radar_native_sound_complete"] == 1
    assert radar[5][2] == 1
    xuids = {row[0] for row in radar[3]}
    assert xuids == {"111", "222"}
    assert all(isinstance(row[3], str) and row[3] for row in radar[3])


def test_incomplete_native_sound_rows_select_insight_ring_fallback():
    class _IncompleteSoundParser:
        @staticmethod
        def parse_event(name):
            if name == "player_sound":
                return {
                    "tick": [16, 24],
                    "user_steamid": [111],
                    "radius": [1100, 120],
                    "duration": [0.1, 0.5],
                    "step": [False, True],
                }
            if name == "weapon_fire":
                return {
                    "tick": [32],
                    "user_steamid": [111],
                    "weapon": ["ak47"],
                    "silenced": [False],
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _IncompleteSoundParser(),
        {111: (0, 2), 222: (1, 3)},
    )

    assert track[1]
    assert track[2] == 0


def test_complete_native_sound_track_is_unfiltered_without_missing_actions():
    class _CompleteSoundParser:
        @staticmethod
        def parse_event(name):
            if name == "player_sound":
                return {
                    "tick": [10, 11, 12, 13, 14, 15, 16, 17, 18],
                    "user_steamid": [111] * 9,
                    "radius": [98, 594, 597, 600, 800, 1000, 1065, 1070, 1100],
                    "duration": [0.1] * 9,
                    "step": [False] * 8 + [True],
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _CompleteSoundParser(),
        {111: (0, 2)},
    )

    assert track[2] == 1
    tokens = track[1].split(",")
    assert len(tokens) == 9
    assert [int(token.split(".")[2], 36) for token in tokens] == [
        98,
        594,
        597,
        600,
        800,
        1000,
        1065,
        1070,
        1100,
    ]
    assert [int(token.split(".")[3], 36) for token in tokens] == [100] * 9
    assert [int(token.split(".")[4], 36) for token in tokens] == [0] * 8 + [1]


def test_complete_native_sound_track_reconciles_missing_knife_and_jump_layers():
    class _CompleteButSemanticallyGappedParser:
        @staticmethod
        def parse_event(name):
            if name == "player_sound":
                # The producer retained a valid table and an independent step
                # row, but omitted both knife layers and the 98u take-off row.
                return {
                    "tick": [30],
                    "user_steamid": [111],
                    "radius": [1100],
                    "duration": [0.5],
                    "step": [True],
                }
            if name == "weapon_fire":
                return {
                    "tick": [20, 40],
                    "user_steamid": [111, 111],
                    "weapon": ["weapon_knife", "weapon_ak47"],
                    "silenced": [False, False],
                }
            if name == "player_jump":
                return {"tick": [30], "user_steamid": [111]}
            return {"tick": []}

    track = _build_player_sound_track(
        _CompleteButSemanticallyGappedParser(),
        {111: (0, 2)},
    )

    tick = 0
    decoded = []
    for token in track[1].split(","):
        fields = token.split(".")
        tick += int(fields[0], 36)
        decoded.append((tick, int(fields[2], 36), int(fields[3], 36)))

    assert track[2] == 1
    assert decoded == [
        (20, 352, 100),
        (20, 800, 100),
        (30, 98, 100),
        (30, 1100, 500),
        (40, 1, 100),
    ]


def test_complete_native_sound_track_excludes_local_only_pickup_circle():
    class _PickupSoundParser:
        @staticmethod
        def parse_event(name):
            if name == "item_pickup":
                return {
                    "tick": [20],
                    "user_steamid": [111],
                    "item": ["smokegrenade"],
                    "silent": [False],
                }
            if name == "player_sound":
                return {
                    "tick": [20, 20, 20, 21],
                    "user_steamid": [111] * 4,
                    "radius": [1100, 1100, 800, 1000],
                    "duration": [0.1, 0.5, 0.1, 0.1],
                    "step": [False, True, False, False],
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _PickupSoundParser(),
        {111: (0, 2)},
    )

    assert track[2] == 1
    assert [int(token.split(".")[2], 36) for token in track[1].split(",")] == [
        800,
        1100,
        1000,
    ]


def test_stripped_demo_weapon_sound_fallback_excludes_ordinary_utility_pin_pull():
    assert _weapon_fire_sound_radius("weapon_ak47", False) is None
    assert _weapon_fire_sound_radius("weapon_awp", False) is None
    assert _weapon_fire_sound_radius("weapon_m4a1_silencer", True) is None
    assert _weapon_fire_sound_radius("weapon_molotov", False) == 1100
    assert _weapon_fire_sound_radius("weapon_incgrenade", False) == 1100
    assert _weapon_fire_sound_radius("weapon_flashbang", False) is None
    assert _weapon_fire_sound_radius("weapon_smokegrenade", False) is None
    assert _weapon_fire_sound_radius("weapon_hegrenade", False) is None
    assert _weapon_fire_sound_radius("weapon_decoy", False) is None
    assert _weapon_fire_sound_radius("weapon_knife", False) == 800
    assert _weapon_fire_sound_radius("weapon_taser", False) is None
    assert _weapon_fire_sound_radius("weapon_c4", False) is None


def test_complete_native_sound_track_reconciles_only_fire_utility_action_layer():
    class _FireUtilitySoundParser:
        @staticmethod
        def parse_event(name):
            if name == "player_sound":
                return {
                    "tick": [30],
                    "user_steamid": [111],
                    "radius": [1100],
                    "duration": [0.5],
                    "step": [True],
                }
            if name == "weapon_fire":
                return {
                    "tick": [20, 40, 50, 60],
                    "user_steamid": [111] * 4,
                    "weapon": [
                        "weapon_incgrenade",
                        "weapon_molotov",
                        "weapon_flashbang",
                        "weapon_smokegrenade",
                    ],
                    "silenced": [False] * 4,
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _FireUtilitySoundParser(),
        {111: (0, 2)},
        # M1 rises at ticks 10/35, before the fire utilities are released at
        # ticks 20/40. The ordinary utility presses at 45/55 must not add rows.
        input_tracks=[["111", "a.74,a.0,f.74,5.0,5.74,5.0,5.74,5.0"]],
    )

    tick = 0
    decoded = []
    for token in track[1].split(","):
        fields = token.split(".")
        tick += int(fields[0], 36)
        decoded.append((tick, int(fields[2], 36), int(fields[3], 36)))

    assert track[2] == 1
    assert decoded == [
        (10, 1100, 100),
        (30, 1100, 500),
        (35, 1100, 100),
    ]


def test_stripped_sound_track_reconstructs_jump_and_reload_from_input_edges():
    class _ActionSoundParser:
        @staticmethod
        def parse_event(name):
            if name == "weapon_reload":
                # Same action as the R input edge below: it must not duplicate.
                return {"tick": [20], "user_steamid": [111]}
            return {"tick": []}

    track = _build_player_sound_track(
        _ActionSoundParser(),
        {111: (0, 2)},
        input_tracks=[["111", "a.g,1.0,9.3k,1.0"]],
    )

    tick = 0
    decoded = []
    for token in track[1].split(","):
        fields = token.split(".")
        tick += int(fields[0], 36)
        decoded.append(
            (
                tick,
                int(fields[2], 36),
                int(fields[3], 36),
                int(fields[4], 36),
            )
        )

    assert track[2] == 0
    assert decoded == [
        (10, 98, 100, 0),
        (20, 98, 100, 0),
    ]


def test_stripped_sound_track_uses_sampled_action_fallback_without_input():
    class _ObservedActionParser:
        @staticmethod
        def parse_event(_name):
            return {"tick": []}

    track = _build_player_sound_track(
        _ObservedActionParser(),
        {111: (0, 2)},
        observed_actions=[("jump", 30, 111), ("reload", 40, 111)],
    )

    assert [int(token.split(".")[2], 36) for token in track[1].split(",")] == [
        98,
        98,
    ]


def test_stripped_sound_track_rebuilds_stock_step_rows_from_player_footstep():
    class _FootstepParser:
        @staticmethod
        def parse_event(name):
            if name == "player_footstep":
                return {
                    "tick": [10, 30, 70],
                    "user_steamid": [111, 111, 111],
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _FootstepParser(),
        {111: (0, 2)},
    )

    tick = 0
    decoded = []
    for token in track[1].split(","):
        fields = token.split(".")
        tick += int(fields[0], 36)
        decoded.append(
            (
                tick,
                int(fields[2], 36),
                int(fields[3], 36),
                int(fields[4], 36),
            )
        )

    assert track[2] == 0
    assert decoded == [
        (10, 1100, 500, 1),
        (30, 1100, 500, 1),
        (70, 1100, 500, 1),
    ]


def test_complete_native_sound_track_does_not_duplicate_player_footstep_rows():
    class _NativeAndFootstepParser:
        @staticmethod
        def parse_event(name):
            if name == "player_sound":
                return {
                    "tick": [10],
                    "user_steamid": [111],
                    "radius": [1100],
                    "duration": [0.5],
                    "step": [True],
                }
            if name == "player_footstep":
                return {"tick": [10], "user_steamid": [111]}
            return {"tick": []}

    track = _build_player_sound_track(
        _NativeAndFootstepParser(),
        {111: (0, 2)},
        observed_actions=[("step", 12, 111)],
    )

    assert track[2] == 1
    assert len(track[1].split(",")) == 1
    fields = track[1].split(".")
    assert int(fields[2], 36) == 1100
    assert int(fields[4], 36) == 1


def test_gun_fire_fallback_is_combat_border_only_not_a_sound_circle():
    class _GunFireParser:
        @staticmethod
        def parse_event(name):
            if name == "weapon_fire":
                return {
                    "tick": [20],
                    "user_steamid": [111],
                    "weapon": ["weapon_ak47"],
                    "silenced": [False],
                }
            return {"tick": []}

    track = _build_player_sound_track(
        _GunFireParser(),
        {111: (0, 2)},
    )

    fields = track[1].split(".")
    assert int(fields[2], 36) == 1
    assert int(fields[3], 36) == 100
    assert int(fields[4], 36) == 4


def test_flash_track_falls_back_to_flash_duration_tick_state():
    class _FlashTickParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"map_name": "de_dust2", "tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "round_start":
                return {"tick": [8]}
            if name == "round_end":
                return {"tick": [40]}
            if name == "player_blind":
                return []
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"]:
                return _FakeParser.parse_ticks(fields)
            assert fields == ["steamid", "flash_duration"]
            out = {"tick": [], "steamid": [], "flash_duration": []}
            for tick in ticks or []:
                out["tick"].extend([tick, tick])
                out["steamid"].extend([111, 222])
                duration = 0.0 if tick < 12 else (2.0 if tick < 24 else 1.0)
                out["flash_duration"].extend([duration, 0.0])
            return out

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_FlashTickParser)
    payload, stats = add_flash_blind_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_FlashTickParser,
    )
    packed = json.loads(payload)

    assert packed[10] == [
        ["111"],
        "8.0.0.1.0,4.3k.0.0.73,c.1s.0.0.73",
        2,
        64000,
    ]
    assert stats["flash_blind_events"] == 2
    assert stats["flash_blind_parse_failed"] == 0
    assert stats["flash_blind_tick_fallback"] == 1


def test_flash_track_uses_merged_native_updates_and_clears_on_death():
    class _NativeFlashParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"map_name": "de_dust2", "tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "round_start":
                return {"tick": [0]}
            if name == "player_death":
                return {"tick": [250], "user_steamid": [111]}
            if name == "player_blind":
                return {
                    "tick": [100, 190, 270],
                    "user_steamid": [111, 111, 111],
                    "blind_duration": [4.5, 4.5, 3.0],
                }
            if name == "flashbang_detonate":
                return {"tick": [100, 190, 270]}
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"]:
                return _FakeParser.parse_ticks(fields)
            if fields == ["steamid", "flash_duration", "flash_max_alpha", "is_alive"]:
                raise RuntimeError("native-only fixture")
            return _FakeParser.parse_ticks(fields)

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_NativeFlashParser)
    payload, stats = add_flash_blind_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_NativeFlashParser,
    )
    packed = json.loads(payload)

    assert packed[10] == [
        ["111"],
        "0.0.0.1.0,2s.80.0.0.73,2i.80.0.0.73,1o.0.0.1.0",
        2,
        64000,
    ]
    # The post-death tick-270 blind row is intentionally absent.
    assert stats["flash_blind_events"] == 2
    assert stats["flash_blind_tick_fallback"] == 0


def test_flash_track_recovers_exact_updates_from_detonation_tick_properties():
    class _DetonationFlashParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"map_name": "de_dust2", "tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "round_start":
                return {"tick": [0]}
            if name == "round_end":
                return {"tick": [300]}
            if name == "player_death":
                return {"tick": [200], "user_steamid": [111]}
            if name == "player_blind":
                return []
            if name == "flashbang_detonate":
                return {"tick": [100, 164]}
            return {"tick": []}

        @staticmethod
        def parse_ticks(fields, ticks=None):
            if fields == ["last_place_name"]:
                return _FakeParser.parse_ticks(fields)
            assert fields == ["steamid", "flash_duration", "flash_max_alpha", "is_alive"]
            out = {
                "tick": [],
                "steamid": [],
                "flash_duration": [],
                "flash_max_alpha": [],
                "is_alive": [],
            }
            for tick in ticks or []:
                out["tick"].extend([tick, tick])
                out["steamid"].extend([111, 222])
                if tick < 100:
                    duration = 0.0
                elif tick < 164:
                    duration = 4.5
                else:
                    # A weaker overlap preserves the original tick-388 end.
                    duration = 3.5
                out["flash_duration"].extend([duration, 0.0])
                out["flash_max_alpha"].extend([255, 255])
                out["is_alive"].extend([tick < 200, True])
            return out

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_DetonationFlashParser)
    payload, stats = add_flash_blind_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_DetonationFlashParser,
    )
    packed = json.loads(payload)

    assert packed[10] == [
        ["111"],
        "0.0.0.1.0,2s.80.0.0.73,1s.68.0.0.73,10.0.0.1.0",
        2,
        64000,
    ]
    assert stats["flash_blind_events"] == 2
    assert stats["flash_blind_tick_fallback"] == 1


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
    assert track[1] == "2s.0.1.8c,k.1.2.8c,14.0.3.8c"
    assert track[2] == 64_000
    assert stats["kill_feedback_events"] == 3
    assert stats["kill_feedback_parse_failed"] == 0


def test_kill_cash_award_matches_classic_weapon_rewards():
    assert _kill_cash_award("weapon_ak47") == 300
    assert _kill_cash_award("awp") == 100
    assert _kill_cash_award("weapon_mac10") == 600
    assert _kill_cash_award("xm1014") == 900
    assert _kill_cash_award("knife_karambit") == 1500
    assert _kill_cash_award("bayonet") == 1500
    assert _kill_cash_award("taser") == 0


def test_radio_track_prefers_native_throws_and_rebuilds_only_missing_rows():
    class _RadioParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "grenade_thrown":
                return {
                    "tick": [110, 220],
                    "user_steamid": [111, 222],
                    "user_last_place_name": ["TopofMid", "BombsiteB"],
                    "user_team_num": [2, 3],
                    "weapon": ["smokegrenade", "flashbang"],
                }
            if name == "weapon_fire":
                return {
                    "tick": [100, 210, 300, 320],
                    "user_steamid": [111, 222, 111, 222],
                    "user_last_place_name": ["TopofMid", "BombsiteB", "Middle", "CTSpawn"],
                    "user_team_num": [2, 3, 2, 3],
                    "weapon": [
                        "weapon_smokegrenade",
                        "weapon_flashbang",
                        "weapon_hegrenade",
                        "weapon_ak47",
                    ],
                }
            if name == "bomb_beginplant":
                return {
                    "tick": [350],
                    "user_steamid": [111],
                    "user_last_place_name": ["BombsiteA"],
                    "user_team_num": [2],
                }
            if name == "bomb_begindefuse":
                return {
                    "tick": [400],
                    "user_steamid": [222],
                    "user_last_place_name": ["BombsiteB"],
                    "user_team_num": [3],
                }
            return {"tick": []}

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_RadioParser)
    payload, stats = add_radio_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_RadioParser,
    )
    packed = json.loads(payload)

    assert len(packed) >= 12
    assert packed[11] == [
        ["111", "222"],
        ["", "TopofMid", "BombsiteB", "Middle", "BombsiteA"],
        "32.0.0.1.2,32.1.1.2.3,28.0.2.3.2,1e.0.6.4.2,1e.1.7.2.3",
        [],
        "",
        64000,
        2,
    ]
    assert stats == {
        "radio_events": 5,
        "radio_native_events": 2,
        "radio_rebuilt_events": 1,
        "radio_objective_events": 2,
        "radio_chat_messages": 0,
        "radio_server_messages": 0,
        "radio_parse_failed": 0,
        "payload_bytes": len(payload),
    }


def test_radio_track_preserves_arrival_order_for_same_tick_rows():
    class _SameTickRadioParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "weapon_fire":
                return {
                    "tick": [100, 100],
                    # Deliberately reverse numeric XUID order. Native HudChat
                    # keeps source arrival order instead of sorting players.
                    "user_steamid": [222, 111],
                    "user_last_place_name": ["BombsiteB", "BombsiteA"],
                    "user_team_num": [3, 2],
                    "weapon": ["weapon_flashbang", "weapon_hegrenade"],
                }
            return {"tick": [], "user_steamid": []}

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_SameTickRadioParser)
    payload, _stats = add_radio_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_SameTickRadioParser,
    )

    radio = json.loads(payload)[11]
    assert radio[0] == ["222", "111"]
    assert radio[1] == ["", "BombsiteB", "BombsiteA"]
    assert radio[2] == "2s.0.1.1.3,0.1.2.2.2"


def test_lower_left_feed_unifies_chat_and_server_notices():
    class _UnifiedFeedParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "chat_message":
                return {
                    "tick": [10],
                    "chat_message": ["hello"],
                    "user_steamid": [111],
                    "user_name": ["one"],
                    "user_team_num": [2],
                    "team_only": [False],
                }
            if name == "server_message":
                return {
                    "tick": [12],
                    "server_message": ["Console: maintenance soon"],
                }
            if name == "player_hurt":
                return {
                    "tick": [14],
                    "attacker_steamid": [111],
                    "user_steamid": [999],
                    "attacker_team_num": [2],
                    "user_team_num": [2],
                    "attacker_name": ["one"],
                    "dmg_health": [20],
                }
            if name == "player_death":
                return {
                    "tick": [16],
                    "attacker_steamid": [111],
                    "user_steamid": [999],
                    "attacker_team_num": [2],
                    "user_team_num": [2],
                    "attacker_name": ["one"],
                }
            return {"tick": []}

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_UnifiedFeedParser)
    payload, stats = add_radio_track_to_payload(
        voice_payload,
        "match.dem",
        parser_factory=_UnifiedFeedParser,
    )

    feed = json.loads(payload)[11]
    assert feed == [
        ["111", "0"],
        [""],
        "",
        [["one", "hello"], ["", "Console: maintenance soon"], ["one", ""]],
        "a.0.0.2.0.0,2.3.1.0.0.1,2.1.0.2.0.2,2.2.0.2.0.2",
        64000,
        2,
    ]
    assert stats["radio_chat_messages"] == 1
    assert stats["radio_server_messages"] == 3


def test_radio_track_rebuilds_even_when_demo_contains_native_radio_text(tmp_path: Path):
    class _RadioTextParser(_FakeParser):
        @staticmethod
        def parse_header():
            return {"tick_rate": 64}

        @staticmethod
        def parse_event(name, **_kwargs):
            if name == "weapon_fire":
                return {
                    "tick": [100],
                    "user_steamid": [111],
                    "user_last_place_name": ["Middle"],
                    "user_team_num": [2],
                    "weapon": ["weapon_smokegrenade"],
                }
            return {"tick": []}

    voice_payload, _ = build_voice_payload("match.dem", parser_factory=_FakeParser)
    demo_path = tmp_path / "native-radio.dem"
    demo_path.write_bytes(
        b"prefix Game_radio_location middle Game_radio_location suffix"
    )

    payload, stats = add_radio_track_to_payload(
        voice_payload,
        demo_path,
        parser_factory=_RadioTextParser,
    )

    radio = json.loads(payload)[11]
    assert radio[2] == "2s.0.0.1.2"
    assert radio[6] == 2
    assert stats == {
        "radio_events": 1,
        "radio_native_events": 0,
        "radio_rebuilt_events": 1,
        "radio_objective_events": 0,
        "radio_chat_messages": 0,
        "radio_server_messages": 0,
        "radio_parse_failed": 0,
        "payload_bytes": len(payload),
    }


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
    advanced_template = pov_dir / "pov_advanced_playback_template.vpk"
    advanced_template.write_bytes(b"advanced-template")

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

    def fake_build(
        demo_path,
        template_path,
        *,
        input_track_report=None,
        voice_enabled=True,
        voice_mode="team",
        advanced_playback_enabled=False,
    ):
        calls.append(
            (
                Path(demo_path),
                Path(template_path),
                input_track_report,
                voice_enabled,
                voice_mode,
                advanced_playback_enabled,
            )
        )
        return built

    monkeypatch.setattr(pov_hud_manager, "build_demo_voice_hud_vpk", fake_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    result = manager.install(demo_path=demo)

    assert result is built
    assert calls == [(demo, template, None, True, "team", False)]
    assert (csgo / "pov.vpk").read_bytes() == b"generated"
    manifest = json.loads(manager.get_manifest_path().read_text(encoding="utf-8"))
    assert manifest["demo_voice_hud_generated"] is True
    assert manifest["demo_voice_hud"]["speakers"] == 2
    assert manifest["demo_voice_hud"]["voice_mode"] == "team"

    advanced_result = manager.install(
        demo_path=demo,
        advanced_playback_enabled=True,
    )

    assert advanced_result is built
    assert calls[-1] == (
        demo,
        advanced_template,
        None,
        True,
        "team",
        True,
    )
    assert (csgo / "pov.vpk").read_bytes() == b"generated"
