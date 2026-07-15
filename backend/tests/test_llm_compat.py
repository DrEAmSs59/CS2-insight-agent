import logging

import pytest

from app.env_utils import LLMConfig
from app.llm_compat import normalize_llm_base_url, prepare_llm_base_url


def test_normalize_strips_chat_completions():
    url = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    assert normalize_llm_base_url(url) == "https://open.bigmodel.cn/api/paas/v4"


def test_llm_config_validator():
    cfg = LLMConfig(
        model="glm-4.6v",
        base_url="https://open.bigmodel.cn/api/paas/v4/chat/completions",
    )
    assert cfg.base_url == "https://open.bigmodel.cn/api/paas/v4"


@pytest.mark.parametrize(
    "url",
    [
        "http://api.openai.com/v1",
        "http://custom-provider.example/v1",
    ],
)
def test_prepare_warns_for_any_remote_http_url(url, caplog):
    with caplog.at_level(logging.WARNING, logger="app.llm_compat"):
        assert prepare_llm_base_url(url) == url

    assert "API Key 将以明文传输" in caplog.text


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://127.0.0.2:11434/v1",
        "http://[::1]:11434/v1",
        "https://custom-provider.example/v1",
    ],
)
def test_prepare_allows_https_and_loopback_http_without_warning(url, caplog):
    with caplog.at_level(logging.WARNING, logger="app.llm_compat"):
        assert prepare_llm_base_url(url) == url

    assert "API Key 将以明文传输" not in caplog.text
