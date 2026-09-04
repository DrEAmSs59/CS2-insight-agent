# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import player_aliases as aliases
from app.features.demo_playback.api import DemoPlaybackOptionsBody
from app.recording import player_aliases as recording
from app.recording.models import RecordingRequestDTO

SID = "76561199032006224"
SID2 = "76561198187322794"


@pytest.mark.parametrize("name", ["京介 🦋", "Умри", '<a>&"', " a b ", "🦋" * 16, "x" * 32])
def test_unicode_and_spacing_are_preserved(name):
    assert DemoPlaybackOptionsBody(player_aliases={SID: name, SID2: name}).player_aliases == {SID: name, SID2: name}


@pytest.mark.parametrize("name", ["x\ny", "x\x00y", "a\ud800b", "x" * 33, "🦋" * 17, 42])
def test_invalid_names_are_rejected(name):
    with pytest.raises(ValidationError):
        DemoPlaybackOptionsBody(player_aliases={SID: name})


@pytest.mark.parametrize("sid", ["0", "01", "-1", "1e17", str(2**64)])
def test_ids_cannot_be_floats_or_noncanonical(sid):
    with pytest.raises(ValidationError):
        DemoPlaybackOptionsBody(player_aliases={sid: "name"})


def test_blank_means_original_and_defaults_off():
    assert DemoPlaybackOptionsBody().player_aliases == {}
    assert DemoPlaybackOptionsBody(player_aliases={SID: "  "}).player_aliases == {}


@pytest.mark.parametrize("fault", [None, "identity", "name", "exit"])
def test_copy_is_validated_and_failed_output_removed(monkeypatch, tmp_path, fault):
    source, output = tmp_path / "source.dem", tmp_path / "new.dem"
    source.write_bytes(b"original")
    before = [{"steamid64": SID, "name": "old", "team_number": 2}]
    after = [{**before[0], "name": "京介"}]
    if fault == "identity":
        after[0]["steamid64"] = SID2
    if fault == "name":
        after[0]["name"] = "old"
    monkeypatch.setattr(aliases, "player_alias_roster", lambda path: before if Path(path) == source else after)
    monkeypatch.setattr(aliases, "resolve_alias_rewriter", lambda: Path("rewriter.exe"))
    def run(args, **kwargs):
        assert json.loads(Path(args[-1]).read_text(encoding="utf-8")) == {SID: "京介"}
        assert args[2] == str(source)
        output.write_bytes(b"rewritten")
        return SimpleNamespace(returncode=1 if fault == "exit" else 0, stderr="failed")
    monkeypatch.setattr(aliases.subprocess, "run", run)
    if fault:
        with pytest.raises(aliases.PlayerAliasError):
            aliases.create_player_alias_copy(source, output, {SID: "京介"})
        assert not output.exists()
    else:
        assert aliases.create_player_alias_copy(source, output, {SID: "京介"}) == output
    assert source.read_bytes() == b"original"
    assert not list(tmp_path.glob("alias-config-*"))


def test_refuses_overwrite_and_unknown_target(monkeypatch, tmp_path):
    source = tmp_path / "source.dem"
    source.write_bytes(b"original")
    with pytest.raises(aliases.PlayerAliasError):
        aliases.create_player_alias_copy(source, source, {SID: "name"})
    monkeypatch.setattr(aliases, "player_alias_roster", lambda _: [])
    with pytest.raises(aliases.PlayerAliasError):
        aliases.create_player_alias_copy(source, tmp_path / "new.dem", {SID: "name"})
    assert source.read_bytes() == b"original"


def request(path, names):
    player = {"name": "old", "steamid64": SID, "spec_slot": 4}
    other = {"name": "other", "steamid64": SID2, "spec_slot": 7}
    return RecordingRequestDTO.model_validate({
        "request_id": "test", "request_type": "highlight", "source_type": "kill",
        "demo": {"demo_path": str(path), "demo_filename": "match.dem", "map_name": "de_mirage", "tick_rate": 64,
                 "first_tick": 0, "demo_end_tick": 10000, "final_round": 1, "final_round_start_tick": 0,
                 "final_round_end_tick": 10000, "all_players": [player, other]},
        "target_player": player, "player_aliases": names,
        "events": [{"event_type": "kill", "tick": 800, "round": 1, "killer": player,
                    "victim": other, "target_player": player, "perspective": "killer"}],
    })


