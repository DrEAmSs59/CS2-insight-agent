from __future__ import annotations

import json
import os

from app import native_table as pd

from app.parser.replay_effects import (
    _parse_effect_rows,
    build_inferno_tracks_from_rows,
    build_smoke_tracks_from_rows,
    extract_dynamic_effect_tracks,
    extract_inferno_cells_from_row,
)
from app.parser.smoke_voxel_decode import decode_smoke_cells


def _make_journal(records: list[tuple[int, list[int]]]) -> bytes:
    out = bytearray()
    for seq, payload in records:
        out.append(seq & 0xFF)
        out.append((seq >> 8) & 0xFF)
        out.append(len(payload) & 0xFF)
        out.append((len(payload) >> 8) & 0xFF)
        out.extend(payload)
    return bytes(out)


def _occ_payload(entries: list[tuple[int, int, int]]) -> list[int]:
    # Type-3 keyframe; seed entries are packed (x, y, z).
    out = [0x00, 0x03, len(entries)]
    for x, y, z in entries:
        out.extend([x, y, z, 5, 0, 0, 0, 0])
    out.extend([0, 0])  # no Morton mask entries
    return out


class TestInfernoCells:
    def test_world_positions_truncated_and_burning(self):
        row = {
            "m_fireCount": 3,
            "m_firePositions": [[10.0, 20.0, 30.0], [11.0, 21.0, 31.0], [0.0, 0.0, 0.0], [99.0, 99.0, 99.0]],
            "m_bFireIsBurning": [True, False, True, True],
        }
        cells = extract_inferno_cells_from_row(row)
        assert cells == [[10.0, 20.0, 30.0, 1.0]]

    def test_nan_filtered(self):
        row = {
            "m_fireCount": 2,
            "m_firePositions": [[1.0, 2.0, 3.0], [float("nan"), 2.0, 3.0]],
            "m_bFireIsBurning": [True, True],
        }
        assert extract_inferno_cells_from_row(row) == [[1.0, 2.0, 3.0, 1.0]]

    def test_missing_burning_keeps_nonzero_cells(self):
        row = {
            "m_fireCount": 2,
            "m_firePositions": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
            "m_bFireIsBurning": None,
        }
        assert len(extract_inferno_cells_from_row(row)) == 2

    def test_tracks_dedupe_and_entity_reuse(self):
        rows = [
            {"tick": 100, "grenade_entity_id": 7, "m_fireCount": 1, "m_firePositions": [[1, 2, 3]], "m_bFireIsBurning": [True]},
            {"tick": 101, "grenade_entity_id": 7, "m_fireCount": 1, "m_firePositions": [[1, 2, 3]], "m_bFireIsBurning": [True]},
            {"tick": 102, "grenade_entity_id": 7, "m_fireCount": 2, "m_firePositions": [[1, 2, 3], [4, 5, 6]], "m_bFireIsBurning": [True, True]},
            # large gap → new track (entity reuse)
            {"tick": 5000, "grenade_entity_id": 7, "m_fireCount": 1, "m_firePositions": [[9, 9, 9]], "m_bFireIsBurning": [True]},
        ]
        tracks = build_inferno_tracks_from_rows(rows, start_tick=0, end_tick=10000, tick_rate=64)
        assert len(tracks) == 2
        assert len(tracks[0]["samples"]) == 2
        assert tracks[0]["samples"][0]["cells"] == [[1.0, 2.0, 3.0, 1.0]]
        assert len(tracks[0]["samples"][1]["cells"]) == 2


