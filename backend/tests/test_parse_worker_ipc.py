from pathlib import Path

from app.parse_worker_ipc import dump_message, load_message


def test_dump_and_load_roundtrip_pickle(tmp_path: Path):
    path = tmp_path / "payload.pkl"
    payload = {"ok": True, "result": {"clips": [{"id": "a"}], "n": 1}}
    dump_message(path, payload)
    assert load_message(path) == payload


def test_load_message_still_accepts_json(tmp_path: Path):
    path = tmp_path / "payload.json"
    path.write_text('{"ok": true, "error": null}', encoding="utf-8")
    assert load_message(path) == {"ok": True, "error": None}
