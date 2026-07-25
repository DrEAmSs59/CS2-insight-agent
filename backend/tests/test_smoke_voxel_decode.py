from __future__ import annotations

from app.parser.smoke_voxel_decode import (
    VOXEL_CELL_SIZE_WORLD,
    decode_smoke_cells,
    decode_smoke_occupancy_sequence,
    decode_smoke_voxel_journal,
    decode_voxel_frame_occupancy,
    get_smoke_occupancy_at,
    iter_smoke_occupancy_frames,
    voxel_to_world,
)


def _make_journal(records: list[tuple[int, list[int]]]) -> bytes:
    out = bytearray()
    for seq, payload in records:
        out.append(seq & 0xFF)
        out.append((seq >> 8) & 0xFF)
        out.append(len(payload) & 0xFF)
        out.append((len(payload) >> 8) & 0xFF)
        out.extend(payload)
    return bytes(out)


def _occ_payload(entries: list[tuple[int, int, int]], flags: int = 0x01) -> list[int]:
    # entries are (z, y, x) matching CS2 occupancy packing
    out = [0x00, flags, len(entries)]
    for z, y, x in entries:
        out.extend([z, y, x, 5, 0, 0, 0, 0])
    return out


class TestDecodeSmokeVoxelJournal:
    def test_splits_records(self):
        data = _make_journal([(0, [1, 2, 3, 4, 5]), (1, [0, 0, 0]), (2, [9])])
        frames = decode_smoke_voxel_journal(data)
        assert [f.seq for f in frames] == [0, 1, 2]
        assert list(frames[0].payload) == [1, 2, 3, 4, 5]
        assert frames[1].is_heartbeat is True

    def test_honours_declared_size(self):
        real = _make_journal([(0, [1, 2, 3]), (1, [0, 0, 0])])
        padded = real + b"\x00" * 64
        frames = decode_smoke_voxel_journal(padded, len(real))
        assert len(frames) == 2

    def test_overrun_raises(self):
        data = bytes([0, 0, 100, 0, 1, 2])
        try:
            decode_smoke_voxel_journal(data)
            assert False, "expected SmokeVoxelDecodeError"
        except Exception as exc:
            assert "overruns" in str(exc)


class TestOccupancyAndWorld:
    def test_occupancy_entries(self):
        # payload bytes are [z, y, x]; SmokeVoxel stores named axes
        voxels = decode_voxel_frame_occupancy(bytes(_occ_payload([(14, 16, 18), (16, 16, 18)])))
        assert voxels is not None
        assert len(voxels) == 2
        assert (voxels[0].z, voxels[0].y, voxels[0].x) == (14, 16, 18)

    def test_get_occupancy_at(self):
        frames = decode_smoke_voxel_journal(
            _make_journal([
                (0, _occ_payload([(1, 1, 1)])),
                (1, [0, 0, 0]),
                (2, _occ_payload([(9, 9, 9), (8, 8, 8)])),
            ])
        )
        assert get_smoke_occupancy_at(frames, 1)[0] == 0
        assert len(get_smoke_occupancy_at(frames)[1]) == 2

    def test_voxel_to_world(self):
        assert voxel_to_world(16, 16, 16, [100, 200, 50]) == (100.0, 200.0, 50.0)
        # sign_x = -1 → grid x=17 is west of origin
        assert voxel_to_world(17, 16, 16, [100, 200, 50]) == (80.0, 200.0, 50.0)
        assert voxel_to_world(16, 17, 16, [100, 200, 50]) == (100.0, 220.0, 50.0)
        assert voxel_to_world(16, 16, 17, [100, 200, 50]) == (100.0, 200.0, 70.0)