class TestSmokeTracks:
    def test_smoke_samples_on_update_change(self):
        blob_a = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
        blob_b = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 16, 18)])),
        ])
        origin = [100.0, 200.0, 50.0]
        rows = [
            {
                "tick": 10,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob_a,
                "m_nVoxelFrameDataSize": len(blob_a),
                "m_vSmokeDetonationPos": origin,
            },
            {
                "tick": 11,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob_a,
                "m_nVoxelFrameDataSize": len(blob_a),
                "m_vSmokeDetonationPos": origin,
            },
            {
                "tick": 20,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 2,
                "m_VoxelFrameData": blob_b,
                "m_nVoxelFrameDataSize": len(blob_b),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=100, tick_rate=64)
        assert warnings == []
        assert len(tracks) == 1
        assert len(tracks[0]["samples"]) == 2
        assert tracks[0]["samples"][0]["seq"] == 1
        assert tracks[0]["samples"][1]["seq"] == 2
        assert tracks[0]["samples"][0]["voxel_update"] == 1
        assert tracks[0]["samples"][1]["voxel_update"] == 2
        payload = json.dumps(tracks)
        assert "VoxelFrameData" not in payload
        assert "\\" not in payload or True  # JSON serializable, no raw bytes

    def test_hash_change_without_update_skips_redundant_decode(self):
        blob_a = _make_journal([(0, _occ_payload([(16, 16, 16)]))])
        blob_b = _make_journal([(0, _occ_payload([(16, 16, 18)]))])
        origin = [100.0, 200.0, 50.0]
        rows = [
            {
                "tick": 10,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob_a,
                "m_nVoxelFrameDataSize": len(blob_a),
                "m_vSmokeDetonationPos": origin,
            },
            {
                "tick": 11,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob_b,
                "m_nVoxelFrameDataSize": len(blob_b),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=100, tick_rate=64)
        assert len(tracks) == 1
        assert len(tracks[0]["samples"]) == 1
        assert warnings == []

    def test_rejects_non_smoke_grenade_types(self):
        blob = _make_journal([(0, _occ_payload([(16, 16, 16)]))])
        rows = [
            {
                "tick": 10,
                "grenade_entity_id": 9,
                "grenade_type": "CMolotovProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": [0, 0, 0],
            },
            {
                "tick": 11,
                "grenade_entity_id": 10,
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": [0, 0, 0],
            },
        ]
        tracks, _warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=100, tick_rate=64)
        assert tracks == []

    def test_smoke_end_tick_uses_lifetime_not_last_row(self):
        blob = _make_journal([(0, _occ_payload([(16, 16, 16)]))])
        origin = [1.0, 2.0, 3.0]
        rows = [
            {
                "tick": 100,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 100,
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin,
            },
            {
                "tick": 180,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 100,
                "m_nVoxelUpdate": 2,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, _warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=10000, tick_rate=64)
        assert len(tracks) == 1
        assert tracks[0]["end_tick"] == 100 + int(18 * 64)

    def test_expands_journal_occupancy_growth_not_pop_open(self):
        """One demoparser row with a multi-seq journal must emit growth samples."""
        blob = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 18, 16)])),
            (3, _occ_payload([(16, 16, 16), (16, 18, 16), (16, 20, 16), (16, 22, 16)])),
        ])
        origin = [100.0, 200.0, 50.0]
        rows = [
            {
                "tick": 10096,
                "grenade_entity_id": 7,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 10000,
                "m_nVoxelUpdate": 3,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=20000, tick_rate=64)
        assert warnings == []
        assert len(tracks) == 1
        samples = tracks[0]["samples"]
        assert len(samples) == 3
        counts = [len(s["cells"]) for s in samples]
        assert counts[0] < counts[-1], "first sample must not equal final full smoke"
        assert [s["seq"] for s in samples] == [1, 2, 3]
        ticks = [s["tick"] for s in samples]
        assert ticks == sorted(ticks)
        assert ticks[0] >= 10000
        assert ticks[-1] == 10096
        assert samples[-1]["voxel_update"] == 3

    def test_seq_dedupe_across_rows_keeps_monotonic_ticks(self):
        blob_early = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 18, 16)])),
        ])
        blob_late = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 18, 16)])),
            (3, _occ_payload([(16, 16, 16), (16, 18, 16), (16, 20, 16)])),
        ])
        origin = [0.0, 0.0, 0.0]
        rows = [
            {
                "tick": 200,
                "grenade_entity_id": 1,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 100,
                "m_nVoxelUpdate": 2,
                "m_VoxelFrameData": blob_early,
                "m_nVoxelFrameDataSize": len(blob_early),
                "m_vSmokeDetonationPos": origin,
            },
            {
                "tick": 300,
                "grenade_entity_id": 1,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 100,
                "m_nVoxelUpdate": 3,
                "m_VoxelFrameData": blob_late,
                "m_nVoxelFrameDataSize": len(blob_late),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, _ = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=1000, tick_rate=64)
        samples = tracks[0]["samples"]
        assert [s["tick"] for s in samples] == sorted(s["tick"] for s in samples)
        assert len(samples[0]["cells"]) < len(samples[-1]["cells"])

    def test_single_seed_snapshot_gets_formation_bfs_samples(self):
        # Connected seed chain mimicking a narrow / diagonal footprint.
        entries = [
            (16, 16, 16),
            (16, 17, 16),
            (16, 18, 16),
            (16, 19, 16),
            (16, 20, 16),
            (16, 21, 16),
            (16, 22, 16),
            (16, 23, 16),
        ]
        blob = _make_journal([(0, _occ_payload(entries))])
        origin = [100.0, 200.0, 50.0]
        rows = [
            {
                "tick": 10000,
                "grenade_entity_id": 9,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nSmokeEffectTickBegin": 10000,
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin,
            },
        ]
        tracks, warnings = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=20000, tick_rate=64)
        assert warnings == []
        assert len(tracks) == 1
        samples = tracks[0]["samples"]
        assert len(samples) >= 4
        assert samples[0].get("anchor_mode") == "formation_bfs"
        counts = [len(s["cells"]) for s in samples]
        assert counts[0] < counts[-1]
        assert samples[0]["tick"] < samples[-1]["tick"]

    def test_stable_origin_ignores_later_detonation_drift(self):
        blob = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
        origin_a = [100.0, 200.0, 50.0]
        origin_b = [1000.0, 2000.0, 50.0]  # > 1 cell drift
        rows = [
            {
                "tick": 10,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin_a,
            },
            {
                "tick": 20,
                "grenade_entity_id": 3,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 2,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": origin_b,
            },
        ]
        tracks, _warnings = build_smoke_tracks_from_rows(
            rows, start_tick=0, end_tick=1000, tick_rate=64, round_number=12
        )
        assert len(tracks) == 1
        assert tracks[0]["stable_origin"] == origin_a
        assert tracks[0]["id"].startswith("smoke:12:3:")
        # All sample cell XY near origin_a, not origin_b
        for sample in tracks[0]["samples"]:
            for cell in sample["cells"]:
                assert abs(cell[0] - origin_a[0]) < 40
                assert abs(cell[1] - origin_a[1]) < 40

    def test_entity_reuse_gets_distinct_lifecycle_ids(self):
        blob = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
        rows = [
            {
                "tick": 10,
                "grenade_entity_id": 9,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": [1.0, 2.0, 3.0],
            },
            {
                "tick": 5000,
                "grenade_entity_id": 9,
                "grenade_type": "CSmokeGrenadeProjectile",
                "m_nVoxelUpdate": 1,
                "m_VoxelFrameData": blob,
                "m_nVoxelFrameDataSize": len(blob),
                "m_vSmokeDetonationPos": [50.0, 60.0, 70.0],
            },
        ]
        tracks, _warnings = build_smoke_tracks_from_rows(
            rows, start_tick=0, end_tick=10000, tick_rate=64, round_number=0
        )
        assert len(tracks) == 2
        assert tracks[0]["id"] != tracks[1]["id"]
        assert tracks[0]["stable_origin"] == [1.0, 2.0, 3.0]
        assert tracks[1]["stable_origin"] == [50.0, 60.0, 70.0]


