"""洞察智能体网关 - LLM 调用与评分/文案生成"""

from __future__ import annotations

import json
import logging
from typing import Optional

import litellm

from .env_utils import LLMConfig

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是一位专业且带点阴阳怪气的 CS2 赛事导播兼解说。
你需要对每一个比赛片段进行精准打分 (0-100) 并撰写一段犀利锐评。

规则：
- 对于 category 为 "highlight" 的高光片段，采用**专业且热血**的解说风格，像电竞赛事的激情解说一样。
- 对于 category 为 "fail" 的下饭片段，采用**嘲讽/幽默**的抖音短视频旁白风格，可以适当阴阳怪气。
- 评分标准：ACE = 90+, 4K = 75-89, 3K = 60-74, 精彩 Fail = 40-59, 普通 Fail = 10-39。
- 输出必须严格为 JSON 格式：{"score": <int>, "commentary": "<string>"}
- commentary 长度控制在 20-80 个中文字符。"""


def _build_user_prompt(clip: dict, match_meta: dict) -> str:
    return (
        f"地图: {match_meta.get('map', 'unknown')}, "
        f"目标玩家: {match_meta.get('target_player', 'unknown')}\n"
        f"回合: {clip['round']}, 类型: {clip['category']}, "
        f"武器: {clip['weapon_used']}, 击杀数: {clip['kill_count']}, "
        f"标签: {clip.get('context_tags', [])}"
    )


def _parse_llm_response(raw: str) -> tuple[Optional[float], Optional[str]]:
    """Try to extract score and commentary from LLM output."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`").removeprefix("json").strip()
    try:
        data = json.loads(raw)
        return float(data["score"]), str(data["commentary"])
    except (json.JSONDecodeError, KeyError, ValueError):
        logger.warning("Failed to parse LLM response: %s", raw[:200])
        return None, raw[:200] if raw else None


async def enrich_clip_with_ai(clip: dict, match_meta: dict, llm_config: LLMConfig) -> dict:
    """Call LLM to generate score and commentary for a single clip."""
    model_name = f"{llm_config.provider}/{llm_config.model}" if llm_config.provider else llm_config.model

    try:
        response = await litellm.acompletion(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(clip, match_meta)},
            ],
            api_key=llm_config.api_key,
            api_base=llm_config.base_url,
            temperature=0.8,
            max_tokens=256,
        )
        content = response.choices[0].message.content or ""
        score, commentary = _parse_llm_response(content)
        clip["ai_score"] = score
        clip["ai_commentary"] = commentary
    except Exception as e:
        logger.error("LLM call failed for clip %s: %s", clip.get("clip_id"), e)
        clip["ai_score"] = None
        clip["ai_commentary"] = f"AI 分析失败: {type(e).__name__}"

    return clip


async def enrich_all_clips(clips: list[dict], match_meta: dict, llm_config: LLMConfig) -> list[dict]:
    """Sequentially enrich all clips with AI insights."""
    enriched = []
    for clip in clips:
        enriched.append(await enrich_clip_with_ai(clip, match_meta, llm_config))
    return enriched
