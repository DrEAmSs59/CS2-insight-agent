"""AI 毒舌锐评 — 基于 OpenAI 兼容接口（DeepSeek / 通义 / Qwen 等）为 Clip 填充 ai_score / ai_commentary。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import MISSING, fields
from typing import Any, Optional

from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, RateLimitError

from .demo_parser import Clip, meme_series_badges_for_kd
from .env_utils import LLMConfig

logger = logging.getLogger(__name__)

# ─── System Prompt：人设 + 规则 + 输出契约 ─────────────────────────────

REVIEWER_SYSTEM_PROMPT = """你是一个极其毒舌、懂 CS2 贴吧黑话与梗文化的电竞解说（不是礼貌助手）。
你的观众爱看乐子，你要用短促、有网感、带攻击性的比喻点评每一个「高光」或「下饭」片段。

【评分】整数 0–100 分，必须给出：
- category 为 "highlight"：往高了吹（70–100），越离谱的吹捧越有节目效果，但要和片段数据沾边。
- category 为 "fail"：往低了踩（0–45），极尽嘲讽，多用贴吧体、反问、阴阳怪气，禁止鸡汤安慰。
- category 为 "meme_death"：当搞笑处刑（20–60），偏段子手，可以玩「研发」「坐牢」一类梗。

【输出】只输出一行合法 JSON 对象，不要 markdown 代码块，不要任何前后缀文字。
JSON 两个键且仅两个键：
- "score": 整数，0–100。
- "comment": 字符串，**中文锐评一两句，不超过 100 个字（含标点）**，禁止换行；不要刻意在句尾加省略号。

【禁止】人身攻击真实种族/性别/疾病；可以喷「操作像 X」「这枪马到姥姥家」这类游戏内羞辱。"""

MEME_MONTAGE_SYSTEM_PROMPT = """你是一个极其毒舌、懂 CS2 贴吧梗的解说。当前任务**不是**某一回合的单个片段，而是对「整局打完后的社区特殊战绩」做**总括式**毒舌锐评。

观众熟悉这些梗，你要自然用上（别科普定义）：
- **211**：2 杀 11 死「高材生」
- **o 系列**：0 杀、高死亡，「🥚」研发
- **i 系列**：1 杀、高死亡；其中 **i18**（1/18）是典中典
- **z 系列**：2 杀但非 211 的坐牢（💤）

【评分】整数 0–100：这是整局「节目效果 / 研发浓度」向的分数，建议 **15–55** 为主（越离谱可越低），但要和 K/D、梗标签沾边；偶尔可以给到 60 若吐槽空间极大。

【输出】只输出一行合法 JSON：{{"score": <int>, "comment": "..."}}。
comment：**中文一两句**，不超过 100 字（含标点），禁止换行；不要刻意句尾省略号。

