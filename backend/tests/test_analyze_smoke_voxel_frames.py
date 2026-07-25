from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "analyze_smoke_voxel_frames.py"
_spec = importlib.util.spec_from_file_location("analyze_smoke_voxel_frames", _SCRIPT)
analyze = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(analyze)


class TestShannonEntropy:
    def test_empty(self):
        assert analyze.shannon_entropy(b"") == 0.0

    def test_uniform_single_byte(self):
        assert analyze.shannon_entropy(b"\x00" * 100) == 0.0

    def test_two_symbols_positive(self):
        assert analyze.shannon_entropy(b"\x00\xff" * 50) > 0.9


class TestSummarizeFrame:
    def test_declared_match(self):
        data = b"\x01\x02\x03\x04"
        out = analyze.summarize_frame(data, declared_size=4)
        assert out["length"] == 4
        assert out["declared_matches_length"] is True
        assert out["unique_bytes"] == 4

    def test_declared_mismatch(self):
        out = analyze.summarize_frame(b"\x00" * 3072, declared_size=804)
        assert out["declared_matches_length"] is False
        assert out["header_hints"]["possible_fixed_capacity"] is True


class TestAnalyzeEntitySeries:
    def test_adjacent_diffs_and_lengths(self):
        rows = [
            {"tick": 1, "voxel_update": 0, "declared_size": 2, "data": b"\x00\x00"},
            {"tick": 2, "voxel_update": 1, "declared_size": 2, "data": b"\x00\x01"},
            {"tick": 3, "voxel_update": 2, "declared_size": 3, "data": b"\x00\x01\x02"},
        ]
        out = analyze.analyze_entity_series(rows)
        assert out["frame_count"] == 3
        assert out["length_unique"] == [2, 3]
        assert out["adjacent_diffs"][0]["changed_bytes"] == 1
        assert out["adjacent_diffs"][0]["update_changed"] is True


class TestCountDiffs:
    def test_incomparable(self):
        assert analyze.count_diffs(None, b"\x00")["comparable"] is False

    def test_len_delta(self):
        out = analyze.count_diffs(b"\x00\x00", b"\x00\x00\x01")
        assert out["changed_bytes"] == 0
        assert out["len_delta"] == 1
