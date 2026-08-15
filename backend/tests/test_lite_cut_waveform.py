from array import array

from app.features.lite_cut.waveform import _bucket_peaks, waveform_command, waveform_view


def test_waveform_command_decodes_only_compact_mono_pcm(tmp_path):
    command = waveform_command(ffmpeg_bin=tmp_path / "ffmpeg.exe", source=tmp_path / "clip.mov")
    assert command[command.index("-ac") + 1] == "1"
    assert command[command.index("-ar") + 1] == "400"
    assert command[-2:] == ["f32le", "pipe:1"]


def test_waveform_view_returns_only_the_trimmed_range():
    payload = {"duration_sec": 10, "peaks": [0.1] * 50 + [1.0] * 50}
    first = waveform_view(payload, start_sec=0, end_sec=5, buckets=10)
    second = waveform_view(payload, start_sec=5, end_sec=10, buckets=10)
    assert first["start_sec"] == 0
    assert first["end_sec"] == 5
    assert second["start_sec"] == 5
    assert len(first["peaks"]) == 10
    assert len(second["peaks"]) == 10
    assert first["cache_buckets"] == 100
    assert max(first["peaks"]) == 0.1
    assert max(second["peaks"]) == 1.0
    assert first["normalization_peak"] == second["normalization_peak"] == 1.0


def test_waveform_view_caps_each_visible_tile_without_reducing_the_disk_cache():
    payload = {"duration_sec": 1_383.416667, "peaks": [0.25] * 16_384}

    view = waveform_view(payload, start_sec=120, end_sec=150, buckets=10_000)

    assert view["start_sec"] == 120
    assert view["end_sec"] == 150
    assert view["buckets"] == 512
    assert view["cache_buckets"] == 16_384


def test_bucket_peaks_does_not_append_silence_for_short_sources():
    values = _bucket_peaks(array("f", [0.25, 0.5]), 8)
    assert len(values) == 8
    assert min(values) > 0
