"""LLM review layer for OBS tuning plans.

The model may explain risk and suggest a safer alternative, but it never emits
commands and never controls OBS. The deterministic planner and executor remain
the source of truth for every value that can be applied.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Callable, Literal, Optional

from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, RateLimitError
from pydantic import BaseModel, Field, ValidationError

from .env_utils import LLMConfig, llm_base_url_is_local_host
from .llm_compat import completion_extra_body, completion_temperature, message_text, normalize_llm_base_url
from .obs_tuning import ObsTuningGoal

logger = logging.getLogger(__name__)


OBS_TUNING_SYSTEM_PROMPT = """你是 CS2 Insight 的 OBS 录制调优规划 Agent。

你只负责根据用户选择的输出分辨率、整数 FPS，以及经过脱敏的本机 OBS、GPU、硬件编码器、磁盘和 FFmpeg 信息，解释风险并生成结构化建议。

必须遵守：
1. 不生成或执行 Shell 命令，不直接修改文件、注册表或 OBS。
2. 不建议修改场景、来源、音频采样率、声道、音轨映射、直播平台、推流密钥或 WebSocket 密码。
3. 用户目标必须原样保留；不得静默降低分辨率或 FPS。保守方案只能作为额外建议。
4. 整数 FPS 必须使用 fps_num=<目标>、fps_den=1。
5. 优先考虑 NVIDIA NVENC H.264 的兼容性；但不得把硬件推断说成已经实测通过。
6. 推荐只是预测。只有短录制、ffprobe、OBS Stats 和日志均完成后，才能声称稳定。
7. 用户只需要选择分辨率和 FPS；不要追问用途、画质偏好或其他专业术语。
8. 只能输出一个 JSON 对象，不要 Markdown，不要额外文字。

