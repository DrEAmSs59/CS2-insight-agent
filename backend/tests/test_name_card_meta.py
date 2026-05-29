"""名牌元数据：时间线片段眉标与标签。"""

from app.name_card_meta import (
    build_name_card_tags_and_result,
    resolve_name_card_category,
    resolve_name_card_eyebrow,
)


def test_timeline_kill_eyebrow_and_tags():
    row = {
        "workbench_clip_kind": "timeline_kill",
        "category": "timeline",
        "timeline_record_kind": "kill",
        "round": 18,
        "victims": ["karrigan"],
        "weapon_used": "ak47",
        "kill_count": 1,
    }
    cat = resolve_name_card_category(row)
    assert cat == "highlight"
    assert resolve_name_card_eyebrow(row, cat) == "ROUND 18"
    tags, result = build_name_card_tags_and_result(row, cat)
    assert tags == ["击杀 karrigan", "ak47"]
    assert result is None


def test_timeline_death_eyebrow_and_tags():
    row = {
        "workbench_clip_kind": "timeline_death",
        "category": "timeline",
        "timeline_record_kind": "death",
        "round": 14,
        "killer_name": "NiKo",
    }
    cat = resolve_name_card_category(row)
    assert cat == "fail"
    assert resolve_name_card_eyebrow(row, cat) == "ROUND 14"
    tags, result = build_name_card_tags_and_result(row, cat)
    assert tags[0] == "被 NiKo 击杀"
    assert result is None


def test_timeline_round_eyebrow():
    row = {
        "workbench_clip_kind": "timeline_round",
        "timeline_record_kind": "round",
        "round": 11,
        "queue_summary_line": "本回合目标 2 杀 / 1 死 / 0 助攻",
    }
    cat = resolve_name_card_category(row)
    assert resolve_name_card_eyebrow(row, cat) == "ROUND 11 · 整回合"
    tags, result = build_name_card_tags_and_result(row, cat)
    assert tags == ["本回合目标 2 杀 / 1 死 / 0 助攻"]
    assert result is None


def test_highlight_still_uses_classic_eyebrow():
    row = {"category": "highlight", "kill_count": 3, "victims": ["a", "b", "c"]}
    cat = resolve_name_card_category(row)
    assert resolve_name_card_eyebrow(row, cat) == "HIGHLIGHT · 高光"
    _, result = build_name_card_tags_and_result(row, cat)
    assert result == "三杀"


def test_highlight_filters_victim_and_kill_tags():
    row = {
        "category": "highlight",
        "kill_count": 2,
        "victims": ["教皇311", "血色的使"],
        "context_tags": [
            "ECO翻盘局",
            "击杀血色的使",
            "教皇311",
            "双杀",
            "贴脸狙击",
        ],
    }
    tags, result = build_name_card_tags_and_result(row, "highlight")
    assert result == "双杀"
    assert "ECO翻盘局" in tags
    assert "贴脸狙击" in tags
    assert "教皇311" not in tags
    assert "血色的使" not in tags
    assert not any("击杀" in t for t in tags)


def test_fail_filters_killer_tags():
    row = {
        "category": "fail",
        "killer_name": "NiKo",
        "context_tags": ["被 NiKo 击杀", "沙鹰爆头", "NiKo"],
    }
    tags, _ = build_name_card_tags_and_result(row, "fail")
    assert "沙鹰爆头" in tags
    assert not any("NiKo" in t for t in tags)


def test_kill_compilation_filters_rival_stat_tag():
    row = {
        "workbench_clip_kind": "kill_compilation",
        "category": "compilation",
        "victims": ["enemy1"],
        "context_tags": ["🥩 亲儿子喂饭", "👉 enemy1 × 8", "智斗"],
    }
    cat = resolve_name_card_category(row)
    tags, _ = build_name_card_tags_and_result(row, cat)
    assert "🥩 亲儿子喂饭" in tags
    assert "智斗" in tags
    assert not any("enemy1" in t for t in tags)
