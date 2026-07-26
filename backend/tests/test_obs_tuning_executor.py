import threading
import time
from types import SimpleNamespace

from app import obs_config_center
from app.obs_tuning import ObsTuningApplyRequest, ObsTuningGoal, build_change_plan, recommend
from app.obs_tuning_executor import _connect_for_tuning, apply_video_tuning_plan


def _discovery():
    return {
        "obs": {
            "connected": True,
            "active_profile": "CS2",
            "video": {
                "base_width": 2560,
                "base_height": 1440,
                "output_width": 2560,
                "output_height": 1440,
                "fps_num": 60,
                "fps_den": 1,
            },
            "recording": {"output_mode": "Simple", "encoder": "jim_nvenc", "format": "mkv", "rec_quality": "Small"},
        },
        "hardware": {
            "gpus": [{"name": "NVIDIA GeForce RTX 5070"}],
            "encoders": [
                {"id": "nvenc_h264", "label": "NVIDIA NVENC H.264", "codec": "h264"},
            ],
        },
        "limits": {"game_fps_p10": None},
        "ffmpeg": {"ffprobe_usable": True, "ffprobe_path": "C:/ffmpeg/ffprobe.exe"},
    }


def _request(discovery, goal=None):
    goal = goal or ObsTuningGoal(resolution="full-hd", fps=480)
    plan = build_change_plan(goal, discovery, recommend(goal, discovery))
    return ObsTuningApplyRequest(goal=goal, plan_hash=plan["plan_hash"])


def test_tuning_connection_uses_bounded_websocket_timeout(monkeypatch):
    captured = {}
    expected = object()

    def fake_connect(obs_cfg, *, timeout):
        captured["obs_cfg"] = obs_cfg
        captured["timeout"] = timeout
        return expected

    monkeypatch.setattr(obs_config_center, "_ws_connect", fake_connect)
    obs_cfg = object()

    assert _connect_for_tuning(obs_cfg) is expected
    assert captured == {"obs_cfg": obs_cfg, "timeout": 12.0}


def test_websocket_disconnect_cannot_block_http_result_forever():
    release = threading.Event()

    class Transport:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True
            release.set()

    class HungWs:
        def __init__(self):
            self.thread_recv = SimpleNamespace(running=True)
            self.ws = Transport()

        def disconnect(self):
            release.wait(5)

    ws = HungWs()
    started = time.monotonic()

    obs_config_center._ws_disconnect(ws, timeout=0.01)

    assert time.monotonic() - started < 0.5
    assert ws.thread_recv.running is False
    assert ws.ws.closed is True


class FakeWs:
    def __init__(self, video, *, active_request=None, accept_video=True, missing_status_request=None):
        self.video = dict(video)
        self.active_request = active_request
        self.accept_video = accept_video
        self.missing_status_request = missing_status_request
        self.disconnected = False
        self.recording_active = False
        self.output_path = "C:/recordings/obs-test.mp4"
        self.profile = {
            ("Output", "Mode"): "Simple",
            ("SimpleOutput", "RecEncoder"): "jim_nvenc",
            ("SimpleOutput", "RecFormat2"): "mkv",
            ("SimpleOutput", "RecQuality"): "Small",
        }
        self.stats_calls = 0

    @staticmethod
    def _payload(request):
        payload = getattr(request, "datain", None) or getattr(request, "data", None) or request.__dict__
        return payload() if callable(payload) else payload

    def call(self, request):
        name = type(request).__name__
        if name in {"GetRecordStatus", "GetStreamStatus", "GetReplayBufferStatus", "GetVirtualCamStatus"}:
            if name == self.missing_status_request:
                return SimpleNamespace(datain={}, status=False)
            active = self.recording_active if name == "GetRecordStatus" else name == self.active_request
            return SimpleNamespace(datain={"outputActive": active, "outputPath": self.output_path if not active else ""}, status=True)
        if name == "GetVideoSettings":
            return SimpleNamespace(datain={
                "baseWidth": self.video["base_width"],
                "baseHeight": self.video["base_height"],
                "outputWidth": self.video["output_width"],
                "outputHeight": self.video["output_height"],
                "fpsNumerator": self.video["fps_num"],
                "fpsDenominator": self.video["fps_den"],
            })
        if name == "SetVideoSettings":
            if self.accept_video:
                payload = self._payload(request)
                self.video = {
                    "base_width": int(payload["baseWidth"]),
                    "base_height": int(payload["baseHeight"]),
                    "output_width": int(payload["outputWidth"]),
                    "output_height": int(payload["outputHeight"]),
                    "fps_num": int(payload["fpsNumerator"]),
                    "fps_den": int(payload["fpsDenominator"]),
                }
            return SimpleNamespace(datain={})
        if name == "GetProfileParameter":
            payload = self._payload(request)
            return SimpleNamespace(datain={"parameterValue": self.profile.get((payload["parameterCategory"], payload["parameterName"]), "")})
        if name == "SetProfileParameter":
            payload = self._payload(request)
            self.profile[(payload["parameterCategory"], payload["parameterName"])] = str(payload["parameterValue"])
            return SimpleNamespace(datain={})
        if name == "GetStats":
            self.stats_calls += 1
            after = self.stats_calls > 1
            return SimpleNamespace(datain={
                "activeFps": self.video["fps_num"] if after else 60,
                "averageFrameRenderTime": 1.1,
                "renderSkippedFrames": 0,
                "renderTotalFrames": 4800 if after else 0,
                "outputSkippedFrames": 0,
                "outputTotalFrames": 4800 if after else 0,
                "cpuUsage": 12,
                "memoryUsage": 500,
                "availableDiskSpace": 100000,
            })
        if name == "StartRecord":
            self.recording_active = True
            return SimpleNamespace(datain={})
        if name == "StopRecord":
            self.recording_active = False
            return SimpleNamespace(datain={"outputPath": self.output_path})
        raise AssertionError(f"unexpected OBS request: {name}")


