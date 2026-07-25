from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path

import pandas as pd

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "probe_replay_dynamic_effects.py"
_spec = importlib.util.spec_from_file_location("probe_replay_dynamic_effects", _SCRIPT)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)


class TestToBytesOrNone:
    def test_bytes_passthrough(self):
        assert probe.to_bytes_or_none(b"\x00\x01\xff") == b"\x00\x01\xff"

    def test_bytearray_and_memoryview(self):
        assert probe.to_bytes_or_none(bytearray([1, 2])) == b"\x01\x02"
        assert probe.to_bytes_or_none(memoryview(b"\xab")) == b"\xab"

    def test_list_of_ints(self):
        assert probe.to_bytes_or_none([0, 1, 255]) == b"\x00\x01\xff"

    def test_empty_list_is_empty_bytes_not_none(self):
        # 保留「空数组」与「缺失」的区别
        assert probe.to_bytes_or_none([]) == b""
        assert probe.to_bytes_or_none(None) is None

    def test_nan_is_none(self):
        assert probe.to_bytes_or_none(float("nan")) is None

    def test_out_of_range_or_non_int_rejected(self):
        assert probe.to_bytes_or_none([0, 256]) is None
        assert probe.to_bytes_or_none([-1]) is None
        assert probe.to_bytes_or_none([1.5]) is None
        assert probe.to_bytes_or_none("abc") is None
        assert probe.to_bytes_or_none([True]) is None

    def test_numpy_like_array_via_tolist(self):
        import numpy as np

        assert probe.to_bytes_or_none(np.array([7, 8], dtype=np.uint8)) == b"\x07\x08"


class TestSummarizeBinaryValue:
    def test_bytes_summary(self):
        payload = bytes(i % 256 for i in range(300))
        out = probe.summarize_binary_value(payload)
        assert out["kind"] == "bytes"
        assert out["length"] == 300
        assert out["sha256"] == hashlib.sha256(payload).hexdigest()
        # 前缀只保留 256 字节
        assert out["prefix_hex"] == payload[:256].hex()

    def test_missing_and_nan(self):
        assert probe.summarize_binary_value(None)["kind"] == "missing"
        assert probe.summarize_binary_value(float("nan"))["kind"] == "nan"

    def test_unconvertible_keeps_repr_head_only(self):
        out = probe.summarize_binary_value({"not": "binary"})
        assert out["kind"].startswith("unconvertible:")
        assert out["sha256"] is None
        assert len(out["repr_head"]) <= 200

    def test_prefix_bytes_configurable(self):
        out = probe.summarize_binary_value(b"\x01\x02\x03\x04", prefix_bytes=2)
        assert out["prefix_hex"] == "0102"


class TestJsonSafe:
    def test_output_is_json_serializable(self):
        import numpy as np

        blob = {
            "a": np.int64(3),
            "b": np.float32(1.5),
            "c": float("nan"),
            "d": b"\x00\xff",
            "e": [np.uint8(1), (2, 3)],
            "f": {1: "x"},
        }
        out = probe.json_safe(blob)
        text = json.dumps(out)
        assert "NaN" not in text
        assert out["a"] == 3
        assert out["c"] is None
        assert out["d"]["kind"] == "bytes"
        assert out["f"]["1"] == "x"

    def test_no_raw_bytes_leak(self):
        out = probe.json_safe([b"\x01" * 1024])
        assert out[0]["length"] == 1024
        assert len(out[0]["prefix_hex"]) == 256 * 2


class TestDescribeDataframe:
    def test_normal_frame(self):
        frame = pd.DataFrame({"tick": [1, 2], "value": [0.5, float("nan")]})
        info = probe.describe_dataframe(frame)
        assert info["present"] is True
        assert info["rows"] == 2
        assert info["columns"] == ["tick", "value"]
        assert "tick" in info["dtypes"]
        json.dumps(info)

    def test_none_and_unexpected(self):
        assert probe.describe_dataframe(None)["present"] is False
        assert probe.describe_dataframe(object())["present"] is False


class TestDeriveProbeWindow:
    def test_cli_wins(self):
        lo, hi, source = probe.derive_probe_window({}, 100, 200, 64)
        assert (lo, hi, source) == (100, 200, "cli")

    def test_derived_from_events(self):
        events = {
            "smokegrenade_detonate": {"tick_samples": [{"tick": 1000}, {"tick": 5000}]},
            "inferno_startburn": {"tick_samples": [{"tick": 3000}]},
        }
        lo, hi, source = probe.derive_probe_window(events, None, None, 64)
        assert source == "derived_from_events"
        assert lo <= 1000 and hi >= 5000

    def test_no_events(self):
        lo, hi, source = probe.derive_probe_window({}, None, None, 64)
        assert source == "no_utility_events"


