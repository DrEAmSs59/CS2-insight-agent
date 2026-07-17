from app.env_utils import LLMConfig
from app.llm_compat import normalize_llm_base_url


def test_normalize_strips_chat_completions():
    url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    assert normalize_llm_base_url(url) == "https://open.bigmodel.cn/api/paas/v4"


def test_llm_config_validator():
    cfg = LLMConfig(
        model="glm-4.6v",
        base_url="https://open.bigmodel.cn/api/paas/v4/chat/completions",
    )
    assert cfg.base_url == "https://open.bigmodel.cn/api/paas/v4"
