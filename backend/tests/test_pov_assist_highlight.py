import json
from pathlib import Path
from types import SimpleNamespace
import pytest

from app import pov_assist_highlight as assist
from app.demo_voice_hud import read_inline_vpk, VOICE_SCRIPT_PATH
from app.panorama_resource import rewrite_panorama_data

ROOT = Path(__file__).resolve().parents[2]


class Parser:
    def __init__(self, **overrides):
        self.rows = dict(tick=[104146, 134654], attacker_name=['g2r1se', 'TrueDich'],
                         assister_name=['Agokufo', 'Agokufo'], user_name=['virusmonstah', 'bizzIe'],
                         assister_steamid=[76561198875633179, 76561198875633179],
                         assistedflash=[False, True], assister_clan_name=['clan', 'clan'])
        self.rows.update(overrides)

    def parse_event(self, event, *, player):
        assert event == 'player_death' and player == ['clan_name']
        return self.rows


def data_of(vpk):
    blocks = []
    rewrite_panorama_data(read_inline_vpk(vpk)[VOICE_SCRIPT_PATH], lambda data: blocks.append(data) or data)
    return blocks[0]


def test_damage_and_flash_assist_keep_exact_string_identity_and_event_names():
    events = assist.build_assist_events('demo', parser=Parser())
    assert [e['tick'] for e in events] == [104146, 134654]
    assert all(e['xuid'] == '76561198875633179' for e in events)
    assert events[0]['people'] == [['g2r1se', ''], ['Agokufo', 'clan'], ['virusmonstah', '']]


@pytest.mark.parametrize('ids', [[0, None], [float(76561198875633179), 'nan']])
def test_invalid_or_lossy_ids_do_not_guess_an_assister(ids):
    assert assist.build_assist_events('demo', parser=Parser(assister_steamid=ids)) == []


def test_incomplete_columns_are_rejected():
    with pytest.raises(ValueError, match='inconsistent'):
        assist.build_assist_events('demo', parser=Parser(tick=[10]))


@pytest.mark.parametrize('template', ['pov_voice_template.vpk', 'pov_advanced_playback_template.vpk'])
def test_actual_templates_compose_once_without_changing_stock_resources_or_persistence(template):
    original = (ROOT / 'pov' / template).read_bytes()
    bound = assist.bind_pov_assist_highlight(original, 'demo', parser=Parser(), assets_dir=ROOT / 'pov')
    rebound = assist.bind_pov_assist_highlight(bound, 'demo', parser=Parser(), assets_dir=ROOT / 'pov')
    assert bound == rebound
    before, after = read_inline_vpk(original), read_inline_vpk(bound)
    assert before.keys() == after.keys()
    assert [key for key in before if before[key] != after[key]] == [VOICE_SCRIPT_PATH]
    data = data_of(bound)
    assert data.count(assist.BEGIN) == data.count(assist.END) == 1
    assert b'createPersistentKillfeed' not in data
    payload = data.split(assist.DATA_BEGIN)[1].split(assist.DATA_END)[0]
    assert json.loads(payload)[1]['xuid'] == '76561198875633179'


def test_untrusted_demo_names_cannot_close_script_markers():
    original = (ROOT / 'pov/pov_voice_template.vpk').read_bytes()
    name = '*/</script>/*__CS2_INSIGHT_POV_ASSIST_END__*/'
    bound = assist.bind_pov_assist_highlight(original, 'demo',
        parser=Parser(assister_name=[name, name]), assets_dir=ROOT / 'pov')
    data = data_of(bound)
    assert data.count(assist.END) == 1
    payload = data.split(assist.DATA_BEGIN)[1].split(assist.DATA_END)[0]
    assert json.loads(payload)[0]['people'][1][0] == name


@pytest.mark.parametrize('pov,advanced,persistent,expected', [
    (True, False, False, True), (False, True, False, True),
    (False, False, False, False), (True, False, True, False),
])
def test_manager_mounts_assist_for_pov_and_advanced_only_and_restores(monkeypatch, tmp_path,
                                                                   pov, advanced, persistent, expected):
    from app import pov_hud_manager, persistent_killfeed, pov_radio_audio
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
    template = (ROOT / 'pov/pov_voice_template.vpk').read_bytes()
    monkeypatch.setattr(pov_hud_manager, 'build_demo_voice_hud_vpk', lambda *a, **k:
        DemoVoiceHudBuild(vpk_bytes=template, voice_packets=0, speakers=0, intervals=0,
                          location_changes=0, payload_bytes=0, location_parse_failed=False))
    monkeypatch.setattr(pov_hud_manager, 'load_input_report', lambda *a: {})
    monkeypatch.setattr(pov_radio_audio, 'bind_pov_radio_audio', lambda package, **kwargs: package)
    events = assist.build_assist_events('demo', parser=Parser())
    monkeypatch.setattr(assist, 'build_assist_events', lambda *a, **k: events)
    monkeypatch.setattr(persistent_killfeed, 'bind_persistent_killfeed', lambda vpk, **k: vpk)
    manager.install(demo_path=tmp_path / 'test.dem', require_demo_hud=True,
                    pov_visuals_enabled=pov, advanced_playback_enabled=advanced,
                    persistent_killfeed=persistent)
    installed = (csgo / 'pov.vpk').read_bytes()
    assert (assist.BEGIN in data_of(installed)) == expected
    assert manager.restore()['verified']
    assert (csgo / 'gameinfo.gi').read_bytes() == original
    assert not (csgo / 'pov.vpk').exists()
