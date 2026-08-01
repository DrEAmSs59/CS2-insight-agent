from __future__ import annotations

import pytest

from app import demoparser_runtime


def test_required_patched_runtime_is_ready(monkeypatch):
    import demoparser2

    class CompleteParser:
        decode_smoke_voxel_journal = staticmethod(lambda: None)
        write_replay_parquet = staticmethod(lambda: None)
        read_replay_parquet_round = staticmethod(lambda: None)
        read_replay_parquet_round_binary = staticmethod(lambda: None)

    monkeypatch.setattr(
        demoparser_runtime.metadata,
        "version",
        lambda _name: demoparser_runtime.REQUIRED_DEMOPARSER_VERSION,
    )
    monkeypatch.setattr(demoparser2, "DemoParser", CompleteParser)

    report = demoparser_runtime.require_demoparser_runtime()

    assert report["ready"] is True
    assert report["missing_methods"] == []


def test_stock_runtime_fails_with_setup_command(monkeypatch):
    import demoparser2

    class StockParser:
        pass

    monkeypatch.setattr(demoparser_runtime.metadata, "version", lambda _name: "0.41.4")
    monkeypatch.setattr(demoparser2, "DemoParser", StockParser)

    with pytest.raises(RuntimeError) as error:
        demoparser_runtime.require_demoparser_runtime()

    message = str(error.value)
    assert "0.41.4+cs2insight8" in message
    assert "write_replay_parquet" in message
    assert "setup-backend-dev.ps1" in message
