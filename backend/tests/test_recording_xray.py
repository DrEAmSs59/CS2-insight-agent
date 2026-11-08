"""DEMO recording keeps player IDs on the same switch as X-ray outlines."""
import asyncio
from types import SimpleNamespace

import pytest

from app.env_utils import OBSConfig
from app.obs_director import OBSDirector, RecordingWarmupExtras, _filter_post_spec_console_lines
from app import pov_hud_manager
from app.recording import plan_builder, obs_targets
from app.recording.executor import obs_recording_controller


def recording_commands(warmup, *, custom=""):
    return OBSDirector(OBSConfig(), "", record_inject_console_lines=custom)._recording_warmup_console_lines(
        RecordingWarmupExtras(**warmup),
    )


def effective(commands, name):
    return [line.split()[1] for line in commands if line.startswith(name + " ")][-1]


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("hidden", [False, True])
@pytest.mark.parametrize("xray", [False, True])
def test_demo_recording_xray_controls_overhead_ids(batch, hidden, xray):
    warmup = {"cl_draw_only_deathnotices": hidden, "spec_show_xray": int(xray)}
    if batch:
        # Existing clients and saved queues already carry their own cvar batch.
        warmup["console_cmds"] = [
            f"cl_draw_only_deathnotices {str(hidden).lower()}",
            f"spec_show_xray {int(xray)}",
        ]
    commands = recording_commands(warmup)
    assert effective(commands, "spec_show_xray") == str(int(xray))
    expected = "1" if xray and not hidden else "-1"
    assert effective(commands, "cl_drawhud_force_teamid_overhead") == expected
    assert effective(_filter_post_spec_console_lines(commands), "cl_drawhud_force_teamid_overhead") == expected


@pytest.mark.parametrize("xray", [False, True])
def test_custom_xray_override_and_stale_overhead_setting_stay_consistent(xray):
    commands = recording_commands({
        "cl_draw_only_deathnotices": False, "spec_show_xray": int(not xray),
    }, custom=f'CL_DRAW_ONLY_DEATHNOTICES "0"\nSPEC_SHOW_XRAY "{int(xray)}"\ncl_drawhud_force_teamid_overhead {1 if not xray else -1}')
    assert effective(commands, "cl_drawhud_force_teamid_overhead") == ("1" if xray else "-1")


def test_legacy_batch_xray_takes_precedence_over_default_field():
    commands = recording_commands({"console_cmds": [
        'cl_draw_only_deathnotices "false"', 'spec_show_xray "1"',
    ]})
    assert effective(commands, "cl_drawhud_force_teamid_overhead") == "1"


@pytest.mark.parametrize("pov", [False, True])
@pytest.mark.parametrize("hidden", [False, True])
@pytest.mark.parametrize("xray", [False, True])
def test_queue_embeds_demo_policy_and_preserves_pov_override(monkeypatch, tmp_path, pov, hidden, xray):
    installed = []

    class Manager:
        def __init__(self, _config): pass
        def install(self, **kwargs): installed.append(kwargs)
        def status(self): return {"original_gameinfo_sha256": "a" * 64}

    class Controller:
        def __init__(self, *_args): pass
        async def force_stop_recording(self): return True

    monkeypatch.setenv("CS2_INSIGHT_PANORAMA_FAST_PATH", "1")
    monkeypatch.setattr(pov_hud_manager, "PovHudManager", Manager)
    monkeypatch.setattr(pov_hud_manager, "restore_pov_after_cs2_exit", lambda *a, **k: {"verified": True})
    monkeypatch.setattr(obs_recording_controller, "OBSRecordingController", Controller)
    monkeypatch.setattr(obs_targets, "prepare_obs_plan_targets", lambda plans, _: plans)
    monkeypatch.setattr(plan_builder, "build_plan", lambda dto: SimpleNamespace(
        request_id=dto.request_id, demo_path=dto.demo.demo_path, segments=[SimpleNamespace(
            disabled=False, target_spec_slot=1, target_steamid64="76561198000000000",
            segment_index=0, start_tick=100, end_tick=200, metadata={"obs_controller_slot": 1},
        )],
    ))
    director = OBSDirector(OBSConfig(), "")
    monkeypatch.setattr(director, "_game_root_from_cs2_exe", lambda _: tmp_path / "game")

    def launch(*args, **kwargs):
        raise RuntimeError("simulated launch failure")

    monkeypatch.setattr(director, "_launch_cs2", launch)
    monkeypatch.setattr(director, "_kill_cs2", lambda: None)
    monkeypatch.setattr(director, "_cleanup_cs2_artifacts", lambda: None)
    request = SimpleNamespace(request_id="xray", demo=SimpleNamespace(
        demo_path=str(tmp_path / "test.dem"), demo_filename="test.dem", map_name="de_dust2",
    ), target_player=SimpleNamespace(steamid64="76561198000000000"))
    asyncio.run(director.execute_plan_queue([request], warmup=RecordingWarmupExtras(
        pov_hud_enabled=pov, recording_hud_enabled=True,
        cl_draw_only_deathnotices=hidden, spec_show_xray=int(xray),
    )))
    assert len(installed) == 1
    commands = installed[0]["session_console_commands"]
    assert effective(commands, "cl_drawhud_force_teamid_overhead") == ("1" if pov or (xray and not hidden) else "-1")