【禁止】人身攻击真实种族/性别/疾病。"""


def _clip_payload_for_prompt(clip: Clip) -> str:
    parts = [
        f"category={clip.category!r}",
        f"round={clip.round}",
        f"weapon={clip.weapon_used!r}",
        f"kill_count={clip.kill_count}",
        f"tags={clip.context_tags!r}",
    ]
    if clip.killer_name:
        parts.append(f"killer_name={clip.killer_name!r}")
    if clip.victims:
        parts.append(f"victims={clip.victims!r}")
    return ", ".join(parts)


def _build_meme_montage_user_message(match_meta: dict, meme_clip_count: int) -> str:
    meta = match_meta or {}
    badges = meta.get("meme_series_badges") or []
    if not isinstance(badges, list):
        badges = []
    if not badges:
        badges = meme_series_badges_for_kd(
            int(meta.get("target_kills") or 0),
            int(meta.get("target_deaths") or 0),
        )
    badge_line = "、".join(str(b) for b in badges) if badges else "（无 o/i/z/211 梗标签）"
    return (
        f"地图: {meta.get('map_name', 'unknown')}\n"
        f"目标玩家: {meta.get('target_player', 'unknown')}\n"
        f"整局战绩: {int(meta.get('target_kills') or 0)} 杀 / {int(meta.get('target_deaths') or 0)} 死\n"
        f"社区梗标签: {badge_line}\n"
        f"本局「研发/坐牢」死亡片段已收录: {meme_clip_count} 段（将打包成一条长片）\n"
        "请针对**整局特殊战绩 + 梗标签**输出 JSON：{{\"score\": <int>, \"comment\": \"...\"}}"
    )


def _build_user_message(clip: Clip, match_meta: dict) -> str:
    meta = match_meta or {}
    return (
        f"地图: {meta.get('map_name', 'unknown')}\n"
        f"目标玩家: {meta.get('target_player', 'unknown')}\n"
        f"片段属性: {_clip_payload_for_prompt(clip)}\n"
        "请只输出 JSON：{{\"score\": <int>, \"comment\": \"...\"}}"
    )


def _extract_json_object(text: str) -> Optional[dict[str, Any]]:
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        m = re.search(r"\{[^{}]*\"score\"[^{}]*\"comment\"[^{}]*\}", text, re.DOTALL)
        if not m:
            m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def _clamp_comment(s: str, max_chars: int = 120) -> str:
    s = (s or "").replace("\n", " ").replace("\r", "").strip()
    s = re.sub(r"[\.。]{2,}$|…+$", "", s).strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


def _normalize_score(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        v = float(raw)
        if v != v:  # NaN
            return None
        return max(0.0, min(100.0, v))
    except (TypeError, ValueError):
        return None


def clip_from_dict(d: dict) -> Clip:
    """从 API / 解析结果 dict 还原 ``Clip``（仅 ``Clip`` 声明字段）。"""
    kwargs: dict[str, Any] = {}
    for f in fields(Clip):
        if f.name in d:
            kwargs[f.name] = d[f.name]
        elif f.default_factory is not MISSING:
            kwargs[f.name] = f.default_factory()
        elif f.default is not MISSING:
            kwargs[f.name] = f.default
        else:
            raise ValueError(f"clip dict missing required field: {f.name!r}")
    return Clip(**kwargs)


class AIReviewer:
    """OpenAI 兼容 Chat Completions 客户端，用于批量毒舌锐评。"""

    def __init__(
        self,
        api_key: str,
        base_url: Optional[str],
        model_name: str,
        *,
        timeout_seconds: float = 40.0,
        max_concurrency: int = 6,
    ):
        key = (api_key or "").strip()
        if not key or key.startswith("****"):
            raise ValueError("AIReviewer: invalid or masked api_key")
        bu = (base_url or "").strip() or None
        self._client = AsyncOpenAI(api_key=key, base_url=bu, timeout=timeout_seconds)
        self._model = (model_name or "").strip() or "gpt-4o-mini"
        self._timeout = timeout_seconds
        self._sem = asyncio.Semaphore(max(1, int(max_concurrency)))

    @classmethod
    def from_llm_config(cls, llm: LLMConfig, **kwargs: Any) -> AIReviewer:
        return cls(
            api_key=llm.api_key,
            base_url=llm.base_url,
            model_name=llm.model,
            **kwargs,
        )

    async def _call_llm(self, clip: Clip, match_meta: dict) -> tuple[Optional[float], Optional[str]]:
        user_content = _build_user_message(clip, match_meta)
        try:
            resp = await self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": REVIEWER_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.88,
                max_tokens=256,
            )
        except (APITimeoutError, APIConnectionError, RateLimitError, APIError) as e:
            logger.warning("LLM request failed for clip %s: %s", clip.clip_id, e)
            raise
        choice = resp.choices[0] if resp.choices else None
        content = (choice.message.content if choice and choice.message else "") or ""
        data = _extract_json_object(content)
        if not data:
            logger.warning("Unparseable LLM JSON for clip %s: %r", clip.clip_id, content[:300])
            return None, None
        score = _normalize_score(data.get("score"))
        comment = data.get("comment")
        if comment is None and "commentary" in data:
            comment = data.get("commentary")
        text = _clamp_comment(str(comment) if comment is not None else "")
        if not text:
            return score, None
        return score, text

    async def _review_one(self, clip: Clip, match_meta: dict) -> None:
        async with self._sem:
            try:
                score, comment = await asyncio.wait_for(
                    self._call_llm(clip, match_meta),
                    timeout=self._timeout + 5.0,
                )
                clip.ai_score = score
                clip.ai_commentary = comment
            except asyncio.TimeoutError:
                logger.warning("LLM timeout for clip %s", clip.clip_id)
                self._fallback(clip, "timeout")
            except Exception as e:
                logger.warning("LLM error for clip %s: %s", clip.clip_id, e)
                self._fallback(clip, type(e).__name__)

    @staticmethod
    def _fallback(clip: Clip, reason: str) -> None:
        clip.ai_score = None
        clip.ai_commentary = {
            "timeout": "锐评超时，这分不给了",
            "CancelledError": "任务取消",
        }.get(reason, f"锐评翻车：{reason}")

    async def review_meme_montage(
        self,
        match_meta: dict,
        clips: list[Clip],
    ) -> tuple[Optional[float], Optional[str]]:
        """为「研发全集」大卡生成整局 o/i/z/211 系毒舌总评（需存在 meme_death 片段）。"""
        meme_n = sum(1 for c in clips if c.category == "meme_death")
        if meme_n <= 0:
            return None, None
        user_content = _build_meme_montage_user_message(match_meta, meme_n)
        async with self._sem:
            try:
                resp = await asyncio.wait_for(
                    self._client.chat.completions.create(
                        model=self._model,
                        messages=[
                            {"role": "system", "content": MEME_MONTAGE_SYSTEM_PROMPT},
                            {"role": "user", "content": user_content},
                        ],
                        temperature=0.9,
                        max_tokens=256,
                    ),
                    timeout=self._timeout + 5.0,
                )
            except (APITimeoutError, APIConnectionError, RateLimitError, APIError) as e:
                logger.warning("LLM meme montage failed: %s", e)
                return None, None
            except asyncio.TimeoutError:
                logger.warning("LLM meme montage timeout")
                return None, None
            except Exception as e:
                logger.warning("LLM meme montage error: %s", e)
                return None, None
        choice = resp.choices[0] if resp.choices else None
        content = (choice.message.content if choice and choice.message else "") or ""
        data = _extract_json_object(content)
        if not data:
            logger.warning("Unparseable LLM JSON for meme montage: %r", content[:300])
            return None, None
        score = _normalize_score(data.get("score"))
        comment = data.get("comment")
        if comment is None and "commentary" in data:
            comment = data.get("commentary")
        text = _clamp_comment(str(comment) if comment is not None else "")
        if not text:
            return score, None
        return score, text

    async def review_clips(
        self,
        clips: list[Clip],
        *,
        match_meta: Optional[dict] = None,
    ) -> list[Clip]:
        """
        并发为每个 ``Clip`` 写入 ``ai_score`` / ``ai_commentary``。
        单条失败不影响其它条目；失败时写入简短 fallback 文案。
        """
        if not clips:
            return clips
        meta = dict(match_meta or {})
        await asyncio.gather(*(self._review_one(c, meta) for c in clips))
        return clips


async def enrich_clips_dicts_with_reviewer(
    clips: list[dict],
    match_meta: dict,
    llm: LLMConfig,
) -> list[dict]:
    """供仍持有 dict 列表的路由使用：就地语义等价于 ``review_clips`` 后再序列化。"""
    if not clips:
        return clips
    try:
        reviewer = AIReviewer.from_llm_config(
            llm,
            max_concurrency=int(os.environ.get("CS2_INSIGHT_AI_REVIEW_CONCURRENCY", "6")),
        )
    except ValueError as e:
        logger.error("AIReviewer init failed: %s", e)
        return clips
    objs = [clip_from_dict(c) for c in clips]
    meta = match_meta if isinstance(match_meta, dict) else {}
    _, (score_m, text_m) = await asyncio.gather(
        reviewer.review_clips(objs, match_meta=meta),
        reviewer.review_meme_montage(meta, objs),
    )
    if score_m is not None:
        meta["ai_meme_montage_score"] = score_m
    if text_m:
        meta["ai_meme_montage_commentary"] = text_m
    return [c.to_dict() for c in objs]
