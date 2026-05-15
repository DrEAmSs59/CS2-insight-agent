"""GitHub Release 对比与更新信息（本地版本 + releases/latest）。"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal, Optional, Tuple

from packaging.version import InvalidVersion, Version

GITHUB_LATEST_API = "https://api.github.com/repos/DrEAmSs59/CS2-insight-agent/releases/latest"
_USER_AGENT = "CS2-Insight-Agent-UpdateCheck/1.0"

_RELEASE_FILE = Path(__file__).resolve().parent / "release_version.txt"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_TOKEN_FILE_DEFAULT = _REPO_ROOT / ".cs2-insight-github-token"

LocalSource = Literal["file", "registry", "unknown"]

_cache: dict[str, Any] | None = None
_cache_expiry: float = 0.0
_TTL_SEC = 90.0


def normalize_release_tag(tag_name: str) -> str:
    t = (tag_name or "").strip()
    if t.lower().startswith("v"):
        return t[1:].strip()
    return t


def pick_download_urls(assets: list[dict[str, Any]], version_without_v: str) -> tuple[Optional[str], Optional[str]]:
    setup_url: Optional[str] = None
    zip_url: Optional[str] = None
    want_setup = f"CS2InsightAgent-{version_without_v}-Setup.exe"
    want_zip = f"CS2InsightAgent-{version_without_v}-windows-amd64.zip"
    for a in assets:
        name = str(a.get("name") or "")
        url = a.get("browser_download_url")
        if not url:
            continue
        if name == want_setup:
            setup_url = str(url)
        elif name == want_zip:
            zip_url = str(url)
    return setup_url, zip_url


def parse_semver_loose(text: str) -> Optional[Version]:
    raw = (text or "").strip()
    if not raw or raw == "unknown":
        return None
    try:
        return Version(raw)
    except InvalidVersion:
        return None


def _read_release_file() -> Optional[str]:
    try:
        if not _RELEASE_FILE.is_file():
            return None
        line = _RELEASE_FILE.read_text(encoding="utf-8", errors="replace").strip().splitlines()[0].strip()
        return line or None
    except OSError:
        return None


def _read_windows_uninstall_display_version() -> Optional[str]:
    if sys.platform != "win32":
        return None
    import winreg

    uninstall_roots = (
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    )
    want_name = "CS2 Insight Agent"
    for hive, sub in uninstall_roots:
        try:
            key = winreg.OpenKey(hive, sub)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    sub_name = winreg.EnumKey(key, i)
                except OSError:
                    break
                i += 1
                sk = None
                try:
                    sk = winreg.OpenKey(key, sub_name)
                    try:
                        disp, _ = winreg.QueryValueEx(sk, "DisplayName")
                    except OSError:
                        continue
                    if str(disp).strip() != want_name:
                        continue
                    ver, _ = winreg.QueryValueEx(sk, "DisplayVersion")
                    return str(ver).strip() or None
                except OSError:
                    continue
                finally:
                    if sk is not None:
                        try:
                            winreg.CloseKey(sk)
                        except OSError:
                            pass
        finally:
            try:
                winreg.CloseKey(key)
            except OSError:
                pass
    return None


def resolve_local_version_info() -> Tuple[str, LocalSource]:
    ft = _read_release_file()
    if ft:
        return ft, "file"
    reg = _read_windows_uninstall_display_version()
    if reg:
        return reg, "registry"
    return "unknown", "unknown"


def _read_github_token_file(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            return s
    except OSError:
        return None
    return None


def _github_api_token() -> str | None:
    """Optional PAT to raise REST rate limits (anonymous ~60/hr → authenticated ~5000/hr)."""
    for key in ("CS2_INSIGHT_GITHUB_TOKEN", "GITHUB_TOKEN"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            return raw
    file_env = (os.environ.get("CS2_INSIGHT_GITHUB_TOKEN_FILE") or "").strip()
    if file_env:
        t = _read_github_token_file(Path(file_env).expanduser())
        if t:
            return t
    return _read_github_token_file(_TOKEN_FILE_DEFAULT)


def _fetch_latest_release_dict(timeout_sec: float = 4.0) -> dict[str, Any]:
    headers: dict[str, str] = {
        "Accept": "application/vnd.github+json",
        "User-Agent": _USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = _github_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        GITHUB_LATEST_API,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_update_payload(current_version: str, current_source: str, *, force_refresh: bool = False) -> dict[str, Any]:
    global _cache, _cache_expiry
    now = time.monotonic()
    if not force_refresh and _cache is not None and now < _cache_expiry:
        return dict(_cache)
    base: dict[str, Any] = {
        "current_version": current_version,
        "current_source": current_source,
        "latest_version": None,
        "update_available": False,
        "show_latest_release": False,
        "release_notes": "",
        "release_url": "",
        "downloads": {"setup_url": None, "zip_url": None},
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "error": None,
    }
    try:
        data = _fetch_latest_release_dict()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as e:
        base["error"] = str(e)
        _cache = dict(base)
        _cache_expiry = now + _TTL_SEC
        return dict(base)

    tag = normalize_release_tag(str(data.get("tag_name") or ""))
    base["latest_version"] = tag or None
    base["release_notes"] = str(data.get("body") or "")
    base["release_url"] = str(data.get("html_url") or "")
    assets = list(data.get("assets") or [])
    setup_u, zip_u = pick_download_urls(assets, tag) if tag else (None, None)
    base["downloads"]["setup_url"] = setup_u
    base["downloads"]["zip_url"] = zip_u

    remote_v = parse_semver_loose(tag) if tag else None
    local_v = parse_semver_loose(current_version) if current_source != "unknown" else None

    if local_v is not None and remote_v is not None and remote_v > local_v:
        base["update_available"] = True
    elif current_source == "unknown" and remote_v is not None:
        base["show_latest_release"] = True

    _cache = dict(base)
    _cache_expiry = now + _TTL_SEC
    return dict(base)