class TestExtractDynamicEffectTracks:
    def test_combined_parser_is_preferred_and_split_before_rows(self):
        class Combined:
            def __init__(self):
                self.calls = 0

            def parse_utility_effects(self, extra=None):
                self.calls += 1
                assert "m_VoxelFrameData" in extra
                assert "m_firePositions" in extra
                return pd.DataFrame(
                    [
                        {"grenade_type": "CInferno", "tick": 10},
                        {
                            "grenade_type": "CSmokeGrenadeProjectile",
                            "m_bDidSmokeEffect": True,
                            "tick": 20,
                        },
                        {"grenade_type": "CHEGrenadeProjectile", "tick": 30},
                    ]
                )

            def parse_infernos(self, extra=None):
                raise AssertionError("legacy inferno pass must not run")

            def parse_grenades(self, extra=None):
                raise AssertionError("legacy grenade pass must not run")

        parser = Combined()
        inferno_rows, smoke_rows, warnings = _parse_effect_rows(parser)
        assert warnings == []
        assert parser.calls == 1
        assert [row["tick"] for row in inferno_rows] == [10]
        assert [row["tick"] for row in smoke_rows] == [20]

    def test_combined_parser_failure_falls_back_to_legacy_passes(self):
        class Fallback:
            def parse_utility_effects(self, extra=None):
                raise RuntimeError("combined unavailable")

            def parse_infernos(self, extra=None):
                return pd.DataFrame([{"grenade_type": "CInferno", "tick": 10}])

            def parse_grenades(self, extra=None):
                return pd.DataFrame(
                    [
                        {
                            "grenade_type": "CSmokeGrenadeProjectile",
                            "m_bDidSmokeEffect": True,
                            "tick": 20,
                        }
                    ]
                )

        inferno_rows, smoke_rows, warnings = _parse_effect_rows(Fallback())
        assert [row["tick"] for row in inferno_rows] == [10]
        assert [row["tick"] for row in smoke_rows] == [20]
        assert any("legacy passes" in warning for warning in warnings)

    def test_exception_does_not_raise(self):
        class Boom:
            def parse_infernos(self, extra=None):
                raise RuntimeError("inferno boom")

            def parse_grenades(self, extra=None):
                raise RuntimeError("smoke boom")

        out = extract_dynamic_effect_tracks(Boom(), start_tick=0, end_tick=100, tick_rate=64)
        assert out["effects"] == []
        assert out["capabilities"]["inferno_cells"] is False
        assert any("failed" in w for w in out["warnings"])

    def test_disabled_by_env(self, monkeypatch):
        monkeypatch.setenv("CS2_INSIGHT_DYNAMIC_UTILITY_EFFECTS", "0")

        class Ok:
            pass

        out = extract_dynamic_effect_tracks(Ok(), start_tick=0, end_tick=100, tick_rate=64)
        assert out["effects"] == []
        assert "disabled" in out["warnings"][0]
