"""Platform restrictions shared by input extraction and HUD generation."""

from pathlib import Path
from typing import Any, Callable, Mapping

from .recording.platform_utils import infer_demo_source


def demo_disables_player_input(
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> bool:
    """Check the filename and header before running the UserCmd extractor.

    Header inspection also covers renamed demos and playback copies such as
    ``source.dem``. Unknown platforms retain the normal extraction behavior.
    """
    path = Path(demo_path)
    if infer_demo_source(path.name) == "Perfect World":
        return True
    try:
        if parser_factory is None:
            from demoparser2 import DemoParser

            parser_factory = DemoParser
        header = parser_factory(str(path)).parse_header()
    except Exception:  # Header availability varies by parser/demo version.
        return False
    server_name = header.get("server_name", "") if isinstance(header, Mapping) else ""
    return infer_demo_source(path.name, str(server_name or "")) == "Perfect World"
