"""Shared OpenAI-compatible LLM helpers (base URL normalization, Zhipu GLM quirks)."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# H4 fix: 已知 LLM 服务提供商域名白名单
_KNOWN_LLM_PROVIDER_HOSTS: frozenset[str] = frozenset({
    # OpenAI
    "api.openai.com",
    # 智谱 AI
    "open.bigmodel.cn",
    # DeepSeek
    "api.deepseek.com",
    # 月之暗面 / Kimi
    "api.moonshot.cn",
    # 阿里百炼
    "dashscope.aliyuncs.com",
    # 百度千帆
    "aip.baidubce.com",
    # Anthropic
    "api.anthropic.com",
    # Groq
    "api.groq.com",
    # 零一万物
    "api.lingyiwanwu.com",
    # 火山引擎 (字节)
    "ark.cn-beijing.volces.com",
    # SiliconFlow
    "api.siliconflow.cn",
    # Together AI
    "api.together.xyz",
})


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


def validate_llm_base_url(base_url: Optional[str]) -> None:
    """H4 fix: 检查 LLM base_url 安全性，对非 HTTPS 的未知远程域名记录警告。

    仅记录 warning 日志，不拦截请求 — 尊重用户对本地工具的配置自主权。
    后续可在前端保存配置时添加确认弹窗。
    """
    raw = (base_url or "").strip()
    if not raw:
        return
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parsed = urlparse(raw)
    except ValueError:
        logger.warning("LLM base_url 解析失败: %r", base_url)
        return
    host = (parsed.hostname or "").lower()
    # localhost 不受限制
    if host in ("localhost", "127.0.0.1", "::1") or host.endswith(".localhost"):
        return
    # 已知提供商域名始终允许
    if host in _KNOWN_LLM_PROVIDER_HOSTS:
        return
    # 未知的远程域名未使用 HTTPS 时记录警告
    if parsed.scheme != "https":
        logger.warning(
            "LLM base_url '%s' 未使用 HTTPS，API Key 将以明文传输。"
            "建议使用 HTTPS 或在提供商白名单中确认该域名。",
            base_url,
        )


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
