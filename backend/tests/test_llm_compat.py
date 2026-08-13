from app.env_utils import LLMConfig
from app.llm_compat import completion_temperature, normalize_llm_base_url


def test_normalize_strips_chat_completions():
    url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    assert normalize_llm_base_url(url) == "https://open.bigmodel.cn/api/paas/v4"


def test_llm_config_validator():
    cfg = LLMConfig(
        model="glm-4.6v",
        base_url="https://open.bigmodel.cn/api/paas/v4/chat/completions",
    )
    assert cfg.base_url == "https://open.bigmodel.cn/api/paas/v4"


def test_kimi_temperature_is_fixed_to_one():
    assert completion_temperature("KIMI2.7", None, 0.88) == 1
    assert completion_temperature("moonshotai/kimi-k2.7", "https://openrouter.ai/api/v1", 0.4) == 1


def test_moonshot_url_temperature_is_fixed_to_one():
    assert completion_temperature("gateway-model", "https://api.moonshot.cn/v1", 0.15) == 1


def test_other_models_keep_preferred_temperature():
    assert completion_temperature("deepseek-chat", "https://api.deepseek.com", 0.35) == 0.35
