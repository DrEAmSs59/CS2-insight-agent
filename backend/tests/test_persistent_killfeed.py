import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.demo_voice_hud import VOICE_SCRIPT_PATH, VOICE_DATA_BEGIN, VOICE_DATA_END, read_inline_vpk
from app.persistent_killfeed import (build_killfeed_events, bind_persistent_killfeed,
    DATA_BEGIN, DATA_END, RUNTIME_BEGIN, RUNTIME_END, KILLFEED_TEMPLATE_MARKER)
from app.panorama_resource import rewrite_panorama_data

ROOT = Path(__file__).resolve().parents[2]


def parser():
    table = {
        'tick': [100, 100], 'attacker_name': ['A<&>', 'B'],
        'attacker_steamid': [76561198386265483, 76561198386265484],
        'user_name': ['B', 'A<&>'], 'user_steamid': [76561198386265484, 76561198386265483],
        'weapon': ['weapon_ak47', 'm4a1'], 'attacker_team_num': [2, 3], 'user_team_num': [3, 2],
        'attacker_clan_name': ['TAG', ''], 'headshot': [True, False], 'thrusmoke': [False, True],
    }
    return SimpleNamespace(parse_event=lambda *args, **kwargs: table)


def payload(vpk):
    script = read_inline_vpk(vpk)[VOICE_SCRIPT_PATH]
    return json.loads(script.split(VOICE_DATA_BEGIN)[1].split(VOICE_DATA_END)[0])


def script(vpk):
    data = []
    rewrite_panorama_data(read_inline_vpk(vpk)[VOICE_SCRIPT_PATH], lambda block: data.append(block) or block)
    return data[0]


def setting(vpk):
    return json.loads(script(vpk).split(DATA_BEGIN)[1].split(DATA_END)[0])


def test_distinct_same_tick_events_keep_exact_identities_and_effects():
    events = build_killfeed_events('unused', parser=parser())
    assert events[0]['id'] != events[1]['id']
    assert events[0]['attacker'] == {'xuid':'76561198386265483','name':'A<&>','clan':'TAG','team':2}
    assert events[0]['weapon'] == 'ak47'
    assert events[0]['classes'] == ['DeathNoticeHeadShot']
    assert events[1]['classes'] == ['through-smoke']


@pytest.mark.parametrize('name', ['pov_voice_template.vpk', 'pov_advanced_playback_template.vpk'])
def test_shared_composition_replaces_stale_data_and_removes_code_when_disabled(name):
    original = (ROOT / 'pov' / name).read_bytes()
    first = bind_persistent_killfeed(original, enabled=True, demo_path='unused', parser=parser(),target_xuid='76561198386265483',
        segments=[{'start_tick':90,'end_tick':110}], hide_clan_tags=False)
    a, b = payload(original), payload(first)
    assert b == a
    assert not setting(first)['hide_clan_tags']
    assert [event['id'] for event in setting(first)['events']] == ['100:0']
    assert setting(first)['target_xuid'] == '76561198386265483'
    rebound = bind_persistent_killfeed(first, enabled=True, demo_path='unused', parser=parser(),
        target_xuid='76561198386265483', segments=[{'start_tick':90,'end_tick':110}])
    assert payload(rebound) == a
    second = bind_persistent_killfeed(first, enabled=False)
    assert payload(second) == a
    assert RUNTIME_BEGIN not in script(second)
    assert KILLFEED_TEMPLATE_MARKER not in script(original)
    def code(vpk):
        data = script(vpk)
        if RUNTIME_BEGIN in data:
            data = data.split(RUNTIME_BEGIN)[0] + data.split(RUNTIME_END)[1]
        return data.split(VOICE_DATA_BEGIN)[0], data.split(VOICE_DATA_END)[1]
    assert code(first) == code(second) == code(original)


