import json

from app import file_quarantine


def test_quarantine_writes_manifest_and_can_restore(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    first = source_dir / "match.dem"
    second = source_dir / "match.zip"
    first.write_bytes(b"demo")
    second.write_bytes(b"zip")
    monkeypatch.setattr(file_quarantine, "get_data_dir", lambda: data_dir)

    batch = file_quarantine.quarantine_files(
        [first, first, second, source_dir / "missing.dem"],
        "demos",
    )

    assert not first.exists()
    assert not second.exists()
    assert len(batch.files) == 2
    manifest = json.loads((batch.directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["namespace"] == "demos"
    assert {item["original"] for item in manifest["files"]} == {str(first), str(second)}

    batch.restore()

    assert first.read_bytes() == b"demo"
    assert second.read_bytes() == b"zip"


def test_empty_quarantine_does_not_create_directory(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    monkeypatch.setattr(file_quarantine, "get_data_dir", lambda: data_dir)

    batch = file_quarantine.quarantine_files([tmp_path / "missing.dem"], "demos")

    assert batch.files == []
    assert not batch.directory.exists()
