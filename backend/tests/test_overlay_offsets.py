from types import SimpleNamespace

from app import env_utils
from app.recording.executor import recording_executor


def test_overlay_offsets_use_independent_request_values(monkeypatch):
    monkeypatch.setattr(
        env_utils,
        "load_config",
        lambda: SimpleNamespace(
            kb_overlay_enabled=False,
            kill_fx_enabled=True,
            kb_overlay_tick_offset=6,
            kill_fx_tick_offset=6,
        ),
    )
    segment = SimpleNamespace(metadata={
        "kill_track": [],
        "kb_tick_offset": 8,
        "kill_fx_tick_offset": -3,
    })

    bus, keyboard_offset, killfx_offset = recording_executor._kb_bus(segment)

    assert bus is not None
    assert keyboard_offset == 8
    assert killfx_offset == -3


def test_overlay_offsets_fall_back_to_independent_config_values(monkeypatch):
    monkeypatch.setattr(
        env_utils,
        "load_config",
        lambda: SimpleNamespace(
            kb_overlay_enabled=False,
            kill_fx_enabled=True,
            kb_overlay_tick_offset=6,
            kill_fx_tick_offset=2,
        ),
    )
    segment = SimpleNamespace(metadata={"kill_track": []})

    _, keyboard_offset, killfx_offset = recording_executor._kb_bus(segment)

    assert keyboard_offset == 6
    assert killfx_offset == 2


def test_legacy_config_migrates_killfx_extra_to_independent_offset():
    raw = {
        "kb_overlay_tick_offset": 56,
        "kill_fx_tick_offset": -3,
    }
    cfg = env_utils.AppConfig(**raw)

    changed = env_utils._normalize_config_defaults(cfg, raw)

    assert changed is True
    assert cfg.kb_overlay_tick_offset == 56
    assert cfg.kill_fx_tick_offset == 53
    assert cfg.overlay_offsets_independent is True


def test_independent_config_offsets_are_not_combined_again():
    raw = {
        "kb_overlay_tick_offset": 56,
        "kill_fx_tick_offset": -3,
        "overlay_offsets_independent": True,
    }
    cfg = env_utils.AppConfig(**raw)

    env_utils._normalize_config_defaults(cfg, raw)

    assert cfg.kb_overlay_tick_offset == 56
    assert cfg.kill_fx_tick_offset == -3


def test_legacy_config_without_killfx_offset_inherits_previous_base_timing():
    raw = {"kb_overlay_tick_offset": 12}
    cfg = env_utils.AppConfig(**raw)

    env_utils._normalize_config_defaults(cfg, raw)

    assert cfg.kb_overlay_tick_offset == 12
    assert cfg.kill_fx_tick_offset == 12
