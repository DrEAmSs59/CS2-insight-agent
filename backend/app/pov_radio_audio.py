"""Shared recording/playback POV callout filter, composed into session VPKs."""
from functools import lru_cache
from pathlib import Path
import re
import zlib

from . import chroma_skybox_child as vpk
from .sound_resource_kv3 import edit_resource, read_resource

STACK_PATH = 'soundstacks/soundstacks_csgo_mega.vsndstck_c'
TEAM_CVAR = 'snd_op_test_convar'
MARKER = 'insight_pov_radio'
BEGIN = b'/*__CS2_INSIGHT_RADIO_AUDIO_BEGIN__*/'
END = b'/*__CS2_INSIGHT_RADIO_AUDIO_END__*/'
# Only agent resources are visited. Filter all of their spoken communication,
# including round chatter, reports, requests and celebrations. Keep physical
# vocalizations and menu previews audible independently of the POV team.
# Match the whole suffix: sees_hostage_death and request_fallback are speech.
NON_CALLOUT_NAME = re.compile(
    r'(?:vo_preview|(?:[a-z0-9]+_)?'
    r'(?:death|pain|hurt|breath|effort|grunt|jump|land|cough|gasp)'
    r'(?:_[a-z]+)*_?\d+(?:_tk\d+)?)', re.I)


def is_team_callout(name: str, *, agent_name: str) -> bool:
    namespace, separator, voice = name.partition('.')
    return bool(separator and voice and namespace.casefold() == agent_name.casefold()
                and not NON_CALLOUT_NAME.fullmatch(voice))


def patch_stack(root):
    operators = root['csgo_mega']['operators']
    by_name = {op['name']: op for op in operators}
    if by_name['get_entity_info']['operator'] != 'game_entity_info':
        raise ValueError('POV radio source entity operator changed')
    mixer = by_name['mult_mixer_volume']
    if mixer['operator'] != 'math_accumulate12_float' or mixer['apply'] != 'mult' or 'input7' in mixer:
        raise ValueError('POV radio volume operator changed')
    by_name['public']['operator_variables'][MARKER] = {'data_type':'bool','value':'false'}
    gate = [
        # The sound operator system provides this float for custom graphs.
        # setinfo variables are strings and convar_get reads them as zero.
        # Updating a stack field changes defaults, not already playing events;
        # reading the float every update also gates ongoing callouts on POV cuts.
        {'name':'insight_radio_team','operator':'convar_get','convar':TEAM_CVAR,
         'output':'0','execute_once':'false','input_execute':'@public.'+MARKER},
        {'name':'insight_radio_audience','operator':'math_float_eval','execute_once':'false',
         # -1 bypasses filtering in ordinary spectator HUD; 0 remains unknown
         # POV team (mute), so seeking cannot accidentally enable enemy speech.
         'expression':'_3 ? (_1 == -1 || ((_1 == 2 || _1 == 3) && _1 == _2)) : 1',
         'input1':'@insight_radio_team.output','input2':'@get_entity_info.output_team',
         'input3':'@public.'+MARKER},
    ]
    operators[operators.index(mixer):operators.index(mixer)] = gate
    mixer['input7'] = '@insight_radio_audience.output'


def patch_callouts(root, *, agent_name: str):
    changed = 0
    for name, event in root.items():
        if (is_team_callout(name, agent_name=agent_name)
                and isinstance(event,dict) and event.get('type') == 'csgo_mega'):
            event[MARKER] = True
            changed += 1
    return changed


def _read_entry(directory, header, entry):
    inline = entry.archive_index == vpk._INLINE_ARCHIVE_INDEX
    archive = directory if inline else directory.with_name(directory.name[:-8]+f'_{entry.archive_index:03d}.vpk')
    with archive.open('rb') as stream:
        stream.seek((header.data_start if inline else 0)+entry.offset)
        raw = entry.preload+stream.read(entry.length)
    if len(raw) != len(entry.preload)+entry.length or zlib.crc32(raw)&0xffffffff != entry.crc32:
        raise ValueError('POV radio installed sound resource failed CRC')
    return raw


@lru_cache(maxsize=2)
def _resources(directory: str, size: int, modified: int):
    del size, modified  # Cache invalidated when the installed VPK index changes.
    directory=Path(directory)
    with directory.open('rb') as stream:
        header=vpk._read_header(stream,file_size=directory.stat().st_size)
        entries=vpk._parse_tree(bytearray(stream.read(header.tree_size)))
    result={}
    count=0
    for name, entry in entries.items():
        if not (name.startswith('soundevents/vo/agents/') and name.endswith('.vsndevts_c')):
            continue
        filename=Path(name).name
        if not filename.startswith('game_sounds_'): continue
        agent_name=filename.removeprefix('game_sounds_').removesuffix('.vsndevts_c')
        raw=_read_entry(directory,header,entry)
        root=read_resource(raw)
        if not any(is_team_callout(key, agent_name=agent_name) for key in root): continue
        def edit(value):
            nonlocal count
            count += patch_callouts(value, agent_name=agent_name)
        result[name]=edit_resource(raw,edit)
    if not count: raise ValueError('POV team callouts were not found in installed CS2')
    result[STACK_PATH]=edit_resource(_read_entry(directory,header,entries[STACK_PATH]),patch_stack)
    return result


def bind_pov_radio_audio(package: bytes, *, csgo_dir: Path, assets_dir: Path | None = None) -> bytes:
    from .demo_voice_hud import VOICE_SCRIPT_PATH, read_inline_vpk, write_inline_vpk
    from .panorama_resource import rewrite_panorama_data
    if assets_dir is None:
        from .pov_hud_manager import find_project_root
        assets_dir=find_project_root()/'pov'
    script=(assets_dir/'radio_audio.js').read_bytes().replace(b'\r\n',b'\n')
    directory=(Path(csgo_dir)/'pak01_dir.vpk').resolve()
    stat=directory.stat()
    entries=read_inline_vpk(package)
    def edit(data):
        if data.count(BEGIN)!=data.count(END) or data.count(BEGIN)>1:
            raise ValueError('POV radio script boundaries are invalid')
        if BEGIN in data:
            start,end=data.index(BEGIN),data.index(END)
            if end<start: raise ValueError('POV radio script boundaries are reversed')
            data=data[:start]+data[end+len(END):]
        anchor=data.rfind(b'\n})();')
        if anchor<0 or data[anchor:].strip()!=b'})();':
            raise ValueError('POV radio shared HUD context is missing')
        return data[:anchor]+BEGIN+b'\n'+script+b'\n'+END+data[anchor:]
    entries[VOICE_SCRIPT_PATH]=rewrite_panorama_data(entries[VOICE_SCRIPT_PATH],edit)
    entries.update(_resources(str(directory),stat.st_size,stat.st_mtime_ns))
    return write_inline_vpk(entries)
