"""Shared OpenAI-compatible LLM helpers (base URL normalization, Zhipu GLM quirks)."""

from __future__ import annotations

import json
from typing import Any, Optional


def normalize_llm_base_url(base_url: Optional[str]) -> Optional[str]:
    """Strip trailing /chat/completions so the OpenAI SDK does not double-append the path."""
    raw = (base_url or "").strip()
    if not raw:
        return None
    raw = raw.rstrip("/")
    for suffix in ("/chat/completions", "/completions"):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)].rstrip("/")
    return raw or None


def is_zhipu_glm_model(model: str, base_url: Optional[str]) -> bool:
    m = (model or "").lower()
    u = (base_url or "").lower()
    return "glm" in m or "bigmodel.cn" in u


def completion_extra_body(model: str, base_url: Optional[str]) -> Optional[dict[str, Any]]:
    """GLM thinking mode puts JSON in reasoning_content; disable for chat completions."""
    if is_zhipu_glm_model(model, base_url):
        return {"thinking": {"type": "disabled"}}
    return None


def message_text(message) -> str:
    """OpenAI content + Zhipu GLM reasoning_content / model_extra fallback."""
    if message is None:
        return ""
    content = getattr(message, "content", None) or ""
    if isinstance(content, str) and content.strip():
        return content.strip()
    reasoning = getattr(message, "reasoning_content", None) or ""
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning.strip()
    extra = getattr(message, "model_extra", None) or {}
    if isinstance(extra, dict):
        for key in ("reasoning_content", "reasoning"):
            val = extra.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return str(content or "").strip()


def ai_review_fallback_message(reason: str) -> str:
    """User-facing AI review failure text."""
    known = {
        "timeout": "锐评超时，这分不给了",
        "CancelledError": "任务取消",
        "NotFoundError": (
            "锐评接口 404：请检查模型名与 Base URL（勿带 /chat/completions，"
            "智谱示例 https://open.bigmodel.cn/api/paas/v4）"
        ),
        "AuthenticationError": "锐评鉴权失败：请检查 API Key",
        "RateLimitError": "锐评触发限流，稍后再试",
    }
    return known.get(reason, f"锐评翻车：{reason}")