class TestDecodeSmokeCells:
    def test_ok_path_projects_cells(self):
        # entries are (z, y, x); different x → distinct projected XY cells
        data = _make_journal([(0, _occ_payload([(16, 16, 16), (16, 16, 17)]))])
        out = decode_smoke_cells(data, declared_size=len(data), detonation_pos=[100.0, 200.0, 50.0])
        assert out["ok"] is True
        assert out["voxel_count"] == 2
        assert out["cell_size"] == VOXEL_CELL_SIZE_WORLD
        assert len(out["cells"]) == 2

    def test_target_seq_limits_to_earlier_occupancy(self):
        data = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 18, 16)])),
            (3, _occ_payload([(16, 16, 16), (16, 18, 16), (16, 20, 16), (16, 22, 16)])),
        ])
        early = decode_smoke_cells(
            data, declared_size=len(data), detonation_pos=[100.0, 200.0, 50.0], target_seq=1
        )
        late = decode_smoke_cells(
            data, declared_size=len(data), detonation_pos=[100.0, 200.0, 50.0], target_seq=3
        )
        assert early["ok"] and late["ok"]
        assert early["seq"] == 1
        assert late["seq"] == 3
        assert early["voxel_count"] < late["voxel_count"]
        assert len(early["cells"]) < len(late["cells"])

    def test_iter_occupancy_frames_yields_growth(self):
        data = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (1, [0, 0, 0]),  # heartbeat skipped
            (2, _occ_payload([(16, 16, 16), (16, 18, 16)])),
            (3, _occ_payload([(16, 16, 16), (16, 18, 16), (16, 20, 16)])),
        ])
        frames = iter_smoke_occupancy_frames(data, declared_size=len(data))
        assert [seq for seq, _ in frames] == [1, 2, 3]
        assert [len(v) for _, v in frames] == [1, 2, 3]

    def test_occupancy_sequence_projects_each_seq(self):
        data = _make_journal([
            (1, _occ_payload([(16, 16, 16)])),
            (2, _occ_payload([(16, 16, 16), (16, 18, 16), (16, 20, 16)])),
        ])
        seq = decode_smoke_occupancy_sequence(
            data, declared_size=len(data), detonation_pos=[0.0, 0.0, 0.0], max_seq=2
        )
        assert [item["seq"] for item in seq] == [1, 2]
        assert len(seq[0]["cells"]) < len(seq[1]["cells"])

    def test_occupancy_sequence_can_decode_only_appended_journal_tail(self):
        prefix = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
        data = prefix + _make_journal([
            (2, [0, 0, 0]),
            (3, _occ_payload([(16, 16, 16), (16, 18, 16)])),
        ])
        seq = decode_smoke_occupancy_sequence(
            data,
            declared_size=len(data),
            detonation_pos=[0.0, 0.0, 0.0],
            max_seq=3,
            start_offset=len(prefix),
        )
        assert [item["seq"] for item in seq] == [3]

    def test_missing_origin(self):
        out = decode_smoke_cells(b"\x00\x00\x00\x00", declared_size=4, detonation_pos=None)
        assert out["ok"] is False
        assert out["error"] == "missing_origin"


class TestFormationFromSeeds:
    def test_bfs_formation_grows_without_circular_clip(self):
        from app.parser.smoke_voxel_decode import SmokeVoxel, synthesize_formation_from_seeds

        # Diagonal seed chain — formation must follow adjacency, not a filled disc.
        voxels = [
            SmokeVoxel(x=16, y=16, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=17, y=17, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=18, y=18, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=19, y=19, z=16, state=b"\x05\x00\x00\x00\x00"),
        ]
        # Make them 6-connected via intermediates
        voxels = [
            SmokeVoxel(x=16, y=16, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=17, y=16, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=17, y=17, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=18, y=17, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=18, y=18, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=19, y=18, z=16, state=b"\x05\x00\x00\x00\x00"),
            SmokeVoxel(x=19, y=19, z=16, state=b"\x05\x00\x00\x00\x00"),
        ]
        samples = synthesize_formation_from_seeds(
            voxels, [0.0, 0.0, 0.0], begin_tick=1000, end_tick=1076, steps=4
        )
        assert len(samples) == 4
        counts = [s["voxel_count"] for s in samples]
        assert counts[0] < counts[-1]
        assert counts[-1] == len(voxels)
        assert samples[0]["anchor_mode"] == "formation_bfs"
        assert samples[0]["tick"] < samples[-1]["tick"]

