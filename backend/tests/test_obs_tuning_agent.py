import asyncio
import json
from types import SimpleNamespace

from app.env_utils import LLMConfig
from app.obs_tuning import ObsTuningGoal, recommend
from app.obs_tuning_agent import OBS_TUNING_SYSTEM_PROMPT, review_tuning_plan


def _discovery():
    return {
        "obs": {
            "connected": True,
            "version": "32.0.0",
            "video": {"base_width": 2560, "base_height": 1440, "output_width": 2560, "output_height": 1440, "fps_num": 60, "fps_den": 1},
            "recording": {"output_mode": "Simple", "encoder": "jim_nvenc", "format": "hybrid_mp4"},
        },
        "hardware": {
            "cpu": "Test CPU",
            "memory_gb": 32,
            "gpus": [{"name": "NVIDIA GeForce RTX 5070", "memory_mb": 12288}],
            "encoders": [{"id": "nvenc_h264", "label": "NVIDIA NVENC H.264", "codec": "h264"}],
        },
        "disk": {"free_gb": 500},
        "ffmpeg": {"ffprobe_usable": True},
        "limits": {"game_fps_p10": None},
    }


class FakeCompletions:
    def __init__(self, captured):
        self.captured = captured

    async def create(self, **kwargs):
        self.captured.update(kwargs)
        content = json.dumps({
            "summary": "可以尝试，但必须先做真实短录制。",
            "recommendation": "recommended_with_test",
            "reasons": ["RTX 5070 支持 NVENC H.264"],
            "risks": ["480 FPS 帧时间预算很小"],
            "safer_option_reason": "240 FPS 余量更高",
            "confidence": "medium",
        }, ensure_ascii=False)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class FakeClient:
    def __init__(self, captured):
        self.chat = SimpleNamespace(completions=FakeCompletions(captured))


def test_ai_review_uses_structured_prompt_and_never_changes_goal():
    captured = {}
    goal = ObsTuningGoal(resolution="current", fps=480)
    discovery = _discovery()

    result = asyncio.run(review_tuning_plan(
        LLMConfig(model="deepseek-v4-flash", api_key="secret", base_url="https://api.deepseek.com"),
        goal,
        discovery,
        recommend(goal, discovery),
        client_factory=lambda **_kwargs: FakeClient(captured),
    ))

    assert result["used"] is True
    assert result["recommendation"] == "recommended_with_test"
    assert captured["messages"][0]["content"] == OBS_TUNING_SYSTEM_PROMPT
    assert '"fps":480' in captured["messages"][1]["content"]
    assert "Shell 命令" in OBS_TUNING_SYSTEM_PROMPT
    assert captured["response_format"] == {"type": "json_object"}
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "target" not in result


def test_ai_review_retries_once_when_first_response_is_incomplete():
    calls = []

    class RetryCompletions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                content = json.dumps({"summary": "可以测试"}, ensure_ascii=False)
            else:
                content = json.dumps({
                    "summary": "可以测试，但要看真实短录制结果。",
                    "recommendation": "recommended_with_test",
                    "reasons": ["支持 NVENC"],
                    "risks": ["480 FPS 压力较高"],
                    "safer_option_reason": "",
                    "confidence": "medium",
                }, ensure_ascii=False)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])

    goal = ObsTuningGoal(fps=480)
    discovery = _discovery()
    result = asyncio.run(review_tuning_plan(
        LLMConfig(model="deepseek-v4-flash", api_key="secret", base_url="https://api.deepseek.com"),
        goal,
        discovery,
        recommend(goal, discovery),
        client_factory=lambda **_kwargs: SimpleNamespace(chat=SimpleNamespace(completions=RetryCompletions())),
    ))

    assert result["used"] is True
    assert result["prompt_version"] == "obs_tuning_v2"
    assert len(calls) == 2
    assert "上一次回答没有通过结构校验" in calls[1]["messages"][-1]["content"]


def test_ai_review_explicitly_falls_back_when_model_is_not_configured():
    goal = ObsTuningGoal(fps=240)
    discovery = _discovery()

    result = asyncio.run(review_tuning_plan(
        LLMConfig(),
        goal,
        discovery,
        recommend(goal, discovery),
    ))

    assert result["used"] is False
    assert result["status"] == "not_configured"
    assert "本机规则" in result["message"]
