from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.encoder_planner import (  # noqa: E402
    EncoderCandidate,
    EncoderProbeCache,
    EncoderProbeResult,
    EncoderTargetSpec,
    GpuAdapter,
    adapters_from_windows_rows,
    build_auto_encoder_candidates,
    build_encoder_candidates,
    enumerate_windows_gpus,
    map_nvenc_device_indices,
    make_probe_cache_key,
    parse_nvenc_driver_warning,
    run_encoder_attempts,
    select_first_usable_encoder,
)
from app.montage_exceptions import HardwareEncoderFailure  # noqa: E402


def _gpu(
    name: str,
    vendor: str,
    kind: str,
    rank: int,
    *,
    pnp_id: str | None = None,
    driver: str = "1.0",
    encoder_device_index: int | None = None,
) -> GpuAdapter:
    return GpuAdapter(
        name=name,
        vendor=vendor,  # type: ignore[arg-type]
        kind=kind,  # type: ignore[arg-type]
        pnp_device_id=pnp_id or f"PCI\\VEN_TEST&DEV_{rank:04X}",
        driver_version=driver,
        performance_rank=rank,
        enumeration_index=rank,
        encoder_device_index=encoder_device_index,
    )


def test_windows_inventory_filters_virtual_and_classifies_gpus() -> None:
    rows = [
        {
            "Name": "Intel(R) UHD Graphics 770",
            "AdapterCompatibility": "Intel Corporation",
            "PNPDeviceID": r"PCI\VEN_8086&DEV_4690",
            "AdapterRAM": 1_073_741_824,
            "DriverVersion": "31.0.1",
            "Status": "OK",
        },
        {
            "Name": "NVIDIA GeForce RTX 4070",
            "AdapterCompatibility": "NVIDIA",
            "PNPDeviceID": r"PCI\VEN_10DE&DEV_2786",
            "AdapterRAM": 4_294_967_295,
            "DriverVersion": "32.0.2",
            "Status": "OK",
        },
        {
            "Name": "Parsec Virtual Display Adapter",
            "AdapterCompatibility": "Parsec",
            "PNPDeviceID": r"ROOT\DISPLAY\0000",
            "Status": "OK",
        },
    ]

    adapters = adapters_from_windows_rows(rows)

    assert [adapter.vendor for adapter in adapters] == ["intel", "nvidia"]
    assert [adapter.kind for adapter in adapters] == ["integrated", "discrete"]
    assert adapters[1].device_id == "2786"


@pytest.mark.parametrize(
    ("name", "expected_kind"),
    [
        ("AMD Radeon RX 7900 XTX", "discrete"),
        ("AMD Radeon 780M Graphics", "integrated"),
        ("AMD Radeon(TM) Graphics", "integrated"),
    ],
)
def test_amd_kind_is_detected_best_effort(name: str, expected_kind: str) -> None:
    adapters = adapters_from_windows_rows(
        [
            {
                "Name": name,
                "AdapterCompatibility": "Advanced Micro Devices, Inc.",
                "PNPDeviceID": r"PCI\VEN_1002&DEV_1234",
                "Status": "OK",
            }
        ]
    )
    assert adapters[0].kind == expected_kind


@pytest.mark.parametrize(
    ("name", "expected_kind"),
    [
        ("Intel(R) Arc(TM) A770 Graphics", "discrete"),
        ("Intel(R) Arc(TM) Graphics", "integrated"),
        ("Intel(R) Iris(R) Xe MAX Graphics", "discrete"),
    ],
)
def test_intel_kind_avoids_treating_integrated_arc_brand_as_discrete(
    name: str,
    expected_kind: str,
) -> None:
    adapters = adapters_from_windows_rows(
        [
            {
                "Name": name,
                "AdapterCompatibility": "Intel Corporation",
                "PNPDeviceID": r"PCI\VEN_8086&DEV_1234",
                "Status": "OK",
            }
        ]
    )
    assert adapters[0].kind == expected_kind


