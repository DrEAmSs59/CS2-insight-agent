from pathlib import Path

import pytest

from app.posthumous_kills import classify_posthumous_kills, annotate_analysis_clips
from app.features.demo_analysis.models import Clip
from app.recording.models import RecordingRequestDTO
from app.recording.plan_builder import build_plan
from app.recording.obs_targets import prepare_obs_plan_targets

SID = "76561199134553751"
VICTIM = "76561199090191861"


@pytest.mark.parametrize("weapon", ["inferno", "hegrenade", "flashbang", "smokegrenade", "decoy", "molotov", "unknown_projectile"])
def test_any_weapon_kill_after_death_is_marked(weapon):
    rows = [{"tick": 100, "user_steamid": SID, "attacker_steamid": VICTIM},
            {"tick": 200, "user_steamid": VICTIM, "attacker_steamid": SID, "weapon": weapon}]
    marked = classify_posthumous_kills(rows, [])
    assert marked[(SID, 200)]["attacker_death_tick"] == 100
    assert marked[(SID, 200)]["weapon"] == weapon


def test_respawn_renames_and_same_tick_trade():
    deaths = [{"tick": 100, "user_steamid": SID},
              {"tick": 100, "attacker_steamid": SID},
              {"tick": 110, "attacker_steamid": SID, "attacker_name": "renamed"},
              {"tick": 200, "attacker_steamid": SID}]
    assert set(classify_posthumous_kills(deaths, [{"tick":150,"user_steamid":SID}])) == {(SID,110)}
    assert classify_posthumous_kills([{"tick":100,"user_name":"same"},
                                      {"tick":200,"attacker_name":"same"}], []) == {}


def request(path, kind="highlight", mode="skip", ticks=(79600, 80077)):
    player = {"name":"C411M3RikkL", "steamid64":SID}
    victim = {"name":"sh0rl", "steamid64":VICTIM}
    return RecordingRequestDTO.model_validate({
        "request_id":"post-test", "request_type":kind, "source_type":"kill",
        "demo":{"demo_path":str(path),"demo_filename":"test.dem","map_name":"de_dust2","tick_rate":64,
                "first_tick":0,"demo_end_tick":100000,"final_round":24,"final_round_start_tick":0,"final_round_end_tick":0},
        "target_player":player,
        "events":[{"event_type":"kill","tick":tick,"round":16,"killer":player,"victim":victim,
                   "target_player":player,"perspective":"killer"} for tick in ticks],
        "options":{"posthumous_mode":mode},
    })


@pytest.fixture
def source(tmp_path, monkeypatch):
    path = tmp_path / "test.dem"
    path.write_bytes(b"stub")
    monkeypatch.setattr("app.recording.normalizer.read_demo_end_tick", lambda _:100000)
    monkeypatch.setattr("app.posthumous_kills.read_posthumous_kills_isolated", lambda _: {
        (SID,80077):{"attacker_death_tick":79743,"victim_name":"sh0rl","victim_steamid":VICTIM}})
    return path


@pytest.mark.parametrize("kind", ["highlight","timeline_kill","kill_compilation"])
def test_mixed_clips_keep_normal_kill_and_skip_dead_killer(source, kind):
    plan = build_plan(request(source,kind))
    assert len(plan.segments) == 1
    assert plan.segments[0].anchor_ticks == [79600]
    assert plan.segments[0].end_tick <= 79743
    assert "死后击杀" in plan.warnings[0]


@pytest.mark.parametrize("kind", ["highlight","timeline_kill","kill_compilation"])
def test_victim_choice_is_separate_and_no_killer_copy(source, kind):
    plan = build_plan(request(source,kind,"victim"))
    victim = [s for s in plan.segments if s.metadata.get("posthumous_kill")]
    assert len(victim) == 1
    assert victim[0].target_steamid64 == VICTIM
    assert victim[0].perspective == "victim"
    assert victim[0].anchor_ticks == [80077]
    assert all(80077 not in s.anchor_ticks for s in plan.segments if s.perspective == "killer")


def test_only_posthumous_produces_empty_skipped_plan(source):
    assert not build_plan(request(source,ticks=(80077,))).segments


def test_posthumous_victim_does_not_append_replays_from_old_queue_options(source):
    dto = request(source,mode="victim",ticks=(80077,))
    dto.options.enable_victim_pov = True
    dto.options.enable_fail_killer_pov = True
    dto.options.interleave_pov_pairs = True
    plan = build_plan(dto)
    assert len(plan.segments) == 1
    assert plan.segments[0].perspective == "victim"
    assert plan.segments[0].target_steamid64 == VICTIM


