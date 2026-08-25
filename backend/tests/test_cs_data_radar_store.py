"""cs数据图 卡片存储测试（自动录制全部玩家的雷达图）。"""

import json
from pathlib import Path

from app.features.cs_data_radar.store import (
    clear_card_team_logo,
    create_cards_from_players,
    delete_card,
    get_card,
    get_data_dir,
    list_cards_public,
    replace_card_image,
    resolve_card_image_path,
    set_card_portrait,
    set_card_team_logo,
)

_PLAYERS = [
    {
        "name": "Donk",
        "display_name": "Donk",
        "steam_id64": "76561198000000001",
        "team_key": "2",
        "team_label": "T",
        "kills": 28,
        "deaths": 12,
        "assists": 7,
        "kpr": 0.99,
        "dpr": 0.42,
        "adr": 101.4,
        "kast": 78.2,
        "survival_rate": 34.0,
    },
    {
        "name": "ZywOo",
        "display_name": "ZywOo",
        "steam_id64": "76561198000000002",
        "team_key": "3",
        "team_label": "CT",
        "kills": 20,
        "deaths": 15,
        "assists": 9,
        "kpr": 0.71,
        "dpr": 0.53,
        "adr": 88.1,
        "kast": 71.5,
        "survival_rate": 40.0,
    },
]

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # 非法但足够小的 PNG 头（仅用于写入测试）


def test_create_cards_for_all_players(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    cards = create_cards_from_players(_PLAYERS, demo_id=7, demo_name="g161.dem")
    assert len(cards) == 2
    for card in cards:
        assert card["demo_id"] == 7
        assert card["image_url"].startswith("/api/cs-data-radar/images/")
        # 生成的文件必须真实存在且可解析
        path = resolve_card_image_path(get_card(card["id"]))
        assert path is not None and path.is_file()
        # 对外暴露绝对路径，供合辑导出（montage radar_segments）直接使用
        assert card["image_path"] and Path(card["image_path"]).is_file()
    # 全场均值基准线：两名玩家各维度的平均值（红色基准六边形），允许派生/舍入误差
    avg = cards[0]["match_avg"]
    assert abs(avg["kpr"] - (0.99 + 0.71) / 2) < 0.01
    assert abs(avg["adr"] - (101.4 + 88.1) / 2) < 0.01
    assert abs(avg["kast"] - (0.782 + 0.715) / 2) < 0.01
    # JSON 索引落盘
    index_file = get_data_dir() / "cards.json"
    assert index_file.is_file()
    data = json.loads(index_file.read_text(encoding="utf-8"))
    assert len(data["cards"]) == 2


def test_list_and_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    cards = create_cards_from_players(_PLAYERS, demo_id=1, demo_name="a.dem")
    assert len(list_cards_public()) == 2
    first = cards[0]
    assert delete_card(first["id"]) is True
    assert len(list_cards_public()) == 1
    assert delete_card(first["id"]) is False  # 已删除


def test_portrait_and_image_replace(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    cards = create_cards_from_players(_PLAYERS, demo_id=2, demo_name="b.dem")
    card = cards[0]

    updated = set_card_portrait(card["id"], _PNG, ".png")
    assert updated is not None
    assert updated["portrait_file"]
    portrait_path = get_data_dir() / str(updated["portrait_file"])
    assert portrait_path.is_file()

    replaced = replace_card_image(card["id"], _PNG)
    assert replaced is not None
    image_path = get_data_dir() / str(replaced["image_file"])
    assert image_path.read_bytes().startswith(b"\x89PNG")

    assert set_card_portrait("missing-id", _PNG, ".png") is None
    assert replace_card_image("missing-id", _PNG) is None


def test_team_logo_set_and_clear(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    cards = create_cards_from_players(_PLAYERS, demo_id=3, demo_name="c.dem")
    card = cards[0]
    card_id = card["id"]

    updated = set_card_team_logo(card_id, _PNG, ".png")
    assert updated is not None
    assert updated["team_logo_file"]
    assert updated["team_logo_url"].startswith("/api/cs-data-radar/images/")
    logo_path = get_data_dir() / str(updated["team_logo_file"])
    assert logo_path.is_file()
    # 卡片持久化含队标字段
    assert get_card(card_id)["team_logo_file"] == updated["team_logo_file"]

    # 换后缀重传：旧文件被清理，新文件存在
    updated2 = set_card_team_logo(card_id, _PNG, ".jpg")
    assert updated2 is not None
    assert updated2["team_logo_file"].endswith(".jpg")
    assert not logo_path.exists()  # 旧 .png 队标已删除

    # 清除队标：字段置空 + 文件删除
    cleared = clear_card_team_logo(card_id)
    assert cleared is not None
    assert not cleared.get("team_logo_file")
    assert not (get_data_dir() / str(updated2["team_logo_file"])).exists()

    assert set_card_team_logo("missing-id", _PNG, ".png") is None
    assert clear_card_team_logo("missing-id") is None