def test_queue_copies_once_per_demo_preserving_identity(monkeypatch, tmp_path):
    calls, repairs = [], []
    def create(source, output, names):
        calls.append((source, names))
        output.write_bytes(b"copy")
        return output
    monkeypatch.setattr(recording, "create_player_alias_copy", create)
    monkeypatch.setattr(recording, "ensure_demo_compatible", lambda path: repairs.append(path))
    first = request(tmp_path / "one.dem", {SID: "同名", SID2: "同名"})
    second = request(tmp_path / "two.dem", {SID: "第二场"})
    disabled = request(tmp_path / "three.dem", {})
    original = first.model_dump()
    result = recording.prepare_recording_aliases([first, first, second, disabled], tmp_path)
    assert len(calls) == len(repairs) == 2
    assert result[0].demo.demo_path == result[1].demo.demo_path != result[2].demo.demo_path
    assert result[3] is disabled
    assert result[0].target_player.name == result[0].events[0].victim.name == "同名"
    assert result[0].target_player.steamid64 == SID and result[0].target_player.spec_slot == 4
    assert result[0].events[0].victim.steamid64 == SID2
    assert result[0].demo.all_players[1]["name"] == "同名"
    assert first.model_dump() == original


def test_queue_rejects_conflicting_maps_before_writing(tmp_path):
    first = request(tmp_path / "one.dem", {SID: "a"})
    second = request(tmp_path / "one.dem", {SID: "b"})
    with pytest.raises(aliases.PlayerAliasError):
        recording.prepare_recording_aliases([first, second], tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("fail", [False, True])
def test_recording_api_keeps_copy_alive_through_director_then_cleans(monkeypatch, tmp_path, fail):
    import asyncio
    from unittest.mock import AsyncMock, Mock
    from fastapi import HTTPException
    from app import cs2_config_backup, obs_director
    from app.env_utils import AppConfig
    from app.recording import api

    source = tmp_path / "match.dem"
    source.write_bytes(b"original")
    dto = request(source, {SID: "京介"})
    dto.options.kill_fx_enabled = False
    cfg = AppConfig(cs2_path=str(tmp_path / "never-launch.exe"))
    monkeypatch.setattr(api, "load_config", lambda: cfg)
    monkeypatch.setattr(api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(cs2_config_backup, "is_cs2_running", lambda: False)
    monkeypatch.setattr(cs2_config_backup, "is_restore_required", lambda: False)
    monkeypatch.setattr(api, "OBSClient", Mock(return_value=Mock()))
    monkeypatch.setattr(api, "OBSFadeController", Mock(return_value=Mock(setup=AsyncMock(return_value=True))))
    monkeypatch.setattr(api, "resolve_working_demo_path", AsyncMock(return_value=source))
    monkeypatch.setattr(api, "_persist_v3_results", AsyncMock())
    monkeypatch.setattr(api, "_queue_abort_event", None)
    monkeypatch.setattr(api, "ensure_demo_compatible", lambda path: pytest.fail("original must not be repaired"))
    def copy(src, output, names):
        assert Path(src) == source
        output.write_bytes(b"alias")
        return output
    monkeypatch.setattr(recording, "create_player_alias_copy", copy)
    monkeypatch.setattr(recording, "ensure_demo_compatible", lambda path: None)
    observed = []
    async def execute(requests, **kwargs):
        path = Path(requests[0].demo.demo_path)
        assert path.read_bytes() == b"alias"
        assert requests[0].target_player.name == "京介"
        assert not getattr(kwargs["warmup"], "pov_hud_enabled", False)
        observed.append(path)
        if fail:
            raise RuntimeError("recording failed")
        return []
    monkeypatch.setattr(obs_director, "OBSDirector", Mock(return_value=Mock(execute_plan_queue=execute)))
    body = api.QueueRecordingRequest(requests=[dto], pov_hud={"enabled": False})
    if fail:
        with pytest.raises(HTTPException):
            asyncio.run(api.execute_recording_queue(body))
    else:
        assert asyncio.run(api.execute_recording_queue(body)) == []
    assert observed and not observed[0].exists()
    assert source.read_bytes() == b"original"
    assert api._queue_abort_event is None
