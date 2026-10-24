import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.recording import obs_targets, plan_builder
from app.recording.models import RecordingPlan, RecordingSegment
from app.recording.executor.spec_controller import obs_spec_slot

SID = "76561198370760326"
OTHER = "76561199129892919"


def row(tick, *, slot=11, pawn=2819, name=" Lita.", sid=SID, alive=True, **extra):
    return {"tick": tick, "name": name, "steamid": sid, "entity_id": pawn,
            "is_alive": alive, "CCSPlayerPawn.m_hController": (285 << 14) | slot,
            "CCSPlayerController.m_hPlayerPawn": (753 << 14) | pawn,
            "CCSPlayerController.m_bControllingBot": False, **extra}


def columns(rows):
    return {key: [r.get(key) for r in rows] for key in rows[0]} if rows else {}


def parser(rows, bot_rows=()):
    return SimpleNamespace(parse_ticks=Mock(side_effect=lambda fields, ticks, **kwargs:
        columns(bot_rows if "prop_states" in kwargs else [r for r in rows if r["tick"] in ticks])))


def target(**updates):
    return {"name": "Lita.", "steamid64": SID, "seek_tick": 680,
            "start_tick": 1000, "end_tick": 1300, **updates}


def plan(*, raw_slot=11, metadata=None):
    return RecordingPlan(request_id="test", request_type="highlight", demo_path="cached.dem", tick_rate=64,
        segments=[RecordingSegment(segment_index=0, source_type="kill", perspective="killer",
            start_tick=1000, end_tick=1300, safe_seek_tick=680, target_player_name="Lita.",
            target_steamid64=SID, target_spec_slot=raw_slot, metadata=metadata or {})])


@pytest.mark.parametrize("filename", ["pvp-match.dem", "g161-5e.dem", "match.dem"])
@pytest.mark.parametrize("raw_slot", [None, 10, 11, 12])
def test_real_controller_overrides_old_cache_without_mutating_shared_plan(filename, raw_slot):
    original = plan(raw_slot=raw_slot, metadata={"obs_spec_slot_offset": 1, "obs_controller_slot": 55})
    before = original.model_dump()
    reader = parser([row(680), row(1000)])
    calls = []

    def resolve(path, targets):
        calls.append((path, targets))
        return obs_targets.resolve_obs_targets(path, targets, parser=reader)

    prepared = obs_targets.prepare_obs_plan_targets([original], Path(filename), resolver=resolve)[0]
    assert original.model_dump() == before
    assert prepared.segments[0].target_spec_slot == raw_slot
    assert obs_spec_slot(prepared.segments[0], filename) == 11
    assert "obs_spec_slot_offset" not in prepared.segments[0].metadata
    assert prepared.segments[0].metadata["obs_prepare_tick"] == 680
    assert len(calls) == 1 and calls[0][0] == filename


def test_resolves_all_players_and_cuts_in_one_batch_from_the_alias_demo():
    original = plan()
    victim = original.segments[0].model_copy(update={
        "segment_index": 1, "perspective": "victim", "target_player_name": "renamed",
        "target_steamid64": OTHER, "start_tick": 2000, "end_tick": 2200, "safe_seek_tick": 1680,
    })
    original.segments.append(victim)
    reader = parser([row(680), row(1000), row(1680, slot=4, pawn=100, sid=OTHER),
                     row(2000, slot=4, pawn=100, sid=OTHER)])
    resolve = Mock(side_effect=lambda path, targets: obs_targets.resolve_obs_targets(path, targets, parser=reader))
    result = obs_targets.prepare_obs_plan_targets([original], Path("aliases.dem"), resolver=resolve)[0]
    assert resolve.call_count == 1
    assert [obs_spec_slot(s, result.demo_path) for s in result.segments] == [11, 4]
    assert reader.parse_ticks.call_args_list[0].kwargs["ticks"] == [680, 1000, 1680, 2000]


@pytest.mark.parametrize("bad_row", [
    row(1000, alive=False), row(1000, sid=OTHER),
    row(1000, **{"CCSPlayerPawn.m_hController": 0xFFFFFF}),
    row(1000, **{"CCSPlayerController.m_hPlayerPawn": 123}),
])
def test_invalid_start_never_falls_back_to_cached_slot(bad_row):
    with pytest.raises(ValueError, match="控制器"):
        obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser([row(680), bad_row]))


def test_duplicate_names_require_id_and_duplicate_controllers_fail():
    rows = [row(1000), row(1000, slot=12, pawn=3000, sid=OTHER)]
    result = obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser(rows))
    assert result[0]["slot"] == 11
    with pytest.raises(ValueError, match="重名"):
        obs_targets.resolve_obs_targets("demo.dem", [target(steamid64="")], parser=parser(rows))
    with pytest.raises(ValueError, match="控制器"):
        obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser([row(1000), row(1000, pawn=3000, sid=OTHER)]))