def test_enumerator_uses_powershell_json_and_non_windows_is_empty() -> None:
    payload = [
        {
            "Name": "AMD Radeon RX 7800 XT",
            "AdapterCompatibility": "AMD",
            "PNPDeviceID": r"PCI\VEN_1002&DEV_747E",
            "DriverVersion": "32.0.21001",
            "Status": "OK",
        }
    ]
    calls: list[list[str]] = []

    def runner(command, **kwargs):
        calls.append(list(command))
        return MagicMock(
            stdout=json.dumps(payload).encode("utf-8"),
            stderr=b"",
            returncode=0,
        )

    adapters = enumerate_windows_gpus(runner=runner, platform_name="Windows")
    assert [adapter.vendor for adapter in adapters] == ["amd"]
    assert calls[0][0] == "powershell.exe"

    def forbidden_runner(command, **kwargs):
        raise AssertionError("runner must not be called outside Windows")

    assert enumerate_windows_gpus(runner=forbidden_runner, platform_name="Linux") == []


def test_enumerator_falls_back_to_wmic() -> None:
    wmic_csv = (
        "Node,AdapterCompatibility,AdapterRAM,Availability,DriverVersion,Name,"
        "PNPDeviceID,Status,VideoProcessor\r\n"
        "PC,NVIDIA,8589934592,3,1.2,NVIDIA GeForce RTX 4060,"
        r"PCI\VEN_10DE&DEV_2882,OK,NVIDIA GeForce RTX 4060"
        "\r\n"
    )

    def runner(command, **kwargs):
        if command[0].casefold().startswith(("powershell", "pwsh")):
            raise FileNotFoundError(command[0])
        assert command[0] == "wmic.exe"
        return MagicMock(stdout=wmic_csv.encode(), stderr=b"", returncode=0)

    adapters = enumerate_windows_gpus(runner=runner, platform_name="Windows")
    assert len(adapters) == 1
    assert adapters[0].vendor == "nvidia"


def test_auto_uses_only_first_ranked_discrete_gpu_then_x264() -> None:
    adapters = [
        _gpu("Intel UHD", "intel", "integrated", 0),
        _gpu("AMD Radeon RX 7800 XT", "amd", "discrete", 1),
        _gpu(
            "NVIDIA RTX 4070",
            "nvidia",
            "discrete",
            0,
            pnp_id=r"PCI\VEN_10DE&DEV_2786",
            encoder_device_index=2,
        ),
    ]

    candidates = build_auto_encoder_candidates(
        adapters,
        available_encoders={"h264_nvenc", "h264_qsv", "h264_amf", "libx264"},
    )

    assert [candidate.codec for candidate in candidates] == [
        "h264_nvenc",
        "libx264",
    ]
    assert candidates[0].ffmpeg_device_args == ("-gpu", "2")
    assert candidates[-1].adapter is None


def test_auto_does_not_use_integrated_gpu_when_primary_encoder_is_unavailable() -> None:
    candidates = build_auto_encoder_candidates(
        [
            _gpu("AMD Radeon RX 6800", "amd", "discrete", 0),
            _gpu("Intel UHD", "intel", "integrated", 1),
        ],
        available_encoders={"h264_qsv", "libx264"},
    )
    assert [candidate.codec for candidate in candidates] == ["libx264"]


def test_candidate_type_depends_on_codec_not_adapter_attribution() -> None:
    manual_amf = EncoderCandidate(codec="h264_amf", priority=0)
    software_with_unexpected_adapter = EncoderCandidate(
        codec="libx264",
        priority=1,
        adapter=_gpu("AMD Radeon RX 6800", "amd", "discrete", 0),
    )

    assert manual_amf.adapter is None
    assert manual_amf.is_hardware is True
    assert manual_amf.is_software is False
    assert software_with_unexpected_adapter.is_software is True
    assert software_with_unexpected_adapter.is_hardware is False


@pytest.mark.parametrize("frame_rate", [0, -1, float("nan"), float("inf")])
def test_target_spec_rejects_non_positive_or_non_finite_frame_rate(
    frame_rate: float,
) -> None:
    with pytest.raises(ValueError):
        EncoderTargetSpec(1920, 1080, frame_rate)


def test_auto_does_not_continue_to_second_discrete_or_integrated_gpu() -> None:
    candidates = build_auto_encoder_candidates(
        [
            _gpu("AMD Radeon RX 7900 XTX", "amd", "discrete", 0),
            _gpu(
                "AMD Radeon RX 7800 XT",
                "amd",
                "discrete",
                1,
                pnp_id=r"PCI\VEN_1002&DEV_747E",
            ),
            _gpu("Intel UHD 770", "intel", "integrated", 2),
            _gpu(
                "Intel UHD 630",
                "intel",
                "integrated",
                3,
                pnp_id=r"PCI\VEN_8086&DEV_3E92",
            ),
        ],
        available_encoders={"h264_amf", "h264_qsv", "libx264"},
    )

    assert [candidate.codec for candidate in candidates] == [
        "h264_amf",
        "libx264",
    ]