class StaleStatusAfterStopWs(FakeWs):
    """Models OBS returning a finalized path while the command socket is stale."""

    def __init__(self, video):
        super().__init__(video)
        self.stop_returned = False

    def call(self, request):
        name = type(request).__name__
        if name == "StopRecord":
            response = super().call(request)
            self.stop_returned = True
            return response
        if name == "GetRecordStatus" and self.stop_returned:
            return SimpleNamespace(datain={"outputActive": True, "outputPath": ""}, status=True)
        return super().call(request)


class NoPathStopWs(FakeWs):
    """Models OBS builds that expose the path only via GetRecordStatus."""

    def call(self, request):
        if type(request).__name__ == "StopRecord":
            self.recording_active = False
            return SimpleNamespace(datain={})
        return super().call(request)


def _run(discovery, request, ws, backup_calls, *, media_probe=None, log_reader=None):
    cfg = SimpleNamespace(obs=SimpleNamespace(host="localhost", port=4455, password=""))
    default_probe = lambda path, _ffprobe: {
        "path": path,
        "format_name": "mov,mp4",
        "duration_seconds": 10.0,
        "size_bytes": 1000,
        "video": {
            "codec_name": "h264",
            "width": ws.video["output_width"],
            "height": ws.video["output_height"],
            "r_frame_rate": f"{ws.video['fps_num']}/1",
            "avg_frame_rate": f"{ws.video['fps_num']}/1",
            "r_frame_rate_value": float(ws.video["fps_num"]),
            "avg_frame_rate_value": float(ws.video["fps_num"]),
        },
        "audio_tracks": [{"index": 1, "codec_name": "aac", "channels": 2, "sample_rate": "48000"}],
    }
    return apply_video_tuning_plan(
        cfg,
        request,
        discovery_loader=lambda _cfg: discovery,
        connection_factory=lambda _obs: ws,
        disconnect=lambda current: setattr(current, "disconnected", True),
        backup_creator=lambda: backup_calls.append(True) or {
            "id": "backup_1",
            "path": "C:/backup/backup_1",
            "profile": "CS2",
            "profile_dir": "CS2",
        },
        sleep_fn=lambda _seconds: None,
        media_probe=media_probe or default_probe,
        log_reader=log_reader or (lambda _started: {"available": True, "encoding_overload_mentions": 0, "render_lag_mentions": 0, "nvenc_mentions": 1}),
    )


def test_apply_preserves_canvas_and_sets_exact_integer_fps():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"])
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["ok"] is True, result
    assert result["status"] == "passed"
    assert backups == [True]
    assert result["actual"]["video"] == {
        "base_width": 2560,
        "base_height": 1440,
        "output_width": 1920,
        "output_height": 1080,
        "fps_num": 480,
        "fps_den": 1,
    }
    assert result["pending_checks"] == []
    assert result["validation"]["passed"] is True
    assert result["actual"]["recording"]["values"]["RecEncoder"] == "jim_nvenc"
    assert result["actual"]["recording"]["values"]["RecFormat2"] == "hybrid_mp4"
    assert ws.disconnected is True


