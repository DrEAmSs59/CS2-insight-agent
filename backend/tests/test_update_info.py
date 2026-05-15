from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

from packaging.version import Version

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app import update_info
from app.update_info import (
    _github_api_token,
    build_update_payload,
    normalize_release_tag,
    parse_semver_loose,
    pick_download_urls,
    resolve_local_version_info,
)


def test_normalize_release_tag():
    assert normalize_release_tag("v1.2.3") == "1.2.3"
    assert normalize_release_tag("1.2.3") == "1.2.3"


def test_pick_download_urls():
    ver = "1.2.3"
    assets = [
        {"name": f"CS2InsightAgent-{ver}-Setup.exe", "browser_download_url": "https://example/setup"},
        {"name": f"CS2InsightAgent-{ver}-windows-amd64.zip", "browser_download_url": "https://example/zip"},
        {"name": "other.txt", "browser_download_url": "https://example/x"},
    ]
    setup, zip_url = pick_download_urls(assets, ver)
    assert setup == "https://example/setup"
    assert zip_url == "https://example/zip"


def test_pick_download_urls_partial():
    assets = [{"name": "CS2InsightAgent-1.0.0-Setup.exe", "browser_download_url": "https://a"}]
    setup, zip_url = pick_download_urls(assets, "1.0.0")
    assert setup == "https://a"
    assert zip_url is None


def test_parse_semver_loose_ok():
    assert parse_semver_loose("2.1.0") == Version("2.1.0")


def test_parse_semver_loose_bad_string():
    assert parse_semver_loose("not-a-version") is None


def test_resolve_local_from_patched_release_file(tmp_path):
    rf = tmp_path / "release_version.txt"
    rf.write_text("3.4.5", encoding="utf-8")
    with patch.object(update_info, "_RELEASE_FILE", rf):
        cur, src = resolve_local_version_info()
    assert cur == "3.4.5"
    assert src == "file"


def test_resolve_local_unknown_when_no_file_and_no_registry(monkeypatch):
    monkeypatch.setattr(update_info, "_read_release_file", lambda: None)
    monkeypatch.setattr(update_info, "_read_windows_uninstall_display_version", lambda: None)
    cur, src = resolve_local_version_info()
    assert cur == "unknown"
    assert src == "unknown"


def test_build_update_payload_upgrade():
    payload = {
        "tag_name": "v2.0.0",
        "html_url": "https://github.com/o/r/releases/tag/v2.0.0",
        "body": "## Notes\n\nhello",
        "assets": [
            {"name": "CS2InsightAgent-2.0.0-Setup.exe", "browser_download_url": "https://dl/setup"},
            {"name": "CS2InsightAgent-2.0.0-windows-amd64.zip", "browser_download_url": "https://dl/zip"},
        ],
    }
    with patch.object(update_info, "_fetch_latest_release_dict", return_value=payload):
        out = build_update_payload("1.0.0", "file", force_refresh=True)
    assert out["update_available"] is True
    assert out["show_latest_release"] is False
    assert out["latest_version"] == "2.0.0"
    assert out["downloads"]["setup_url"] == "https://dl/setup"


def test_build_update_payload_unknown_local_shows_latest():
    payload = {
        "tag_name": "v2.0.0",
        "html_url": "https://github.com/o/r/releases/tag/v2.0.0",
        "body": "x",
        "assets": [],
    }
    with patch.object(update_info, "_fetch_latest_release_dict", return_value=payload):
        out = build_update_payload("unknown", "unknown", force_refresh=True)
    assert out["update_available"] is False
    assert out["show_latest_release"] is True


def test_build_update_payload_no_upgrade_when_local_newer():
    payload = {"tag_name": "v1.0.0", "html_url": "https://x", "body": "", "assets": []}
    with patch.object(update_info, "_fetch_latest_release_dict", return_value=payload):
        out = build_update_payload("2.0.0", "file", force_refresh=True)
    assert out["update_available"] is False
    assert out["show_latest_release"] is False


def test_github_token_env_overrides_file(monkeypatch, tmp_path):
    monkeypatch.delenv("CS2_INSIGHT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_GITHUB_TOKEN_FILE", raising=False)
    tok_file = tmp_path / ".cs2-insight-github-token"
    tok_file.write_text("from-file\n", encoding="utf-8")
    monkeypatch.setattr(update_info, "_TOKEN_FILE_DEFAULT", tok_file)
    monkeypatch.setenv("CS2_INSIGHT_GITHUB_TOKEN", "from-env")
    assert _github_api_token() == "from-env"


def test_github_token_from_default_file(monkeypatch, tmp_path):
    monkeypatch.delenv("CS2_INSIGHT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_GITHUB_TOKEN_FILE", raising=False)
    tok_file = tmp_path / ".cs2-insight-github-token"
    tok_file.write_text("# comment\n\ngithub_pat_abc\n", encoding="utf-8")
    monkeypatch.setattr(update_info, "_TOKEN_FILE_DEFAULT", tok_file)
    assert _github_api_token() == "github_pat_abc"


def test_github_token_from_token_file_env(monkeypatch, tmp_path):
    monkeypatch.delenv("CS2_INSIGHT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    custom = tmp_path / "secret.txt"
    custom.write_text("tok_line2\n", encoding="utf-8")
    monkeypatch.setenv("CS2_INSIGHT_GITHUB_TOKEN_FILE", str(custom))
    assert _github_api_token() == "tok_line2"