def test_manual_mode_can_try_distinct_bound_devices_for_requested_vendor() -> None:
    candidates = build_encoder_candidates(
        "h264_nvenc",
        [
            _gpu(
                "NVIDIA RTX 4090",
                "nvidia",
                "discrete",
                0,
                encoder_device_index=1,
            ),
            _gpu(
                "NVIDIA RTX 4080",
                "nvidia",
                "discrete",
                1,
                pnp_id=r"PCI\VEN_10DE&DEV_2704",
                encoder_device_index=0,
            ),
        ],
        available_encoders={"h264_nvenc", "libx264"},
    )

    assert [candidate.ffmpeg_device_args for candidate in candidates[:-1]] == [
        ("-gpu", "1"),
        ("-gpu", "0"),
    ]


def test_manual_mode_finds_requested_integrated_vendor_when_discrete_is_primary() -> None:
    amd = _gpu("AMD Radeon RX 7900 XTX", "amd", "discrete", 0)
    intel = _gpu("Intel UHD 770", "intel", "integrated", 1)

    candidates = build_encoder_candidates(
        "h264_qsv",
        [amd, intel],
        available_encoders={"h264_amf", "h264_qsv", "libx264"},
    )

    assert [candidate.codec for candidate in candidates] == ["h264_qsv", "libx264"]
    assert candidates[0].adapter is intel


def test_nvenc_mapping_requires_unambiguous_name_match(monkeypatch) -> None:
    duplicate_a = _gpu(
        "NVIDIA RTX 4090",
        "nvidia",
        "discrete",
        0,
        pnp_id=r"PCI\VEN_10DE&DEV_2684&SUBSYS_A",
    )
    duplicate_b = _gpu(
        "NVIDIA RTX 4090",
        "nvidia",
        "discrete",
        1,
        pnp_id=r"PCI\VEN_10DE&DEV_2684&SUBSYS_B",
    )
    unique = _gpu(
        "NVIDIA RTX 4070",
        "nvidia",
        "discrete",
        2,
        pnp_id=r"PCI\VEN_10DE&DEV_2786",
    )
    output = "\n".join(
        [
            "[h264_nvenc] [ GPU #0 - < NVIDIA RTX 4090 > has Compute SM 8.9 ]",
            "[h264_nvenc] [ GPU #1 - < NVIDIA RTX 4090 > has Compute SM 8.9 ]",
            "[h264_nvenc] [ GPU #2 - < NVIDIA RTX 4070 > has Compute SM 8.9 ]",
        ]
    )
    monkeypatch.setattr(
        "app.encoder_planner.run_process_capture",
        lambda *args, **kwargs: MagicMock(stdout="", stderr=output, returncode=0),
    )

    mapped = map_nvenc_device_indices(
        Path("ffmpeg.exe"),
        [duplicate_a, duplicate_b, unique],
    )

    assert [adapter.encoder_device_index for adapter in mapped] == [None, None, 2]


def test_nvenc_mapping_preserves_stronger_existing_mapping(monkeypatch) -> None:
    adapter = _gpu(
        "NVIDIA RTX 4070",
        "nvidia",
        "discrete",
        0,
        encoder_device_index=3,
    )
    monkeypatch.setattr(
        "app.encoder_planner.run_process_capture",
        lambda *args, **kwargs: MagicMock(
            stdout="",
            stderr="[h264_nvenc] [ GPU #2 - < NVIDIA RTX 4070 > has Compute SM 8.9 ]",
            returncode=0,
        ),
    )

    mapped = map_nvenc_device_indices(Path("ffmpeg.exe"), [adapter])

    assert mapped[0].encoder_device_index == 3


