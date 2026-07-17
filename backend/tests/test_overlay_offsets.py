from types import SimpleNamespace

from app import env_utils
from app.recording.executor import recording_executor


def test_overlay_offsets_use_request_base_and_killfx_fine_tune(monkeypatch):
    monkeypatch.setattr(
        env_utils,
        "load_config",
        lambda: SimpleNamespace(
            kb_overlay_enabled=False,
            kill_fx_enabled=True,
            kb_overlay_tick_offset=6,
            kill_fx_tick_offset=0,
        ),
    )
    segment = SimpleNamespace(metadata={
        "kill_track": [],
        "kb_tick_offset": 8,
        "kill_fx_tick_offset": -3,
    })

    bus, base_offset, killfx_extra = recording_executor._kb_bus(segment)

    assert bus is not None
    assert base_offset == 8
    assert killfx_extra == -3
    assert base_offset + killfx_extra == 5


def test_overlay_offsets_fall_back_to_config_for_legacy_requests(monkeypatch):
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

    _, base_offset, killfx_extra = recording_executor._kb_bus(segment)

    assert base_offset == 6
    assert killfx_extra == 2
