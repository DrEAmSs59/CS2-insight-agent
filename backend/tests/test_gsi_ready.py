import logging
from pathlib import Path

from app.gsi_ready import (
    GSIEndpointAccessFilter,
    cleanup_stale_gsi_configs,
    gsi_config_path,
    notify_gsi_payload,
    reset_gsi_ready,
)


def test_ready_log_is_emitted_only_on_state_transition(caplog):
    reset_gsi_ready()
    payload = {"map": {"name": "de_ancient", "phase": "live"}}
    with caplog.at_level(logging.INFO, logger="app.gsi_ready"):
        notify_gsi_payload(payload)
        notify_gsi_payload(payload)
        notify_gsi_payload(payload)
    assert sum("CS2 GSI ready" in row.message for row in caplog.records) == 1


def test_access_filter_hides_only_successful_gsi_posts():
    access_filter = GSIEndpointAccessFilter()
    successful = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "%s", (), None)
    successful.args = ("127.0.0.1:1234", "POST", "/api/gsi/cs2", "1.1", 200)
    failed = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "%s", (), None)
    failed.args = ("127.0.0.1:1234", "POST", "/api/gsi/cs2", "1.1", 500)
    other = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "%s", (), None)
    other.args = ("127.0.0.1:1234", "GET", "/api/health", "1.1", 200)
    assert access_filter.filter(successful) is False
    assert access_filter.filter(failed) is True
    assert access_filter.filter(other) is True


def test_cleanup_removes_only_agent_owned_gsi_configs(tmp_path):
    exe = tmp_path / "game" / "bin" / "win64" / "cs2.exe"
    cfg_dir = tmp_path / "game" / "csgo" / "cfg"
    exe.parent.mkdir(parents=True)
    cfg_dir.mkdir(parents=True)
    exe.touch()
    legacy = cfg_dir / "gamestate_integration__insight_deadbeef.cfg"
    current = gsi_config_path(cfg_dir)
    unrelated = cfg_dir / "gamestate_integration_other_tool.cfg"
    for path in (legacy, current, unrelated):
        path.write_text("test", encoding="utf-8")

    removed = cleanup_stale_gsi_configs(exe)

    assert set(removed) == {legacy, current}
    assert unrelated.exists()