def test_missing_or_inconsistent_events_and_invalid_ranges_fail_closed():
    for table in ({}, {'tick':[1],'attacker_name':[],'attacker_steamid':[],
                       'user_name':[],'user_steamid':[],'weapon':[]}):
        with pytest.raises(ValueError):
            build_killfeed_events('unused',parser=SimpleNamespace(parse_event=lambda *a,**k:table))
    template=(ROOT/'pov/pov_voice_template.vpk').read_bytes()
    with pytest.raises(ValueError,match='范围'):
        bind_persistent_killfeed(template,enabled=True,demo_path='unused',parser=parser(),target_xuid='76561198386265483',
            segments=[{'start_tick':100,'end_tick':100}])


def test_killfeed_only_has_no_voice_input_or_pov_side_effects():
    from app.persistent_killfeed import killfeed_only_template
    base = (ROOT / 'pov/pov_advanced_playback_template.vpk').read_bytes()
    minimal = killfeed_only_template(base)
    assert list(read_inline_vpk(minimal)) == [VOICE_SCRIPT_PATH]
    assert b'CS2InsightDemoVoiceHud' not in script(minimal)
    assert b'SetPlayerVoiceVolume' not in script(minimal)
    assert b'updateInputHud' not in script(minimal)
    composed = bind_persistent_killfeed(minimal, enabled=True, demo_path='unused', parser=parser(),
        target_xuid='76561198386265483', segments=[{'start_tick':90,'end_tick':110}])
    assert setting(composed)['target_xuid'] == '76561198386265483'
    assert b'GetHudPlayerXuid' in script(composed)
    assert b'createPersistentKillfeed' in script(composed)


@pytest.mark.parametrize('hud', [False, True])
def test_manager_composes_killfeed_and_restores_game_files(monkeypatch, tmp_path, hud):
    from app import pov_hud_manager, persistent_killfeed
    from app.demo_voice_hud import DemoVoiceHudBuild
    monkeypatch.setattr(pov_hud_manager.sys, 'platform', 'win32')
    monkeypatch.setattr(pov_hud_manager, 'is_cs2_running', lambda: False)
    cs2 = tmp_path / 'game/bin/win64/cs2.exe'
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b'exe')
    csgo = tmp_path / 'game/csgo'; csgo.mkdir()
    original = b'FileSystem\n{\n SearchPaths\n {\n Game csgo\n }\n}\n'
    (csgo / 'gameinfo.gi').write_bytes(original)
    manager = pov_hud_manager.PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, 'get_backup_dir', lambda: tmp_path / 'backup')
    monkeypatch.setattr(manager, 'get_project_pov_dir', lambda: ROOT / 'pov')
    def build(*args, **kwargs):
        assert hud, 'killfeed-only must not build auxiliary HUD tracks'
        return DemoVoiceHudBuild(vpk_bytes=(ROOT/'pov/pov_voice_template.vpk').read_bytes(),
            voice_packets=0, speakers=0, intervals=0, location_changes=0, payload_bytes=0,
            location_parse_failed=False)
    monkeypatch.setattr(pov_hud_manager, 'build_demo_voice_hud_vpk', build)
    def input_report(*args):
        assert hud, 'killfeed-only must not parse input tracks'
        return {}
    monkeypatch.setattr(pov_hud_manager, 'load_input_report', input_report)
    events = build_killfeed_events('unused', parser=parser())
    monkeypatch.setattr(persistent_killfeed, 'build_killfeed_events', lambda *a, **k: events)
    manager.install(demo_path=tmp_path/'test.dem', require_demo_hud=True, pov_visuals_enabled=hud,
        persistent_killfeed=True, killfeed_only=not hud,
        persistent_killfeed_target_xuid='76561198386265483',
        persistent_killfeed_segments=[{'start_tick':90,'end_tick':110}])
    installed = (csgo/'pov.vpk').read_bytes()
    assert [event['id'] for event in setting(installed)['events']] == ['100:0']
    if not hud:
        assert list(read_inline_vpk(installed)) == [VOICE_SCRIPT_PATH]
    assert manager.restore()['verified']
    assert (csgo/'gameinfo.gi').read_bytes() == original
    assert not (csgo/'pov.vpk').exists()