def test_probe_uses_real_spec_falls_back_and_caches() -> None:
    candidates = build_auto_encoder_candidates(
        [_gpu("AMD Radeon RX 6800", "amd", "discrete", 0)],
        available_encoders={"h264_amf", "libx264"},
    )
    spec = EncoderTargetSpec(
        width=3840,
        height=2160,
        frame_rate=59.94,
        profile="high",
        encoder_options=("-usage", "transcoding", "-quality", "balanced"),
    )
    cache = EncoderProbeCache()
    calls: list[tuple[str, EncoderTargetSpec]] = []

    def probe(candidate, target):
        calls.append((candidate.codec, target))
        if candidate.codec == "h264_amf":
            return EncoderProbeResult(False, "AMF surface allocation failed")
        return True

    first = select_first_usable_encoder(
        candidates,
        spec,
        probe,
        ffmpeg_identity=r"C:\ffmpeg.exe|ffmpeg version 7.1",
        cache=cache,
    )
    assert first.selected is not None
    assert first.selected.codec == "libx264"
    assert [item[0] for item in calls] == ["h264_amf", "libx264"]
    assert all(target is spec for _, target in calls)
    assert not any(attempt.from_cache for attempt in first.attempts)

    second = select_first_usable_encoder(
        candidates,
        spec,
        probe,
        ffmpeg_identity=r"C:\ffmpeg.exe|ffmpeg version 7.1",
        cache=cache,
    )
    assert second.selected is not None
    assert second.selected.codec == "libx264"
    assert len(calls) == 2
    assert all(attempt.from_cache for attempt in second.attempts)


def test_probe_cache_key_tracks_driver_ffmpeg_spec_and_options() -> None:
    adapter_v1 = _gpu(
        "AMD Radeon RX 6800",
        "amd",
        "discrete",
        0,
        driver="31.0.1",
    )
    adapter_v2 = _gpu(
        "AMD Radeon RX 6800",
        "amd",
        "discrete",
        0,
        driver="32.0.1",
    )
    candidate_v1 = build_auto_encoder_candidates([adapter_v1])[0]
    candidate_v2 = build_auto_encoder_candidates([adapter_v2])[0]
    spec_1080 = EncoderTargetSpec(1920, 1080, 60, encoder_options=("-qp_i", "20"))
    spec_4k = EncoderTargetSpec(3840, 2160, 60, encoder_options=("-qp_i", "20"))
    spec_other_args = EncoderTargetSpec(1920, 1080, 60, encoder_options=("-qp_i", "22"))

    base = make_probe_cache_key(candidate_v1, spec_1080, ffmpeg_identity="ffmpeg-7.1")
    keys = {
        make_probe_cache_key(candidate_v2, spec_1080, ffmpeg_identity="ffmpeg-7.1"),
        make_probe_cache_key(candidate_v1, spec_4k, ffmpeg_identity="ffmpeg-7.1"),
        make_probe_cache_key(candidate_v1, spec_other_args, ffmpeg_identity="ffmpeg-7.1"),
        make_probe_cache_key(candidate_v1, spec_1080, ffmpeg_identity="ffmpeg-8.0"),
    }
    assert base not in keys
    assert len(keys) == 4


def test_probe_exception_does_not_block_x264_fallback() -> None:
    candidates = build_auto_encoder_candidates(
        [_gpu("NVIDIA RTX 4070", "nvidia", "discrete", 0)]
    )

    def probe(candidate, spec):
        if not candidate.is_software:
            raise subprocess.TimeoutExpired(["ffmpeg"], 45)
        return True

    plan = select_first_usable_encoder(
        candidates,
        EncoderTargetSpec(1920, 1080, 60),
        probe,
        ffmpeg_identity="ffmpeg-test",
    )
    assert plan.selected is not None
    assert plan.selected.codec == "libx264"
    assert plan.attempts[0].result.ok is False


def test_nvenc_driver_warning_extracts_dynamic_ffmpeg_requirements() -> None:
    warning = parse_nvenc_driver_warning(
        "h264_nvenc",
        """
        Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0
        The minimum required Nvidia driver for nvenc is 610.00 or newer
        """,
        current_driver_version="32.0.15.6094",
    )

    assert warning == {
        "code": "NVIDIA_DRIVER_TOO_OLD",
        "codec": "h264_nvenc",
        "found_nvenc_api": "13.0",
        "required_nvenc_api": "13.1",
        "minimum_driver_version": "610.00",
        "current_driver_version": "32.0.15.6094",
    }


def test_nvenc_driver_warning_ignores_unrelated_encoder_failure() -> None:
    assert parse_nvenc_driver_warning("h264_nvenc", "No capable devices found") is None
    assert parse_nvenc_driver_warning(
        "h264_amf",
        "Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0",
    ) is None