class TestAnalyzeVoxelRecords:
    @staticmethod
    def _row(tick, entity, update, payload: bytes, declared=None):
        return {
            "tick": tick,
            "entity_id": entity,
            "voxel_update": update,
            "declared_size": declared if declared is not None else len(payload),
            "data": probe.summarize_binary_value(payload),
        }

    def test_update_change_tracked_with_hash_change(self):
        rows = [
            self._row(100, 1, 1, b"\x01\x02"),
            self._row(200, 1, 2, b"\x03\x04"),
            self._row(300, 1, 2, b"\x03\x04"),
        ]
        out = probe.analyze_voxel_records(rows)
        assert out["update_change_with_hash_change"] == 1
        assert out["hash_change_without_update_change"] == 0
        entity = out["entities"]["1"]
        assert entity["samples"] == 3
        assert entity["distinct_hashes"] == 2
        assert entity["declared_size_matches_actual"] is True

    def test_hash_change_without_update_change_flagged(self):
        rows = [
            self._row(100, 1, 5, b"\x01"),
            self._row(200, 1, 5, b"\x02"),
        ]
        out = probe.analyze_voxel_records(rows)
        assert out["hash_change_without_update_change"] == 1

    def test_declared_size_mismatch(self):
        rows = [self._row(100, 2, 1, b"\x01\x02", declared=999)]
        out = probe.analyze_voxel_records(rows)
        assert out["entities"]["2"]["declared_size_matches_actual"] is False

    def test_entities_separated(self):
        rows = [
            self._row(100, 1, 1, b"\x01"),
            self._row(100, 2, 1, b"\x02"),
        ]
        out = probe.analyze_voxel_records(rows)
        assert set(out["entities"]) == {"1", "2"}
        assert out["update_change_with_hash_change"] == 0


class TestAnalyzeVoxelMetadata:
    @staticmethod
    def _row(tick, entity, update, size):
        return {"entity_id": entity, "tick": tick, "voxel_update": update, "declared_size": size}

    def test_update_transitions_counted(self):
        records = [
            self._row(100, 1, 0, 0),
            self._row(107, 1, 1, 804),
            self._row(114, 1, 2, 811),
            self._row(121, 1, 2, 811),
            self._row(128, 1, 3, 811),  # update 变化但 size 未变
        ]
        out = probe.analyze_voxel_metadata(records)
        assert out["update_transitions_with_size_change"] == 2
        assert out["update_transitions_without_size_change"] == 1
        entity = out["entities"]["1"]
        assert entity["samples"] == 5
        assert entity["update_range"] == [0, 3]
        assert entity["size_range"] == [0, 811]
        assert entity["distinct_updates"] == 4

    def test_entities_independent(self):
        records = [
            self._row(100, 1, 0, 0),
            self._row(100, 2, 5, 900),
        ]
        out = probe.analyze_voxel_metadata(records)
        assert set(out["entities"]) == {"1", "2"}
        assert out["update_transitions_with_size_change"] == 0

    def test_missing_values_tolerated(self):
        records = [
            self._row(100, 1, None, None),
            self._row(107, 1, 1, 804),
        ]
        out = probe.analyze_voxel_metadata(records)
        assert out["entities"]["1"]["update_range"] == [1, 1]
        json.dumps(out)


class TestDecisions:
    def test_smoke_parser_export_required_when_stream_has_fields(self):
        field_scan = {"matches": {"voxel": ["Grenade.m_VoxelFrameData"]}}
        grenade_props = {"props": {"m_VoxelFrameData": {"exported": False}}}
        out = probe.decide_smoke_status(field_scan, grenade_props)
        assert out["status"] == "PARSER_EXPORT_REQUIRED"

    def test_smoke_export_required_when_bytes_collapsed_to_scalar(self):
        # 实测：lean fork 会导出 m_VoxelFrameData 列，但值坍缩成单个 float，不是数组
        field_scan = {"matches": {"voxel": ["Grenade.m_VoxelFrameData", "Grenade.m_nVoxelUpdate"]}}
        grenade_props = {
            "props": {
                "m_VoxelFrameData": {"exported": True, "non_null_rows": 1000, "array_like": False},
                "m_nVoxelUpdate": {"exported": True, "non_null_rows": 1000},
            }
        }
        out = probe.decide_smoke_status(field_scan, grenade_props)
        assert out["status"] == "PARSER_EXPORT_REQUIRED"
        assert out["voxel_bytes_readable_via_python_api"] is False
        assert out["voxel_metadata_readable_via_python_api"] is True

    def test_smoke_insufficient_when_stream_empty(self):
        out = probe.decide_smoke_status({"matches": {"voxel": []}}, {"props": {}})
        assert out["status"] == "DEMO_DATA_INSUFFICIENT"

    def test_smoke_format_research_when_bytes_readable(self):
        field_scan = {"matches": {"voxel": ["Grenade.m_VoxelFrameData"]}}
        grenade_props = {
            "props": {"m_VoxelFrameData": {"exported": True, "non_null_rows": 4, "array_like": True}}
        }
        out = probe.decide_smoke_status(field_scan, grenade_props)
        assert out["status"] == "FORMAT_RESEARCH_REQUIRED"

    def test_inferno_ready_when_positions_readable_as_array(self):
        field_scan = {"matches": {"inferno_or_fire": ["Grenade.m_firePositions"]}}
        grenade_props = {
            "props": {"m_firePositions": {"exported": True, "non_null_rows": 12, "array_like": True}}
        }
        out = probe.decide_inferno_status(field_scan, grenade_props)
        assert out["status"] == "INFERNO_CELLS_READY"

    def test_inferno_export_required_when_column_missing(self):
        field_scan = {"matches": {"inferno_or_fire": ["Grenade.m_firePositions", "Grenade.m_fireCount"]}}
        grenade_props = {"props": {"m_firePositions": {"exported": False}}}
        out = probe.decide_inferno_status(field_scan, grenade_props)
        assert out["status"] == "PARSER_ENTITY_EXPORT_REQUIRED"

    def test_inferno_insufficient(self):
        out = probe.decide_inferno_status({"matches": {"inferno_or_fire": []}}, {"props": {}})
        assert out["status"] == "DEMO_DATA_INSUFFICIENT"
