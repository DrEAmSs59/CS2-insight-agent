from pathlib import Path
from types import SimpleNamespace
import pytest
from app.round_banner import bind_round_banner_reset, RUNTIME_BEGIN, RUNTIME_END
from app.demo_voice_hud import VOICE_SCRIPT_PATH, read_inline_vpk
from app.panorama_resource import rewrite_panorama_data

ROOT = Path(__file__).resolve().parents[2]

def parser(ticks):
    def event(name):
        assert name in ("round_end", "round_start", "round_freeze_end", "bomb_planted")
        return {"tick": ticks if name == "round_end" else [0] if name in ("round_start", "round_freeze_end") else []}
    return SimpleNamespace(parse_event=event)

def script(vpk):
    blocks = []
    rewrite_panorama_data(read_inline_vpk(vpk)[VOICE_SCRIPT_PATH], lambda data: blocks.append(data) or data)
    return blocks[0]

@pytest.mark.parametrize("name", ["pov_voice_template.vpk", "pov_advanced_playback_template.vpk"])
def test_obs_templates_rebind_session_only(name):
    original = (ROOT / "pov" / name).read_bytes()
    once = bind_round_banner_reset(original, "unused", parser=parser([500,100,100]))
    twice = bind_round_banner_reset(once, "unused", parser=parser([600]))
    assert RUNTIME_BEGIN not in script(original)
    assert script(twice).count(RUNTIME_BEGIN) == script(twice).count(RUNTIME_END) == 1
    assert b"sharedRoundEndTicks = [600]" in script(twice)
    body = script(twice).split(RUNTIME_BEGIN)[0] + script(twice).split(RUNTIME_END)[1]
    assert body == script(original)
    entries = read_inline_vpk(original)
    assert {k:v for k,v in read_inline_vpk(twice).items() if k != VOICE_SCRIPT_PATH} == {k:v for k,v in entries.items() if k != VOICE_SCRIPT_PATH}

@pytest.mark.parametrize("ticks", [None, [True], [-1], ["100"]])
def test_bad_round_facts_fail_before_install(ticks):
    with pytest.raises(ValueError, match="tick"):
        bind_round_banner_reset(b"", "unused", parser=parser(ticks))

def test_composes_with_shared_killfeed_without_replacing_its_code():
    from app.persistent_killfeed import bind_persistent_killfeed
    base = (ROOT / "pov/pov_voice_template.vpk").read_bytes()
    first = bind_round_banner_reset(base, "unused", parser=parser([]))
    combined = bind_persistent_killfeed(first, enabled=False)
    assert script(combined).count(RUNTIME_BEGIN) == 1

@pytest.mark.parametrize("recording,mode", [(True,"hud"),(True,"controller"),(True,"killfeed"),(False,"advanced")])
def test_install_restore_and_advanced_isolation(monkeypatch, tmp_path, recording, mode):
    from app import pov_hud_manager, round_banner
    from app.demo_voice_hud import DemoVoiceHudBuild
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    monkeypatch.setattr(pov_hud_manager, "load_input_report", lambda *a: {})
    cs2 = tmp_path / "game/bin/win64/cs2.exe"
    cs2.parent.mkdir(parents=True); cs2.write_bytes(b"exe")
    csgo = tmp_path / "game/csgo"; csgo.mkdir()
    original = b"FileSystem\n{\n SearchPaths\n {\n Game csgo\n }\n}\n"
    (csgo / "gameinfo.gi").write_bytes(original)
    manager = pov_hud_manager.PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_backup_dir", lambda: tmp_path / "backup")
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: ROOT / "pov")
    monkeypatch.setattr("app.pov_radio_audio.bind_pov_radio_audio", lambda vpk, **k: vpk)
    monkeypatch.setattr("app.pov_assist_highlight.bind_pov_assist_highlight", lambda vpk, *a: vpk)
    monkeypatch.setattr("app.persistent_killfeed.bind_persistent_killfeed", lambda vpk, **k: vpk)
    monkeypatch.setattr(round_banner, "bind_round_banner_reset", lambda vpk, demo: bind_round_banner_reset(vpk, demo, parser=parser([100])))
    base = (ROOT / "pov/pov_advanced_playback_template.vpk").read_bytes()
    monkeypatch.setattr(pov_hud_manager, "build_demo_voice_hud_vpk", lambda *a, **k:
        DemoVoiceHudBuild(vpk_bytes=base,voice_packets=0,speakers=0,intervals=0,location_changes=0,payload_bytes=0,location_parse_failed=False))
    control = {"session_id":"test", "segments":[{"operation_id":"one","start_tick":50,"end_tick":100,"target_xuid":"76561198000000000"}]}
    manager.install(demo_path=tmp_path / "test.dem",require_demo_hud=True,
                    recording_controller_only=mode == "controller",
                    recording_control=control if mode == "controller" else None,
                    persistent_killfeed=mode == "killfeed",killfeed_only=mode == "killfeed",
                    recording_round_banner_reset=recording,
                    advanced_playback_enabled=mode == "advanced",pov_visuals_enabled=mode == "hud")
    installed = (csgo / "pov.vpk").read_bytes()
    assert (RUNTIME_BEGIN in script(installed)) == recording
    if mode == "killfeed":
        assert b"CS2InsightPersistentKillfeed" in script(installed)
        assert b"function recordingControlOperation" not in script(installed)
    if not recording: assert installed == base
    assert manager.restore()["verified"]
    assert (csgo / "gameinfo.gi").read_bytes() == original
    assert not (csgo / "pov.vpk").exists()

@pytest.mark.parametrize("empty", [[], {}])
def test_valid_demo_without_round_or_bomb_events_can_still_record(empty):
    base = (ROOT / "pov/pov_voice_template.vpk").read_bytes()
    result = bind_round_banner_reset(base, "unused", parser=SimpleNamespace(parse_event=lambda name: empty))
    assert b"sharedRoundClockEvents = []" in script(result)
    assert b"sharedRoundEndTicks = []" in script(result)
