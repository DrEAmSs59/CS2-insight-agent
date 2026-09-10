from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.env_utils import OBSConfig
from app.obs_legacy_sources import cleanup_legacy_overlay_sources


KEYBOARD = "CS2 Keyboard Overlay"
KILL_FX = "CS2 Kill FX Overlay"


def _source(name, kind="browser_source"):
    return {"inputName": name, "inputKind": kind}


def _ws(inputs, *, failure=None):
    ws = MagicMock()
    ws.inputs = list(inputs)

    def call(request):
        if request.name == "GetInputList":
            return SimpleNamespace(status=True, datain={"inputs": list(ws.inputs)})
        if request.name == "RemoveInput":
            if request.data()["inputName"] == KEYBOARD and failure:
                if failure == "exception":
                    raise RuntimeError("request timed out")
                return SimpleNamespace(status=False, datain={})
            ws.inputs[:] = [
                item for item in ws.inputs
                if item["inputName"] != request.data()["inputName"]
            ]
        return SimpleNamespace(status=True, datain={})

    ws.call.side_effect = call
    return ws


def test_removes_only_retired_browser_sources_and_is_idempotent():
    kept = [
        _source("keyboard"),
        _source("killfx"),
        _source("CS2 Keyboard Overlay Copy"),
        _source("CS2 Insight Game Capture", "game_capture"),
        _source("My Browser"),
    ]
    ws = _ws([_source(KEYBOARD), _source(KILL_FX), *kept])

    cleanup_legacy_overlay_sources(ws)
    assert ws.inputs == kept
    ws.call.reset_mock()
    cleanup_legacy_overlay_sources(ws)
    assert [call.args[0].name for call in ws.call.call_args_list] == ["GetInputList"]


def test_preserves_non_browser_source_with_retired_name():
    ws = _ws([_source(KEYBOARD, "image_source"), _source(KILL_FX, "ffmpeg_source")])
    cleanup_legacy_overlay_sources(ws)
    assert len(ws.inputs) == 2
    ws.call.assert_called_once()


def test_accepts_unversioned_browser_kind():
    ws = _ws([{
        "inputName": KEYBOARD,
        "inputKind": "browser_source_v2",
        "unversionedInputKind": "browser_source",
    }])
    cleanup_legacy_overlay_sources(ws)
    assert ws.inputs == []


@pytest.mark.parametrize("failure", ["exception", "rejected"])
def test_failed_removal_does_not_skip_other_source_and_retries(failure, caplog):
    ws = _ws([_source(KEYBOARD), _source(KILL_FX)], failure=failure)
    cleanup_legacy_overlay_sources(ws)
    assert ws.inputs == [_source(KEYBOARD)]
    assert KEYBOARD in caplog.text
    retry = _ws(ws.inputs)
    cleanup_legacy_overlay_sources(retry)
    assert retry.inputs == []


@pytest.mark.parametrize("failure", ["exception", "rejected"])
def test_failed_lookup_does_not_remove_sources_or_raise(failure, caplog):
    ws = MagicMock()
    if failure == "exception":
        ws.call.side_effect = RuntimeError("request timed out")
    else:
        ws.call.return_value = SimpleNamespace(
            status=False, datain={"inputs": [_source(KEYBOARD)]},
        )
    cleanup_legacy_overlay_sources(ws)
    ws.call.assert_called_once()
    assert caplog.records


@pytest.mark.parametrize("entry", ["recording", "director", "test", "bounded_test", "config"])
@pytest.mark.parametrize("lookup_fails", [False, True])
def test_all_connection_entries_clean_sources_without_breaking_connection(monkeypatch, entry, lookup_fails):
    from app import obs_config_center, obs_director
    from app.recording.executor import obs_client

    ws = _ws([_source(KEYBOARD), _source(KILL_FX)])
    call = ws.call.side_effect

    def checked_call(request):
        ws.connect.assert_called_once()
        if lookup_fails and request.name == "GetInputList":
            raise RuntimeError("lookup failed")
        return call(request)

    ws.call.side_effect = checked_call
    factory = MagicMock(return_value=ws)
    cfg = OBSConfig()
    monkeypatch.setattr(obs_client, "_BoundedHandshakeOBSWS", factory)
    monkeypatch.setattr(obs_director, "obsws", factory)
    monkeypatch.setattr(obs_director, "_ObswsBoundedHandshake", factory)
    monkeypatch.setattr(obs_config_center, "obsws", factory)

    if entry == "recording":
        client = obs_client.OBSClient(cfg)
        client.connect()
        assert client.is_connected()
    elif entry == "config":
        assert obs_config_center._ws_connect(cfg) is ws
    else:
        director = obs_director.OBSDirector(cfg, cs2_path="")
        if entry == "director":
            assert director.connect_obs() is True
        else:
            kwargs = {"handshake_timeout_sec": 1.5} if entry == "bounded_test" else {}
            assert director.test_obs_connection(**kwargs) == {"ok": True}
            ws.disconnect.assert_called_once()

    assert ws.inputs == ([_source(KEYBOARD), _source(KILL_FX)] if lookup_fails else [])
