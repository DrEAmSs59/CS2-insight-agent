import copy
import struct

import pytest

from app.pov_radio_audio import MARKER, is_team_callout, patch_callouts, patch_stack
from app.sound_resource_kv3 import Flagged, decode, encode, edit_resource, read_resource


@pytest.mark.parametrize('name', [
    'phoenix.t_smoke01', 'sas.ct_flashbang03', 'leet.t_grenade05',
    'swat.ct_decoy03', 'sas.ct_molotov04', 'balkan_epic.throwing_fire_03',
    'gendarmerie_fem.ff1_throwing_grenade_01', 'seal_fem.af1_throwing_smoke_02',
    'sas.defusingbomb03', 'phoenix.bombtickingdown03', 'sas.radio.letsgo02',
    'phoenix.radiobotendsolid04', 'balkan_epic.request_smoke_01',
    'balkan_epic.sees_hostage_death_01', 'seal_fem.af1_request_fallback_01',
    'professional_fem.bomb_planted_01', 'professional_fem.friend_plant_bomb_01',
    'phoenix.goingtoplantbomb01', 'professional.radiobotplantinggo01',
])
def test_agent_communication_is_filtered_without_physical_vocalizations(name):
    agent_name=name.partition('.')[0]
    root={name:{'type':'csgo_mega','volume':0.7}, 'Weapon.HEGrenade.Explode':{'type':'csgo_mega'},
          'Player.DamageBody.Onlooker':{'type':'csgo_mega'},
          **{f'{agent_name}.{voice}':{'type':'csgo_mega'} for voice in [
              'ct_death01', 't_death03', 'death_01', 'af1_death_02',
              'afm2_death_03_tk01', 'pain_small_01', 'vo_preview']}}
    before=copy.deepcopy(root)
    assert patch_callouts(root, agent_name=agent_name)==1
    assert root.pop(name)==dict(before.pop(name),**{MARKER:True})
    assert root==before


def test_gate_preserves_existing_volume_and_uses_live_entity_team():
    root={'csgo_mega':{'operators':[
        {'name':'public','operator':'util_null','operator_variables':{'volume':{'value':'1'}}},
        {'name':'get_entity_info','operator':'game_entity_info','input_entity_index':'@source_info.output_entity_index'},
        {'name':'mult_mixer_volume','operator':'math_accumulate12_float','apply':'mult','input1':'@mixer.output_volume'},
    ]}}
    before=copy.deepcopy(root)
    patch_stack(root)
    ops={op['name']:op for op in root['csgo_mega']['operators']}
    assert ops['get_entity_info']==before['csgo_mega']['operators'][1]
    assert ops['mult_mixer_volume']['input1']=='@mixer.output_volume'
    assert ops['insight_radio_audience']['input2']=='@get_entity_info.output_team'
    assert ops['insight_radio_team']['execute_once']=='false'
    assert ops['insight_radio_team']['convar']=='snd_op_test_convar'
    assert ops['insight_radio_team']['input_execute']=='@public.'+MARKER
    assert ops['insight_radio_audience']['operator']=='math_float_eval'
    assert ops['public']['operator_variables'][MARKER]['value']=='false'
    with pytest.raises(ValueError): patch_stack(root)


def test_resource_edit_preserves_flags_numbers_and_other_blocks():
    value={'voice':{'position':[0.,0.,60.], 'file':Flagged('sounds/vo/test.vsnd',1),
                    'choices':[True,False,None,-42,2**63+1,0.75]}}
    data=encode(value,bytes.fromhex('7c161274e9069846aff2e63eb59037e7'))
    other=b'untouched resource metadata'
    # Non-DATA block follows DATA: offsets and header size must be relocated.
    raw=(struct.pack('<IHHII',40+len(data)+len(other),12,1,8,2)
         +b'DATA'+struct.pack('<II',20,len(data))
         +b'TEST'+struct.pack('<II',8+len(data),len(other))+data+other)
    result=edit_resource(raw,lambda root: root['voice'].update(insight_pov_radio=True))
    expected=copy.deepcopy(value);expected['voice'][MARKER]=True
    assert read_resource(result)==expected
    assert result.endswith(other)
    assert struct.unpack_from('<I',result)[0]==len(result)
    with pytest.raises(ValueError): decode(data[:-1])


def test_no_platform_or_agent_team_assumption():
    # The namespace comes from the resource, never the player's team/platform.
    assert is_team_callout('sas.ct_smoke01', agent_name='sas')
    assert is_team_callout('phoenix.t_smoke01', agent_name='phoenix')
    assert is_team_callout('future_agent.request_backup_01', agent_name='future_agent')
    assert not is_team_callout('Flashbang.Ring.Long', agent_name='sas')
    assert not is_team_callout('sounds/vo/agents/sas/ct_smoke01.vsnd', agent_name='sas')


@pytest.mark.parametrize('name', [
    'phoenix.plantingbomb02', 'leet.PlantingBomb01',
    'professional.radiobotplanting07', 'balkan_epic.planting_a_01',
    'fbihrt_epic.planting_b_03', 'professional_fem.i_plant_bomb_05',
    'jungle_fem.aff1_i_plant_bomb_01', 'jungle_male_epic.afm2_i_plant_bomb_05',
])
def test_planting_voice_is_filtered_without_bomb_effects_or_notifications(name):
    unchanged = {key: {'type': 'csgo_mega', 'volume': 1.0} for key in [
        'C4.PlantSound', 'C4.PlantSoundCompleted', 'C4.Explode', 'C4.Beep',
        'UI.BombPlanted',
    ]}
    root = {name: {'type': 'csgo_mega', 'volume': 0.7}, **copy.deepcopy(unchanged)}
    agent_name=name.partition('.')[0]
    assert is_team_callout(name, agent_name=agent_name)
    assert patch_callouts(root, agent_name=agent_name) == 1
    assert root.pop(name) == {'type': 'csgo_mega', 'volume': 0.7, MARKER: True}
    assert root == unchanged


def test_session_composition_is_repeatable_and_preserves_other_assets(tmp_path, monkeypatch):
    from app import pov_radio_audio as radio
    from app.demo_voice_hud import VOICE_SCRIPT_PATH, read_inline_vpk, write_inline_vpk
    source = b'(function () {\nconst existing = true;\n})();'
    resource = (struct.pack('<IHHII', 28 + len(source), 12, 1, 8, 1)
                + b'DATA' + struct.pack('<II', 8, len(source)) + source)
    package = write_inline_vpk({VOICE_SCRIPT_PATH: resource, 'unchanged.txt': b'original'})
    (tmp_path / 'pak01_dir.vpk').write_bytes(b'test index')
    (tmp_path / 'radio_audio.js').write_bytes(b'const testRadio = true;')
    monkeypatch.setattr(radio, '_resources', lambda *args: {radio.STACK_PATH: b'test stack'})
    first = radio.bind_pov_radio_audio(package, csgo_dir=tmp_path, assets_dir=tmp_path)
    second = radio.bind_pov_radio_audio(first, csgo_dir=tmp_path, assets_dir=tmp_path)
    entries = read_inline_vpk(second)
    assert entries['unchanged.txt'] == b'original'
    assert entries[radio.STACK_PATH] == b'test stack'
    assert entries[VOICE_SCRIPT_PATH].count(radio.BEGIN) == 1
    assert b'const existing = true;' in entries[VOICE_SCRIPT_PATH]
    assert first == second
