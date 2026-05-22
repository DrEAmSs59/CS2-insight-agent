import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.env_utils import AppConfig

def test_steam_fields_defaults():
    cfg = AppConfig()
    assert cfg.steam_api_key == ""
    assert cfg.steam_id64 == ""
    assert cfg.match_mode == "premier"
    assert cfg.match_count == 20

def test_steam_fields_from_dict():
    cfg = AppConfig(steam_api_key="ABCD1234", steam_id64="76561198012345678", match_mode="competitive", match_count=50)
    assert cfg.steam_api_key == "ABCD1234"
    assert cfg.match_mode == "competitive"
    assert cfg.match_count == 50
