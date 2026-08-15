from __future__ import annotations

import pytest

from app.features.demo_analysis.cs2_item_catalog import resolve_weapon_model
from app.features.demo_analysis.weapons import (
    WEAPON_TRANSLATION_MAP,
    _highlight_weapon_used_label,
    _normalize_item,
    _translate_weapon,
)
from app.features.demo_analysis.match_workspace import _normalize_weapon
from app.features.demo_analysis.replay_match_cache import _resolved_weapon


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # PWA aliases observed in real demos.
        ("ak47_txz09", "ak47"),
        ("famas_txz15", "famas"),
        ("fiveseven_vip", "fiveseven"),
        ("hkp2000_txz03", "hkp2000"),
        ("m4a1_silencer_off", "m4a1_silencer"),
        ("m4a1_silencer_txz15", "m4a1_silencer"),
        ("xm1014_vip", "xm1014"),
        # 5E aliases observed in real demos; event names are intentionally dynamic.
        ("5e_summernbsr2026002_awp", "awp"),
        ("5e_tyloo2025_deagle_ace", "deagle"),
        ("5e_tyloo2025_m4a1", "m4a1"),
        ("5e_tyloo2025_m4a1_silencer", "m4a1_silencer"),
        ("5e_tyloo2025_usp_silencer", "usp_silencer"),
        ("5e_match_weapon_knife_butterfly", "knife_butterfly"),
    ],
)
def test_platform_weapon_aliases_resolve_to_catalog_models(raw: str, expected: str):
    assert _normalize_item(raw) == expected


@pytest.mark.parametrize(
    "template",
    [
        "{model}_vip",
        "{model}_txz15",
        "5e_summernbsr2026002_{model}",
        "5e_tyloo2025_{model}_ace",
    ],
)
def test_platform_affix_rules_cover_every_catalog_model(template: str):
    models = sorted(
        model
        for model in WEAPON_TRANSLATION_MAP
        if resolve_weapon_model(model) == model
    )
    assert len(models) >= 40
    for model in models:
        raw = template.format(model=model)
        assert _normalize_item(raw) == model, raw


def test_longest_catalog_alias_wins_and_unknown_sources_are_preserved():
    assert _normalize_item("5e_event_m4a1_silencer_ace") == "m4a1_silencer"
    assert _normalize_item("5e_event_m4a1_ace") == "m4a1"
    assert _normalize_item("community_laser_cannon_v2") == "community_laser_cannon_v2"
    assert resolve_weapon_model("notak47") == ""


def test_match_workspace_uses_the_shared_canonicalizer():
    assert _normalize_weapon("item_5e_event_m4a1_silencer_ace") == "m4a1_silencer"
    assert _normalize_weapon("weapon_ak47_txz15") == "ak47"
    assert _normalize_item("weapon_knife") == "knife"
    assert _normalize_item("planted_c4") == "planted_c4"


def test_replay_active_weapon_uses_the_shared_canonicalizer():
    assert _resolved_weapon(
        {"active_weapon_name": "5e_event_m4a1_silencer_ace"},
        [],
    ) == "m4a1_silencer"
    assert _resolved_weapon({}, ["ak47_txz15", "Smoke Grenade"]) == "ak47"


def test_weapon_labels_and_highlight_counts_use_canonical_models():
    assert _translate_weapon("5e_tyloo2025_deagle_ace") == WEAPON_TRANSLATION_MAP["deagle"]
    assert _highlight_weapon_used_label(
        [
            {"weapon": "ak47_vip"},
            {"weapon": "ak47_txz15"},
            {"weapon": "5e_event_ak47"},
        ]
    ) == WEAPON_TRANSLATION_MAP["ak47"]