def test_name_only_target_acquires_id_for_gsi_but_idless_demo_is_rejected():
    result = obs_targets.resolve_obs_targets("demo.dem", [target(steamid64="")], parser=parser([row(1000)]))
    assert result[0]["steamid64"] == SID
    with pytest.raises(ValueError, match="SteamID"):
        obs_targets.resolve_obs_targets("demo.dem", [target(steamid64="")], parser=parser([row(1000, sid="0")]))


@pytest.mark.parametrize("preroll", [row(680, alive=False), row(680, slot=9), row(680, sid=OTHER)])
def test_dead_missing_or_reconnected_preroll_prepares_at_verified_start(preroll):
    result = obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser([preroll, row(1000)]))
    assert result[0]["seek_tick"] == 1000
    assert result[0]["slot"] == 11


@pytest.mark.parametrize("tick", [680, 1000, 1150])
def test_bot_takeover_is_explicitly_blocked_instead_of_using_an_unverified_body(tick):
    bot = row(tick, **{"CCSPlayerController.m_bControllingBot": True})
    with pytest.raises(ValueError, match="BOT"):
        obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser([row(680), row(1000)], [bot]))


def test_other_players_bot_takeover_does_not_block_target():
    bot = row(1150, sid=OTHER, **{"CCSPlayerController.m_bControllingBot": True})
    assert obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser([row(680), row(1000)], [bot]))[0]["slot"] == 11


def test_preparation_tick_honors_planner_or_default_five_seconds():
    segment = plan().segments[0]
    assert obs_targets.obs_prepare_tick(segment, 64) == 680
    segment.safe_seek_tick = 1000
    assert obs_targets.obs_prepare_tick(segment, 64) == 680
    segment.safe_seek_tick = 400
    assert obs_targets.obs_prepare_tick(segment, 64) == 400


def test_worker_dispatch_and_result_validation(monkeypatch):
    from app import demo_parse_isolation, parse_worker
    resolve = Mock(return_value=[{"slot": 11}])
    monkeypatch.setattr(obs_targets, "resolve_obs_targets", resolve)
    targets = [target()]
    assert parse_worker._run({"action": "obs_targets", "dem_path": "playback.dem", "targets": targets}) == [{"slot": 11}]
    resolve.assert_called_once_with("playback.dem", targets)
    monkeypatch.setattr(demo_parse_isolation, "run_parse_worker", Mock(return_value={}))
    with pytest.raises(demo_parse_isolation.IsolatedParseError):
        demo_parse_isolation.resolve_obs_targets_isolated("demo.dem", targets)


@pytest.mark.parametrize("failure", [False, True])
def test_queue_resolves_before_launch_and_never_launches_on_resolution_failure(monkeypatch, tmp_path, failure):
    from app import demo_parse_isolation, pov_hud_manager
    from app.env_utils import OBSConfig
    from app.obs_director import OBSDirector, RecordingWarmupExtras
    from app.recording.executor import obs_recording_controller

    events = []
    original = plan(raw_slot=12)
    monkeypatch.setattr(plan_builder, "build_plan", lambda _: original)
    def install(**kwargs):
        events.append("install")
    monkeypatch.setattr(pov_hud_manager, "PovHudManager", lambda _: SimpleNamespace(
        status=lambda: {"original_gameinfo_sha256": "a" * 64}, install=install,
    ))
    monkeypatch.setattr(pov_hud_manager, "restore_pov_after_cs2_exit", lambda *_a, **_kw: {"verified": True})
    monkeypatch.setattr(obs_recording_controller, "OBSRecordingController",
                        lambda *_: SimpleNamespace(force_stop_recording=AsyncMock(return_value=True)))

    def resolve(path, targets):
        events.append("resolve")
        assert path == str(tmp_path / "playback.dem")
        assert targets[0]["steamid64"] == SID
        if failure:
            raise ValueError("unverified target")
        return [{"slot": 11, "pawn": 2819, "steamid64": SID, "seek_tick": 680}]

    monkeypatch.setattr(demo_parse_isolation, "resolve_obs_targets_isolated", resolve)
    director = OBSDirector(OBSConfig(), "")
    monkeypatch.setattr(director, "_game_root_from_cs2_exe", lambda _: tmp_path / "game")

    def launch(*args, **kwargs):
        events.append("launch")
        raise RuntimeError("stop before opening a game")

    monkeypatch.setattr(director, "_launch_cs2", launch)
    monkeypatch.setattr(director, "_kill_cs2", lambda: None)
    monkeypatch.setattr(director, "_cleanup_cs2_artifacts", lambda: None)
    dto = SimpleNamespace(request_id="test", demo=SimpleNamespace(
        demo_path=str(tmp_path / "playback.dem"), demo_filename="pvp.dem"))
    results = asyncio.run(director.execute_plan_queue([dto], warmup=RecordingWarmupExtras(
        pov_hud_enabled=False, recording_hud_enabled=False, input_hud_enabled=False, pov_voice_mode="mute",
    )))
    assert events == (["resolve"] if failure else ["resolve", "launch"])
    assert results[0]["success"] is False
    assert original.segments[0].target_spec_slot == 12