@pytest.mark.parametrize("mode", ["skip", "victim"])
@pytest.mark.parametrize("interleaved", [False, True])
def test_all_kills_replay_only_applies_to_normal_kills(source, mode, interleaved):
    dto = request(source,kind="kill_compilation",mode=mode)
    dto.options.enable_victim_pov = True
    dto.options.interleave_pov_pairs = interleaved
    plan = build_plan(dto)
    ordinary = [s for s in plan.segments if 79600 in s.anchor_ticks]
    special = [s for s in plan.segments if 80077 in s.anchor_ticks]
    assert {s.perspective for s in ordinary} == {"killer", "victim"}
    assert len(special) == (1 if mode == "victim" else 0)
    assert all(s.perspective == "victim" and s.metadata.get("posthumous_kill") for s in special)


def test_multiple_posthumous_victims_use_authoritative_demo_identity(source, monkeypatch):
    other = "76561199428419002"
    monkeypatch.setattr("app.posthumous_kills.read_posthumous_kills_isolated", lambda _: {
        (SID,80077):{"attacker_death_tick":79743,"victim_name":"first","victim_steamid":VICTIM},
        (SID,80100):{"attacker_death_tick":79743,"victim_name":"second","victim_steamid":other},
    })
    plan = build_plan(request(source,mode="victim",ticks=(80077,80100)))
    assert [s.target_steamid64 for s in plan.segments] == [VICTIM,other]


def test_same_tick_grenade_multikill_preserves_each_victim(source, monkeypatch):
    other = "76561199428419002"
    facts = classify_posthumous_kills([
        {"tick":79743,"user_steamid":SID},
        *[{"tick":80077,"attacker_steamid":SID,"user_steamid":sid,"user_name":sid,"weapon":"hegrenade"}
          for sid in (VICTIM,other)],
    ], [])
    clips = annotate_analysis_clips([],facts,SID,map_name="de_dust2")
    assert len(clips) == 2
    assert len({clip.clip_id for clip in clips}) == 2
    assert {clip.victim_steamid64s[0] for clip in clips} == {VICTIM,other}
    monkeypatch.setattr("app.posthumous_kills.read_posthumous_kills_isolated",lambda _:facts)
    dto = request(source,mode="victim",ticks=(80077,80077))
    dto.events[1].victim.steamid64 = other
    plan = build_plan(dto)
    assert [s.target_steamid64 for s in plan.segments] == [VICTIM,other]


def test_unavailable_victim_does_not_cancel_normal_segment(source):
    plan = build_plan(request(source,mode="victim"))
    def resolve(path, targets):
        if targets[0]["steamid64"] == VICTIM:
            raise ValueError("unavailable victim")
        return [{"slot":7,"pawn":1332,"steamid64":SID,"seek_tick":t["seek_tick"]} for t in targets]
    prepared = prepare_obs_plan_targets([plan],Path(source),resolver=resolve)[0]
    assert len([s for s in prepared.segments if not s.disabled]) == 1
    assert any("无法核验" in w for w in prepared.warnings)
    assert all(not s.disabled for s in plan.segments)


@pytest.mark.parametrize("kind", ["round_compilation", "timeline_round"])
def test_whole_round_recording_never_reads_posthumous_events(source, monkeypatch, kind):
    dto = request(source,kind)
    dto.events = []
    from app.recording.models import RoundInfo
    dto.rounds = [RoundInfo(round=16, round_start_tick=78000,freeze_end_tick=78500,
                           round_end_tick=79743,target_death_tick=79743,next_round_start_tick=80191)]
    monkeypatch.setattr("app.posthumous_kills.read_posthumous_kills_isolated", lambda _:pytest.fail("round POV must not scan kills"))
    plan = build_plan(dto)
    assert len(plan.segments) == 1
    assert plan.segments[0].end_tick <= 79743 + 128
    assert plan.segments[0].target_steamid64 == SID


def test_analysis_splits_parallel_arrays_without_deleting_kill_from_compilation():
    row = {"tick":200,"attacker_death_tick":150,"victim_name":"victim2","victim_steamid":"v2","weapon":"smokegrenade"}
    clip = Clip(clip_id="mixed",round=1,category="highlight",weapon_used="AK / Smoke",kill_count=2,
                start_tick=50,end_tick=300,kill_ticks=[100,200],victims=["victim1","victim2"],
                victim_steamid64s=["v1","v2"],context_tags=["双杀"])
    result = annotate_analysis_clips([clip],{(SID,200):row},SID,map_name="de_dust2")
    assert [c.kill_count for c in result] == [1,1]
    ordinary = next(c for c in result if not c.posthumous_kills)
    special = next(c for c in result if c.posthumous_kills)
    assert ordinary.victim_steamid64s == ["v1"]
    assert special.victim_steamid64s == ["v2"]
    assert ordinary.end_tick == 150
    assert clip.kill_ticks == [100,200]