def test_manual_adapterless_hardware_failure_retries_x264_and_poisons_probe_cache() -> None:
    candidates = build_encoder_candidates(
        "h264_amf",
        [],
        available_encoders={"h264_amf", "libx264"},
    )
    assert [candidate.codec for candidate in candidates] == ["h264_amf", "libx264"]
    assert candidates[0].adapter is None

    cache = EncoderProbeCache()
    probe_calls: list[str] = []
    run_calls: list[str] = []
    cleanup_calls: list[str] = []

    def probe(candidate, spec):
        probe_calls.append(candidate.codec)
        return True

    def runner(candidate):
        run_calls.append(candidate.codec)
        if candidate.codec == "h264_amf":
            raise HardwareEncoderFailure(
                codec="h264_amf",
                stage="encode",
                stderr="AMF failed",
            )
        return "software-result"

    first = run_encoder_attempts(
        candidates,
        EncoderTargetSpec(1920, 1080, 60),
        probe,
        runner,
        ffmpeg_identity="ffmpeg-test",
        cache=cache,
        cleanup=lambda: cleanup_calls.append("cleanup"),
    )

    assert first.value == "software-result"
    assert first.selected.codec == "libx264"
    assert run_calls == ["h264_amf", "libx264"]
    assert cleanup_calls == ["cleanup"]
    assert [attempt.status for attempt in first.attempts] == [
        "export_failed",
        "succeeded",
    ]

    run_calls.clear()
    second = run_encoder_attempts(
        candidates,
        EncoderTargetSpec(1920, 1080, 60),
        probe,
        runner,
        ffmpeg_identity="ffmpeg-test",
        cache=cache,
    )
    assert second.selected.codec == "libx264"
    assert run_calls == ["libx264"]
    # Both AMF's cached failure and x264's cached pass avoided new probes.
    assert probe_calls == ["h264_amf", "libx264"]


def test_run_attempts_defensively_deduplicates_identical_invocations() -> None:
    candidates = (
        EncoderCandidate(
            codec="h264_amf",
            priority=0,
            adapter=_gpu("AMD Radeon RX 7900 XTX", "amd", "discrete", 0),
        ),
        EncoderCandidate(
            codec="h264_amf",
            priority=1,
            adapter=_gpu(
                "AMD Radeon RX 7800 XT",
                "amd",
                "discrete",
                1,
                pnp_id=r"PCI\VEN_1002&DEV_747E",
            ),
        ),
        EncoderCandidate(codec="libx264", priority=2),
    )
    run_calls: list[str] = []

    def runner(candidate):
        run_calls.append(candidate.codec)
        if candidate.codec == "h264_amf":
            raise HardwareEncoderFailure(codec="h264_amf", stage="encode")
        return "ok"

    result = run_encoder_attempts(
        candidates,
        EncoderTargetSpec(1920, 1080, 60),
        lambda *_args: True,
        runner,
        ffmpeg_identity="ffmpeg-test-dedup",
        cache=EncoderProbeCache(),
    )

    assert result.selected.codec == "libx264"
    assert run_calls == ["h264_amf", "libx264"]


def test_attempt_observer_failure_does_not_break_fallback_or_success() -> None:
    candidates = (
        EncoderCandidate(codec="h264_amf", priority=0),
        EncoderCandidate(codec="libx264", priority=1),
    )

    def runner(candidate):
        if candidate.codec == "h264_amf":
            raise HardwareEncoderFailure(codec="h264_amf", stage="encode")
        return "ok"

    def broken_observer(_attempt):
        raise RuntimeError("UI callback failed")

    result = run_encoder_attempts(
        candidates,
        EncoderTargetSpec(1920, 1080, 60),
        lambda *_args: True,
        runner,
        ffmpeg_identity="ffmpeg-test-observer",
        cache=EncoderProbeCache(),
        on_attempt=broken_observer,
    )

    assert result.value == "ok"
    assert result.selected.codec == "libx264"


def test_cancellation_after_probe_prevents_full_export_attempt() -> None:
    cancelled = False
    runner_calls: list[str] = []

    def probe(_candidate, _spec):
        nonlocal cancelled
        cancelled = True
        return True

    def cancellation_check():
        if cancelled:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        run_encoder_attempts(
            (EncoderCandidate(codec="h264_amf", priority=0),),
            EncoderTargetSpec(1920, 1080, 60),
            probe,
            lambda candidate: runner_calls.append(candidate.codec),
            ffmpeg_identity="ffmpeg-test-cancel",
            cache=EncoderProbeCache(),
            cancellation_check=cancellation_check,
        )

    assert runner_calls == []