JSON 格式：
{
  "summary": "面向普通玩家的一句话结论",
  "recommendation": "recommended|recommended_with_test|experimental|not_recommended",
  "reasons": ["最多三条简短原因"],
  "risks": ["最多三条明确风险"],
  "safer_option_reason": "为什么保守方案更稳，若无需则为空字符串",
  "confidence": "low|medium|high"
}
"""


class ObsTuningAiReview(BaseModel):
    summary: str = Field(min_length=1, max_length=240)
    recommendation: Literal[
        "recommended",
        "recommended_with_test",
        "experimental",
        "not_recommended",
    ]
    reasons: list[str] = Field(default_factory=list, max_length=3)
    risks: list[str] = Field(default_factory=list, max_length=3)
    safer_option_reason: str = Field(default="", max_length=240)
    confidence: Literal["low", "medium", "high"] = "low"


def _extract_json_object(text: str) -> Optional[dict[str, Any]]:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def _api_key(llm: LLMConfig) -> str:
    key = (llm.api_key or "").strip()
    if key.startswith("****"):
        raise ValueError("AI API Key 只是脱敏占位符，请在设置中重新填写")
    if not key and llm_base_url_is_local_host(llm.base_url):
        return (os.environ.get("CS2_INSIGHT_LOCAL_LLM_API_KEY") or "local").strip() or "local"
    if not key:
        raise ValueError("尚未配置 AI API Key")
    return key


def _supports_json_object_output(model: str, base_url: Optional[str]) -> bool:
    """Use provider JSON mode only where the configured API documents it."""
    marker = f"{model} {base_url or ''}".lower()
    return any(item in marker for item in ("deepseek", "api.openai.com"))


def _sanitized_payload(
    goal: ObsTuningGoal,
    discovery: dict[str, Any],
    recommendation: dict[str, Any],
) -> dict[str, Any]:
    obs = discovery.get("obs") or {}
    hardware = discovery.get("hardware") or {}
    recording = obs.get("recording") or {}
    return {
        "goal": goal.model_dump(),
        "obs": {
            "version": obs.get("version"),
            "connected": bool(obs.get("connected")),
            "video": obs.get("video") or {},
            "recording": {
                "output_mode": recording.get("output_mode"),
                "encoder": recording.get("encoder"),
                "format": recording.get("format"),
            },
        },
        "hardware": {
            "cpu": hardware.get("cpu"),
            "memory_gb": hardware.get("memory_gb"),
            "gpus": hardware.get("gpus") or [],
            "encoders": hardware.get("encoders") or [],
        },
        "disk_free_gb": (discovery.get("disk") or {}).get("free_gb"),
        "ffprobe_available": bool((discovery.get("ffmpeg") or {}).get("ffprobe_usable")),
        "deterministic_assessment": {
            "score": recommendation.get("score"),
            "level": recommendation.get("level"),
            "loads": recommendation.get("loads"),
            "risks": recommendation.get("risks"),
            "target": recommendation.get("target"),
            "safer_start": recommendation.get("safer_start"),
        },
    }


async def review_tuning_plan(
    llm: LLMConfig,
    goal: ObsTuningGoal,
    discovery: dict[str, Any],
    recommendation: dict[str, Any],
    *,
    timeout_seconds: float = 35.0,
    client_factory: Callable[..., Any] = AsyncOpenAI,
) -> dict[str, Any]:
    """Return an auditable LLM review, or an explicit rule-based fallback status."""
    model = (llm.model or "").strip()
    if not model:
        return {
            "used": False,
            "status": "not_configured",
            "message": "尚未配置 AI 模型，本次使用本机规则生成建议。",
            "prompt_version": "obs_tuning_v2",
        }
    try:
        key = _api_key(llm)
    except ValueError as exc:
        return {
            "used": False,
            "status": "not_configured",
            "message": str(exc) + "，本次使用本机规则生成建议。",
            "prompt_version": "obs_tuning_v2",
        }

    base_url = normalize_llm_base_url(llm.base_url)
    client = client_factory(api_key=key, base_url=base_url, timeout=timeout_seconds)
    user_message = "请评估以下 OBS 录制目标：\n" + json.dumps(
        _sanitized_payload(goal, discovery, recommendation),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": OBS_TUNING_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": completion_temperature(model, base_url, 0.15),
        "max_tokens": 900,
    }
    if _supports_json_object_output(model, base_url):
        kwargs["response_format"] = {"type": "json_object"}
    extra_body = completion_extra_body(model, base_url)
    if "deepseek" in f"{model} {base_url or ''}".lower():
        extra_body = {**(extra_body or {}), "thinking": {"type": "disabled"}}
    if extra_body:
        kwargs["extra_body"] = extra_body
    try:
        invalid_response: Optional[Exception] = None
        deadline = asyncio.get_running_loop().time() + timeout_seconds + 5.0
        for attempt in range(2):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 1.0:
                raise asyncio.TimeoutError
            request_kwargs = dict(kwargs)
            if attempt:
                request_kwargs["messages"] = [
                    *kwargs["messages"],
                    {
                        "role": "user",
                        "content": "上一次回答没有通过结构校验。请重新回答，并且只输出与示例字段完全一致的 JSON 对象。",
                    },
                ]
            response = await asyncio.wait_for(
                client.chat.completions.create(**request_kwargs),
                timeout=remaining,
            )
            choice = response.choices[0] if response.choices else None
            parsed = _extract_json_object(message_text(choice.message if choice else None))
            try:
                if not parsed:
                    raise ValueError("AI 返回内容不是有效 JSON")
                review = ObsTuningAiReview.model_validate(parsed)
            except (ValidationError, ValueError) as exc:
                invalid_response = exc
                continue
            return {
                "used": True,
                "status": "completed",
                "message": "AI 已结合本机配置完成分析。",
                "model": model,
                "prompt_version": "obs_tuning_v2",
                **review.model_dump(),
            }
        raise invalid_response or ValueError("AI 没有返回可用内容")
    except (APITimeoutError, APIConnectionError, RateLimitError, APIError, asyncio.TimeoutError) as exc:
        logger.warning("OBS tuning AI review failed: %s", exc)
        message = "AI 连接暂时不可用，已经改用本机检测结果生成设置；不影响后面的真实录制测试。"
        reason_code = "service_unavailable"
    except (ValidationError, ValueError, IndexError) as exc:
        logger.warning("OBS tuning AI response invalid: %s", exc)
        message = "AI 这次没有返回可用结论，已经改用本机检测结果生成设置；不影响后面的真实录制测试。"
        reason_code = "invalid_response"
    except Exception as exc:  # noqa: BLE001
        logger.warning("OBS tuning AI review unexpected error: %s", exc)
        message = "AI 本次分析没有完成，已经改用本机检测结果生成设置；不影响后面的真实录制测试。"
        reason_code = "unexpected_error"
    return {
        "used": False,
        "status": "fallback",
        "message": message,
        "reason_code": reason_code,
        "model": model,
        "prompt_version": "obs_tuning_v2",
    }
