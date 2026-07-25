from app.parser.smoke_voxel_decode import SmokeVoxel
from app.parser.smoke_voxel_diagnostics import (
    compare_centers,
    raw_grid_entries,
    state_byte_histograms,
)


def test_raw_grid_entries_preserve_axes_and_state():
    v = SmokeVoxel(x=18, y=12, z=16, state=bytes([3, 0, 5, 1, 0]))
    assert raw_grid_entries([v]) == [{
        "grid_x": 18, "grid_y": 12, "grid_z": 16, "state": [3, 0, 5, 1, 0],
    }]


def test_compare_centers_reports_both_anchors():
    v = SmokeVoxel(x=17, y=16, z=16, state=bytes([5, 0, 0, 0, 0]))
    out = compare_centers([v], [100.0, 200.0, 50.0])
    assert "center_16" in out and "center_15_5" in out
    # sign_x=-1: center 16 → (17-16)*20*-1 = -20 → 80
    assert out["center_16"]["mean_world"][0] == 80.0
    # center 15.5 → (17-15.5)*20*-1 = -30 → 70
    assert out["center_15_5"]["mean_world"][0] == 70.0


def test_iter_axis_candidates_has_sixteen():
    from app.parser.smoke_voxel_diagnostics import iter_axis_candidates

    assert len(iter_axis_candidates()) == 16


def test_rank_prefers_center_16_over_15_5():
    from app.parser.smoke_voxel_diagnostics import rank_axis_candidates

    # Synthetic occupancy packed [z,y,x] around grid centre (≥3 cells to score).
    # With sign_x=-1, cells (16,16,16),(15,16,16),(17,16,16) centroid at origin for center=16.
    payload = bytes([
        0, 1, 3,
        16, 16, 16, 5, 0, 0, 0, 0,
        16, 16, 15, 5, 0, 0, 0, 0,
        16, 16, 17, 5, 0, 0, 0, 0,
    ])
    origin = [0.0, 0.0, 0.0]
    ranked = rank_axis_candidates([(origin, payload)])
    assert ranked[0]["center"] == 16.0
    assert ranked[0]["packing"] == "zyx"
    assert ranked[0]["sign_x"] == -1.0
    assert any(row["is_production"] for row in ranked)


def test_state_histograms_count_bytes():
    voxels = [
        SmokeVoxel(x=1, y=1, z=1, state=bytes([3, 0, 5, 1, 0])),
        SmokeVoxel(x=2, y=2, z=2, state=bytes([3, 1, 5, 1, 0])),
    ]
    hist = state_byte_histograms(voxels)
    assert hist[0]["freq"]["3"] == 2
    assert hist[1]["freq"]["0"] == 1
    assert hist[1]["freq"]["1"] == 1


def test_demo_fingerprint_fields(tmp_path):
    from app.parser.smoke_voxel_diagnostics import demo_fingerprint

    p = tmp_path / "x.dem"
    p.write_bytes(b"abc")
    fp = demo_fingerprint(p)
    assert fp["size"] == 3
    assert "sha256" in fp and len(fp["sha256"]) == 64
    assert "mtime_ns" in fp
    assert fp["path"].endswith("x.dem")