def test_finalized_stop_response_does_not_wait_on_stale_command_socket():
    discovery = _discovery()
    ws = StaleStatusAfterStopWs(discovery["obs"]["video"])
    backups = []

    started = time.monotonic()
    result = _run(discovery, _request(discovery), ws, backups)

    assert time.monotonic() - started < 1.0
    assert result["status"] == "passed", result
    assert result["test_file"] == ws.output_path


def test_missing_stop_response_path_uses_fresh_status_confirmation():
    discovery = _discovery()
    ws = NoPathStopWs(discovery["obs"]["video"])
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["status"] == "passed", result
    assert result["test_file"] == ws.output_path


def test_stale_plan_stops_before_connecting_or_backing_up():
    discovery = _discovery()
    request = _request(discovery)
    request.plan_hash = "0" * 64
    ws = FakeWs(discovery["obs"]["video"])
    backups = []

    result = _run(discovery, request, ws, backups)

    assert result["status"] == "stale_plan"
    assert backups == []
    assert ws.disconnected is False


def test_active_obs_output_blocks_before_backup_and_write():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"], active_request="GetStreamStatus")
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["status"] == "output_active"
    assert "直播" in result["message"]
    assert backups == []
    assert ws.video["fps_num"] == 60


def test_unavailable_optional_output_does_not_block_idle_obs():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"], missing_status_request="GetVirtualCamStatus")
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["status"] == "passed", result
    assert backups == [True]


def test_missing_required_output_status_is_friendly_and_does_not_write():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"], missing_status_request="GetRecordStatus")
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["status"] == "precheck_failed"
    assert "outputActive" not in str(result)
    assert "录制状态" in result["events"][-1]["detail"]
    assert backups == []
    assert ws.video["fps_num"] == 60


def test_disconnected_obs_reports_connection_loss_before_plan_change():
    original = _discovery()
    request = _request(original)
    disconnected = _discovery()
    disconnected["obs"]["connected"] = False
    disconnected["obs"]["video"] = {
        "base_width": 0,
        "base_height": 0,
        "output_width": 0,
        "output_height": 0,
        "fps_num": 0,
        "fps_den": 1,
    }
    ws = FakeWs(original["obs"]["video"])
    backups = []

    result = _run(disconnected, request, ws, backups)

    assert result["status"] == "connection_lost"
    assert "没有连接到 OBS" in result["message"]
    assert backups == []
    assert ws.disconnected is False


def test_readback_mismatch_restores_previous_video_settings():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"], accept_video=False)
    backups = []

    result = _run(discovery, _request(discovery), ws, backups)

    assert result["status"] == "verification_failed"
    assert result["rolled_back"] is True
    assert result["actual"]["video"]["fps_num"] == 60
    assert backups == [True]


def test_unstable_test_keeps_requested_settings_and_reports_minimum_adjustment():
    discovery = _discovery()
    ws = FakeWs(discovery["obs"]["video"])
    backups = []

    result = _run(
        discovery,
        _request(discovery),
        ws,
        backups,
        media_probe=lambda path, _ffprobe: {
            "path": path,
            "video": {
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "r_frame_rate": "240/1",
                "avg_frame_rate": "240/1",
                "r_frame_rate_value": 240.0,
                "avg_frame_rate_value": 240.0,
            },
            "audio_tracks": [],
        },
    )

    assert result["status"] == "unstable"
    assert result["ok"] is False
    assert ws.video["fps_num"] == 480
    assert "不会自动" in result["validation"]["minimum_adjustment"]
    assert "未自动降级" in result["message"]


def test_backup_uses_active_profile_directory_not_display_name(tmp_path, monkeypatch):
    obs_root = tmp_path / "obs-studio"
    profile_dir = obs_root / "basic" / "profiles" / "cs2-profile-folder"
    profile_dir.mkdir(parents=True)
    (obs_root / "global.ini").write_text(
        "[Basic]\nCurrentProfile=CS2 高帧录制\nCurrentProfileDir=cs2-profile-folder\n",
        encoding="utf-8",
    )
    captured = {}
    monkeypatch.setattr(obs_config_center, "_obs_studio_root", lambda: obs_root)
    monkeypatch.setattr(
        obs_config_center,
        "_create_backup",
        lambda root, *, reason, project_profile: (
            captured.update({"root": root, "reason": reason, "profile": project_profile}) or "backup_2",
            tmp_path / "backup_2",
        ),
    )

    result = obs_config_center.create_active_profile_backup()

    assert captured["profile"] == "cs2-profile-folder"
    assert result["profile"] == "CS2 高帧录制"
    assert result["profile_dir"] == "cs2-profile-folder"
