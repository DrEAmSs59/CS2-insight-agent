import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.demo_voice_hud import write_inline_vpk, read_inline_vpk, VOICE_SCRIPT_PATH
from app.equipment_icons import EquipmentIconResolver, load_equipment_icons
from app.panorama_resource import rewrite_panorama_data
from app.persistent_killfeed import bind_persistent_killfeed, killfeed_only_template, DATA_BEGIN, DATA_END

ROOT = Path(__file__).resolve().parents[2]
ICONS = {'world', 'ak47', 'm4a1', 'm4a1_silencer', 'm4a1_silencer_off',
         'usp_silencer', 'knife', 'bayonet', 'knife_m9_bayonet', 'mp9', 'awp'}


def stock_package(csgo, names=ICONS):
    csgo.mkdir(parents=True, exist_ok=True)
    entries = {f'panorama/images/icons/equipment/{name}.vsvg_c': b'icon fixture' for name in names}
    entries.update({'panorama/images/icons/other/evil.vsvg_c': b'ignore',
                    'panorama/images/icons/equipment/nested/evil.vsvg_c': b'ignore',
                    'panorama/images/icons/equipment/evil.vtex_c': b'ignore'})
    (csgo / 'pak01_dir.vpk').write_bytes(write_inline_vpk(entries))
    return csgo


@pytest.mark.parametrize('raw,expected', [
    ('weapon_ak47', 'ak47'), ('5ExTEAMSPIRIT_m4a1', 'm4a1'),
    ('5e_2023pass3_ak47_ace', 'ak47'), ('5e_plus1_m4a1_silencer', 'm4a1_silencer'),
    ('M4A1_SILENCER_txz19', 'm4a1_silencer'), ('m4a1_silencer_vip', 'm4a1_silencer'),
    ('prefixm4a1_silenceroffsuffix', 'm4a1_silencer'),
    ('5e_m4a1_silencer_off_vip', 'm4a1_silencer_off'),
    ('5e_knife_m9_bayonet', 'knife_m9_bayonet'),
    ('../ak47?<script>', 'ak47'), ('m4a1silencer', 'm4a1'),
    ('unknown<script>', 'world'), ('unknown', 'world'), (None, 'world'),
    ('custom_awp_mp9', 'world'),
])
def test_contiguous_longest_stock_match_and_safe_fallback(raw, expected):
    resolver = EquipmentIconResolver(ICONS)
    assert resolver.resolve(raw) == expected
    assert resolver.resolve(raw) == expected  # repeated event uses same decision
    assert expected in ICONS


def test_reads_only_stock_index_and_refreshes_after_game_update(tmp_path):
    csgo = stock_package(tmp_path / 'csgo')
    (csgo / 'pov.vpk').write_bytes(write_inline_vpk({
        'panorama/images/icons/equipment/third_party.vsvg_c': b'ignore'}))
    assert load_equipment_icons(csgo) == ICONS
    stock_package(csgo, ICONS | {'future_weapon'})
    assert 'future_weapon' in load_equipment_icons(csgo)


@pytest.mark.parametrize('contents', [None, b'broken', write_inline_vpk({
    'panorama/images/icons/equipment/ak47.vsvg_c': b'no fallback'})])
def test_unavailable_or_invalid_stock_index_does_not_invent_a_catalog(tmp_path, contents):
    if contents is not None:
        (tmp_path / 'pak01_dir.vpk').write_bytes(contents)
    with pytest.raises(ValueError, match='equipment'):
        load_equipment_icons(tmp_path)


def test_disabled_killfeed_needs_no_game_catalog():
    template = (ROOT / 'pov/pov_voice_template.vpk').read_bytes()
    bind_persistent_killfeed(template, enabled=False)
    with pytest.raises(ValueError, match='游戏资源目录'):
        load_equipment_icons(None)


@pytest.mark.parametrize('killfeed_only', [False, True], ids=['obs-hud', 'obs-killfeed-only'])
def test_shared_binding_normalizes_real_platform_spellings_and_rebinds_cache(tmp_path, killfeed_only):
    csgo = stock_package(tmp_path / 'csgo')
    original = (ROOT / 'pov/pov_voice_template.vpk').read_bytes()
    if killfeed_only:
        original = killfeed_only_template(original)
    table = {'tick': [100, 101, 102], 'attacker_name': ['A', 'B', 'A'],
             'attacker_steamid': ['123', '456', '123'], 'user_name': ['B', 'A', 'B'],
             'user_steamid': ['456', '123', '456'],
             'weapon': ['5ExTEAMSPIRIT_m4a1', 'unknown?weapon', '5e_plus1_m4a1_silencer']}
    parser = SimpleNamespace(parse_event=lambda event, **kwargs:
                             {'tick': [0]} if event == 'round_start' else table)
    kwargs = dict(enabled=True, demo_path='unused', parser=parser, target_xuid='123',
                  segments=[{'start_tick': 90, 'end_tick': 110}], csgo_dir=csgo)
    def settings(vpk):
        blocks = []
        rewrite_panorama_data(read_inline_vpk(vpk)[VOICE_SCRIPT_PATH], lambda b: blocks.append(b) or b)
        return json.loads(blocks[0].split(DATA_BEGIN)[1].split(DATA_END)[0])
    first = bind_persistent_killfeed(original, **kwargs)
    events = settings(first)['events']
    assert [e['weapon'] for e in events] == ['m4a1', 'm4a1_silencer']
    assert [e['id'] for e in events] == ['100:0', '102:2']
    assert settings(first)['target_xuid'] == '123'
    # A changed local default catalog must be reflected even with a cached VPK.
    stock_package(csgo, ICONS | {'5exteamspirit_m4a1'})
    second = bind_persistent_killfeed(first, **kwargs)
    assert settings(second)['events'][0]['weapon'] == '5exteamspirit_m4a1'
