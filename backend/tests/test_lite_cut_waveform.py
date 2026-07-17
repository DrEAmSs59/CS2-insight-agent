from array import array

from app.lite_cut.waveform import _bucket_peaks, waveform_command, waveform_view


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


def test_bucket_peaks_does_not_append_silence_for_short_sources():
    values = _bucket_peaks(array("f", [0.25, 0.5]), 8)
    assert len(values) == 8
    assert min(values) > 0
