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


def _occ_payload(entries: list[tuple[int, int, int]]) -> list[int]:
    # Type-3 keyframe; seed entries are packed (x, y, z).
    out = [0x00, 0x03, len(entries)]
    for x, y, z in entries:
        out.extend([x, y, z, 5, 0, 0, 0, 0])
    out.extend([0, 0])  # no Morton mask entries
    return out


def _morton3(x: int, y: int, z: int, bits: int) -> int:
    value = 0
    for bit in range(bits):
        value |= ((x >> bit) & 1) << (3 * bit)
        value |= ((y >> bit) & 1) << (3 * bit + 1)
        value |= ((z >> bit) & 1) << (3 * bit + 2)
    return value


def _mask_entry(cell_xyz: tuple[int, int, int], sub_xyz: tuple[int, int, int]) -> list[int]:
    cell_index = _morton3(*cell_xyz, bits=3)
    mask = 1 << _morton3(*sub_xyz, bits=2)
    return list(cell_index.to_bytes(2, "little") + mask.to_bytes(8, "little"))


def _masked_keyframe(cell_xyz: tuple[int, int, int], sub_xyz: tuple[int, int, int]) -> list[int]:
    return [0, 3, 0, 1, 0, *_mask_entry(cell_xyz, sub_xyz)]


def _mask_delta(cell_xyz: tuple[int, int, int], sub_xyz: tuple[int, int, int]) -> list[int]:
    return [0, 2, 1, 0, *_mask_entry(cell_xyz, sub_xyz)]


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
        # Payload bytes are [x, y, z].
        voxels = decode_voxel_frame_occupancy(bytes(_occ_payload([(14, 16, 18), (16, 16, 18)])))
        assert voxels is not None
        assert len(voxels) == 2
        assert (voxels[0].x, voxels[0].y, voxels[0].z) == (14, 16, 18)

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
        assert voxel_to_world(15.5, 15.5, 15.5, [100, 200, 50]) == (100.0, 200.0, 50.0)
        assert voxel_to_world(16.5, 15.5, 15.5, [100, 200, 50]) == (112.0, 200.0, 50.0)
        assert voxel_to_world(15.5, 16.5, 15.5, [100, 200, 50]) == (100.0, 212.0, 50.0)
        assert voxel_to_world(15.5, 15.5, 16.5, [100, 200, 50]) == (100.0, 200.0, 62.0)


class TestDecodeSmokeCells:
    def test_ok_path_projects_cells(self):
        data = _make_journal([(0, _occ_payload([(16, 16, 16), (17, 16, 16)]))])
        out = decode_smoke_cells(data, declared_size=len(data), detonation_pos=[100.0, 200.0, 50.0])
        assert out["ok"] is True
        assert out["voxel_count"] == 2
        assert out["cell_size"] == VOXEL_CELL_SIZE_WORLD
        assert len(out["cells"]) == 2

    def test_keyframe_projects_morton_mask_not_only_seeds(self):
        # Coarse (1,2,3) + subcell (3,1,2) becomes grid (7,9,14).
        data = _make_journal([(0, _masked_keyframe((1, 2, 3), (3, 1, 2)))])
        out = decode_smoke_cells(data, declared_size=len(data), detonation_pos=[100.0, 200.0, 50.0])
        assert out["ok"] is True
        assert out["voxel_count"] == 1
        assert out["cell_size"] == 12.0
        assert out["cells"] == [[-2.0, 122.0, 32.0, 1.0]]

    def test_delta_replaces_coarse_cell_mask(self):
        keyframe = _masked_keyframe((1, 2, 3), (0, 0, 0))
        delta = _mask_delta((1, 2, 3), (3, 0, 0))
        data = _make_journal([(0, keyframe), (1, delta)])
        early = decode_smoke_cells(
            data, declared_size=len(data), detonation_pos=[0.0, 0.0, 0.0], target_seq=0
        )
        late = decode_smoke_cells(
            data, declared_size=len(data), detonation_pos=[0.0, 0.0, 0.0], target_seq=1
        )
        assert early["cells"] == [[-138.0, -90.0, -42.0, 1.0]]
        assert late["cells"] == [[-102.0, -90.0, -42.0, 1.0]]

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

