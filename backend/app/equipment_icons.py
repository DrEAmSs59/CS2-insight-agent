"""Resolve Demo killfeed names against the configured game's stock icons."""
import logging
from pathlib import Path
import re

from .chroma_skybox_child import ChromaSkyboxChildError, _read_header, _parse_tree

_LOGGER = logging.getLogger(__name__)
_ICON_PATH = re.compile(r"panorama/images/icons/equipment/([a-z0-9_]+)\.vsvg_c")


def load_equipment_icons(csgo_dir) -> frozenset[str]:
    """Read only the stock VPK index, never third-party mounts or icon payloads.

    Read afresh for each session/rebind so game updates cannot leave a stale
    allowlist in the running backend. No files are extracted or modified.
    """
    if csgo_dir is None:
        raise ValueError("击杀常驻缺少游戏资源目录")
    directory = Path(csgo_dir) / "pak01_dir.vpk"
    try:
        with directory.open("rb") as stream:
            header = _read_header(stream, file_size=directory.stat().st_size)
            tree = stream.read(header.tree_size)
        if len(tree) != header.tree_size:
            raise ValueError("truncated equipment VPK index")
        entries = _parse_tree(tree)
        names = frozenset(match[1] for path in entries
                          if (match := _ICON_PATH.fullmatch(path)))
        if "world" not in names:
            raise ValueError("stock world equipment icon missing")
        return names
    except (OSError, ValueError, ChromaSkyboxChildError) as exc:
        raise ValueError(f"击杀常驻无法读取游戏默认 equipment 图标：{exc}") from exc


class EquipmentIconResolver:
    def __init__(self, names):
        self.names = frozenset(names)
        if "world" not in self.names or any(
                not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_]+", name)
                for name in self.names):
            raise ValueError("击杀常驻默认 equipment 图标清单无效")
        self.ordered = sorted(self.names, key=lambda name: (-len(name), name))
        self.cache = {}

    def resolve(self, raw) -> str:
        original = str(raw or "world")
        if original in self.cache:
            return self.cache[original]
        value = original.casefold().removeprefix("weapon_")
        if value in self.names:
            selected = value
        else:
            matches = [name for name in self.ordered if name in value]
            # The longest contiguous match preserves m4a1_silencer and knife
            # variants. Equal-length alternatives are ambiguous, not guesses.
            if matches and (len(matches) == 1 or len(matches[0]) > len(matches[1])):
                selected = matches[0]
            else:
                selected = "world"
                _LOGGER.warning("Killfeed equipment has no unique match; using world: %.160r", original)
        if selected != value:
            _LOGGER.info("Killfeed equipment normalized: %.160r -> %s", original, selected)
        self.cache[original] = selected
        return selected
