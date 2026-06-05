"""record_inject_console_lines 种子默认 + user_configured 闸门迁移。"""

from app.env_utils import (
    AppConfig,
    _DEFAULT_RECORD_INJECT_CONSOLE_LINES,
    _normalize_config_defaults,
)


def test_default_seeds_five_cvars():
    cfg = AppConfig()
    assert cfg.record_inject_console_lines == _DEFAULT_RECORD_INJECT_CONSOLE_LINES
    assert "fps_max 0" in cfg.record_inject_console_lines
    assert "cl_trueview_show_status 0" in cfg.record_inject_console_lines


def test_legacy_empty_no_flag_gets_seeded():
    raw = {"record_inject_console_lines": ""}
    cfg = AppConfig(**raw)
    _normalize_config_defaults(cfg, raw)
    assert cfg.record_inject_console_lines == _DEFAULT_RECORD_INJECT_CONSOLE_LINES
    assert cfg.record_inject_console_lines_user_configured is False


def test_legacy_nonempty_no_flag_is_user_configured_and_preserved():
    raw = {"record_inject_console_lines": "voice_enable 0"}
    cfg = AppConfig(**raw)
    _normalize_config_defaults(cfg, raw)
    assert cfg.record_inject_console_lines == "voice_enable 0"
    assert cfg.record_inject_console_lines_user_configured is True


def test_user_configured_empty_is_respected():
    raw = {
        "record_inject_console_lines": "",
        "record_inject_console_lines_user_configured": True,
    }
    cfg = AppConfig(**raw)
    _normalize_config_defaults(cfg, raw)
    assert cfg.record_inject_console_lines == ""
    assert cfg.record_inject_console_lines_user_configured is True
