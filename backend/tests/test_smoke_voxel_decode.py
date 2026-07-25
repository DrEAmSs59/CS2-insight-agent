from __future__ import annotations

from app.parser.smoke_voxel_decode import (
    VOXEL_CELL_SIZE_WORLD,
    decode_smoke_cells,
    decode_smoke_voxel_journal,
    decode_voxel_frame_occupancy,
    get_smoke_occupancy_at,
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
        voxels = decode_voxel_frame_occupancy(bytes(_occ_payload([(14, 18, 16), (16, 18, 16)])))
        assert voxels is not None
        assert len(voxels) == 2
        assert (voxels[0].z, voxels[0].y, voxels[0].x) == (14, 18, 16)

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

    def test_missing_origin(self):
        out = decode_smoke_cells(b"\x00\x00\x00\x00", declared_size=4, detonation_pos=None)
        assert out["ok"] is False
        assert out["error"] == "missing_origin"
