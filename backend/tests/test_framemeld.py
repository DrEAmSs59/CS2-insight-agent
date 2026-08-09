"""FrameMeld process-boundary adapter tests."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.framemeld import (
    FRAMEMELD_DELIVERY_FPS,
    FRAMEMELD_STATUS_PREFIX,
    build_framemeld_command,
    framemeld_execution_policy,
    framemeld_failure_from_result,
    framemeld_sources_are_compatible,
    framemeld_working_fps,
    log_framemeld_diagnostic_events,
    probe_framemeld,
)
from app.features.lite_cut.runtime import normalize_project_body


class TestFrameMeld(unittest.TestCase):
    def setUp(self) -> None:
        from app import framemeld

        framemeld._probe_framemeld_cached.cache_clear()

    def test_source_family_validation_allows_reported_rate_drift(self):
        self.assertTrue(framemeld_sources_are_compatible([119.88, 120.0]))
        self.assertEqual(framemeld_working_fps([59.94, 60.0]), 60.0)
        self.assertFalse(framemeld_sources_are_compatible([60, 120]))
        self.assertFalse(framemeld_sources_are_compatible([60, None]))
        self.assertFalse(framemeld_sources_are_compatible([None]))

    def test_machine_readable_capability_uses_public_route(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "ffmpeg.exe"
            executable.write_bytes(b"test")
            result = SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "protocol": "org.framemeld.cli",
                        "api_version": 1,
                        "features": [
                            "host-managed-encoder-fallback",
                            "structured-status-json-v1",
                        ],
                    }
                ),
                stderr="",
            )
            with patch("app.framemeld.subprocess.run", return_value=result) as run:
                capability = probe_framemeld(executable)
            self.assertEqual(capability.route, "-framemeld")
            self.assertFalse(capability.legacy)
            self.assertIn("host-managed-encoder-fallback", capability.features)
            self.assertIn("structured-status-json-v1", capability.features)
            self.assertEqual(run.call_args.args[0][1:], ["-framemeld", "--capabilities-json"])

    def test_current_framemeld_build_uses_legacy_cli_route(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "ffmpeg.exe"
            executable.write_bytes(b"test")
            not_supported = SimpleNamespace(returncode=1, stdout="", stderr="unknown option")
            current_help = SimpleNamespace(
                returncode=0,
                stdout="FFmpeg Insight headless Blur mode\n",
                stderr="",
            )
            with patch(
                "app.framemeld.subprocess.run",
                side_effect=[not_supported, not_supported, current_help],
            ) as run:
                capability = probe_framemeld(executable)
            self.assertEqual(capability.route, "-blur")
            self.assertTrue(capability.legacy)
            self.assertEqual(run.call_count, 3)

    def test_standard_ffmpeg_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "standard-ffmpeg.exe"
            executable.write_bytes(b"test")
            result = SimpleNamespace(returncode=1, stdout="", stderr="unknown option")
            with patch("app.framemeld.subprocess.run", return_value=result):
                self.assertIsNone(probe_framemeld(executable))

    def test_command_leaves_render_policy_to_framemeld(self):
        from app.framemeld import FrameMeldCapability

        command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "libx264", "-crf", "18"],
            capability=FrameMeldCapability(
                route="-framemeld",
                api_version=1,
                features=frozenset({"host-managed-encoder-fallback"}),
            ),
        )
        self.assertEqual(command[1], "-framemeld")
        self.assertEqual(command[command.index("--performance-mode") + 1], "balanced")
        self.assertEqual(command[command.index("--blur-output-fps") + 1], str(FRAMEMELD_DELIVERY_FPS))
        for forbidden in (
            "--interpolate-fps",
            "--performance-samples",
            "--blur-amount",
            "--weighting",
            "--blur-gamma",
            "--deduplicate-method",
        ):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[command.index("-c:a") + 1], "copy")
        self.assertIn("--host-managed-encoder-fallback", command)

    def test_command_preserves_nvenc_device_binding_and_quality(self):
        from app.framemeld import FrameMeldCapability

        command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "h264_nvenc", "-gpu", "2", "-cq", "21"],
            capability=FrameMeldCapability(route="-blur", api_version=None, legacy=True),
        )
        self.assertEqual(command[command.index("-c:v") + 1], "h264_nvenc")
        self.assertEqual(command[command.index("-gpu") + 1], "2")
        self.assertEqual(command[command.index("-cq") + 1], "21")
        self.assertNotIn("--host-managed-encoder-fallback", command)
        self.assertNotIn("--status-json-lines", command)

    def test_amd_command_opts_into_structured_status_without_changing_nvenc(self):
        from app.framemeld import FrameMeldCapability

        capability = FrameMeldCapability(
            route="-framemeld",
            api_version=1,
            features=frozenset(
                {
                    "host-managed-encoder-fallback",
                    "structured-status-json-v1",
                }
            ),
        )
        amf_command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "h264_amf", "-qp_i", "20"],
            encoder_adapter=SimpleNamespace(
                name="AMD Radeon RX Test",
                vendor="amd",
                stable_id="luid:test",
                luid="test",
                device_id="DEV_TEST",
                driver_version="1.2.3",
                kind="discrete",
                enumeration_index=0,
                encoder_device_index=None,
            ),
            capability=capability,
        )
        nvenc_command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "h264_nvenc", "-cq", "20"],
            capability=capability,
        )
        self.assertIn("--status-json-lines", amf_command)
        adapter_payload = json.loads(
            amf_command[amf_command.index("--host-encoder-adapter-json") + 1]
        )
        self.assertEqual(adapter_payload["name"], "AMD Radeon RX Test")
        self.assertEqual(adapter_payload["stable_id"], "luid:test")
        self.assertEqual(adapter_payload["driver_version"], "1.2.3")
        self.assertNotIn("--status-json-lines", nvenc_command)

    def test_intel_qsv_command_uses_separate_precise_branch(self):
        from app.framemeld import FrameMeldCapability

        capability = FrameMeldCapability(
            route="-framemeld",
            api_version=1,
            features=frozenset(
                {
                    "host-managed-encoder-fallback",
                    "structured-status-json-v1",
                }
            ),
        )
        qsv_command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "h264_qsv", "-global_quality", "20"],
            encoder_adapter=SimpleNamespace(
                name="Intel Arc Test",
                vendor="intel",
                stable_id="luid:intel-test",
                luid="intel-test",
                device_id="DEV_INTEL_TEST",
                driver_version="2.3.4",
                kind="discrete",
                enumeration_index=1,
                encoder_device_index=None,
            ),
            capability=capability,
        )

        self.assertIn("--status-json-lines", qsv_command)
        adapter_payload = json.loads(
            qsv_command[qsv_command.index("--host-encoder-adapter-json") + 1]
        )
        self.assertEqual(adapter_payload["vendor"], "intel")
        self.assertEqual(adapter_payload["stable_id"], "luid:intel-test")
        policy = framemeld_execution_policy(qsv_command)
        self.assertIsNotNone(policy)
        self.assertEqual(policy.branch, "intel_qsv")
        self.assertEqual(policy.encoder, "h264_qsv")

    def test_precise_policy_requires_status_flag_and_supported_backend(self):
        self.assertIsNone(
            framemeld_execution_policy(["ffmpeg.exe", "-c:v", "h264_qsv", "output.mp4"])
        )
        self.assertIsNone(
            framemeld_execution_policy(
                [
                    "ffmpeg.exe",
                    "--status-json-lines",
                    "-c:v",
                    "h264_nvenc",
                    "output.mp4",
                ]
            )
        )

    def test_structured_failure_parser_returns_domain_and_devices(self):
        payload = {
            "protocol": "org.framemeld.status",
            "version": 1,
            "event": "pipeline_finished",
            "status": "failed",
            "failure_domain": "frame_engine",
            "encoder": "h264_amf",
            "devices": {
                "rife": {"index": 0, "selection": "default"},
                "encoder": {"backend": "h264_amf", "selection": "system-default"},
            },
            "vspipe_stderr_tail": "RIFE: failed to load model",
        }
        result = SimpleNamespace(
            stdout="",
            stderr="noise\n" + FRAMEMELD_STATUS_PREFIX + json.dumps(payload),
        )
        failure = framemeld_failure_from_result(result)
        self.assertIsNotNone(failure)
        self.assertEqual(failure.domain, "frame_engine")
        self.assertEqual(failure.encoder, "h264_amf")
        self.assertEqual(failure.devices["rife"]["index"], 0)
        self.assertIn("failed to load model", failure.detail)

    def test_diagnostic_events_are_forwarded_without_claiming_exact_binding(self):
        events = [
            {
                "protocol": "org.framemeld.status",
                "version": 1,
                "event": "device_mapping",
                "status": "candidate",
                "confidence": "medium",
                "exact_mapping_available": False,
            },
            {
                "protocol": "org.framemeld.status",
                "version": 1,
                "event": "encoder_binding",
                "status": "succeeded",
                "binding_state": "system_default_unverified",
                "binding_verified": False,
            },
            {
                "protocol": "org.framemeld.status",
                "version": 1,
                "event": "performance_summary",
                "status": "succeeded",
                "first_frame_observed": True,
                "first_frame_ms": 123,
                "first_packet_observed": True,
                "first_packet_ms": 456,
            },
        ]
        with patch("app.framemeld.export_event") as emit:
            log_framemeld_diagnostic_events(events, branch="amd_amf")

        emitted_names = [call.args[0] for call in emit.call_args_list]
        self.assertEqual(
            emitted_names,
            [
                "device_mapping",
                "encoder_binding",
                "performance_summary",
                "first_frame",
                "first_packet",
            ],
        )
        mapping_fields = emit.call_args_list[0].kwargs
        self.assertFalse(mapping_fields["exact_mapping_available"])
        self.assertEqual(mapping_fields["branch"], "amd_amf")

    def test_lite_cut_schema_keeps_only_new_framemeld_switch(self):
        body = normalize_project_body(
            {
                "schema_version": 2,
                "output": {
                    "fps": 120,
                    "framemeld_enabled": True,
                    "frame_blend_enabled": True,
                    "frame_blend_frames": 7,
                    "delivery_fps": 120,
                },
                "tracks": [],
            }
        )
        self.assertTrue(body["output"]["framemeld_enabled"])
        self.assertNotIn("frame_blend_enabled", body["output"])
        self.assertNotIn("frame_blend_frames", body["output"])
        self.assertNotIn("delivery_fps", body["output"])


if __name__ == "__main__":
    unittest.main()
