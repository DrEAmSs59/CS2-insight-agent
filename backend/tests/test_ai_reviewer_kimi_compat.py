import asyncio
import json
from types import SimpleNamespace

from app.ai_reviewer import AIReviewer
from app.demo_parser import Clip


class _FakeCompletions:
    def __init__(self, calls):
        self.calls = calls

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        content = json.dumps({"score": 80, "comment": "测试锐评"}, ensure_ascii=False)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
        )


def _clip() -> Clip:
    return Clip(
        clip_id="clip-1",
        round=1,
        category="meme_death",
        weapon_used="ak47",
        kill_count=0,
        start_tick=100,
        end_tick=200,
    )


def test_kimi_reviewer_requests_always_use_temperature_one():
    calls = []
    reviewer = AIReviewer(
        api_key="test-key",
        base_url="https://example.test/v1",
        model_name="KIMI2.7",
    )
    reviewer._client = SimpleNamespace(
        chat=SimpleNamespace(completions=_FakeCompletions(calls)),
    )
    clip = _clip()

    async def exercise_all_review_paths():
        await reviewer._call_llm(clip, {})
        await reviewer.review_meme_montage({}, [clip])
        await reviewer.review_player_stats({"name": "tester"})

    asyncio.run(exercise_all_review_paths())

    assert len(calls) == 3
    assert [call["temperature"] for call in calls] == [1, 1, 1]
