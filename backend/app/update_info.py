"""GitHub Release 对比与更新信息（本地版本 + releases/latest，支持国内镜像中转）。"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Literal, Optional, Tuple
from urllib.parse import quote, urlparse

from packaging.version import InvalidVersion, Version

_GITHUB_OWNER_REPO = "DrEAmSs59/CS2-insight-agent"
GITHUB_LATEST_API = f"https://api.github.com/repos/{_GITHUB_OWNER_REPO}/releases/latest"
GITHUB_RELEASE_LATEST_PAGE = f"https://github.com/{_GITHUB_OWNER_REPO}/releases/latest"
_USER_AGENT = "CS2-Insight-Agent-UpdateCheck/1.0"
_RE_RELEASE_TAG_PATH = re.compile(r"/releases/tag/([^/?#]+)\s*$", re.IGNORECASE)
_RE_GITHUB_URL = re.compile(r"https://github\.com/[^\s\"']+", re.IGNORECASE)

# 社区镜像前缀（{prefix}/{完整 GitHub URL}）；可用 CS2_INSIGHT_UPDATE_MIRROR_PRESETS 覆盖
_BUILTIN_MIRROR_PREFIXES = (
    "https://ghfast.top",
    "https://mirror.ghproxy.com",
)


def _env_float(key: str, default: float) -> float:
    raw = (os.environ.get(key) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# 镜像 API 常被 403/挂起；镜像仅走 releases/latest 跳转。auto 模式与直连并发，谁先成功用谁。
_MIRROR_REDIRECT_TIMEOUT_SEC = _env_float("CS2_INSIGHT_UPDATE_MIRROR_TIMEOUT_SEC", 3.5)
_DIRECT_FETCH_TIMEOUT_SEC = _env_float("CS2_INSIGHT_UPDATE_FETCH_TIMEOUT_SEC", 5.0)
_UPDATE_RACE_TIMEOUT_SEC = _env_float("CS2_INSIGHT_UPDATE_RACE_TIMEOUT_SEC", 8.0)

_RELEASE_FILE = Path(__file__).resolve().parent / "release_version.txt"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_TOKEN_FILE_DEFAULT = _REPO_ROOT / ".cs2-insight-github-token"

LocalSource = Literal["file", "registry", "unknown"]

_cache: dict[str, Any] | None = None
_cache_expiry: float = 0.0
_TTL_SEC = 90.0
_ERROR_TTL_SEC = 600.0


def normalize_release_tag(tag_name: str) -> str:
    t = (tag_name or "").strip()
    if t.lower().startswith("v"):
        return t[1:].strip()
    return t


def mirror_wrap_url(mirror_prefix: str, original_url: str) -> str:
    """将 GitHub URL 包一层镜像前缀，供下载/页面访问。"""
    prefix = (mirror_prefix or "").strip().rstrip("/")
    original = (original_url or "").strip()
    if not prefix or not original:
        return original
    if original.startswith(prefix + "/"):
        return original
    return f"{prefix}/{original}"


def unwrap_github_url(url: str) -> str:
    """从镜像包装 URL 中提取 github.com 链接（用于解析 tag、统一下载地址）。"""
    text = (url or "").strip()
    if not text:
        return text
    m = _RE_GITHUB_URL.search(text)
    if m:
        return m.group(0).rstrip("/")
    return text


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


def _update_mirror_setting() -> str:
    env = (os.environ.get("CS2_INSIGHT_UPDATE_MIRROR") or os.environ.get("CS2_INSIGHT_GITHUB_MIRROR") or "").strip()
    if env:
        return env
    try:
        from .env_utils import load_config

        return (load_config().update_github_mirror or "auto").strip()
    except Exception:
        return "auto"


def _builtin_mirror_prefixes() -> tuple[str, ...]:
    raw = (os.environ.get("CS2_INSIGHT_UPDATE_MIRROR_PRESETS") or "").strip()
    if raw:
        parts = [p.strip().rstrip("/") for p in raw.split(",") if p.strip()]
        if parts:
            return tuple(parts)
    return _BUILTIN_MIRROR_PREFIXES


def _resolve_mirror_plan() -> tuple[Literal["off", "auto", "on", "custom"], tuple[str, ...]]:
    raw = _update_mirror_setting()
    low = raw.lower()
    if low in ("off", "false", "0", "none", "disable", "disabled"):
        return "off", ()
    if low in ("on", "true", "1", "cn", "china", "mirror", "mirrors", "only"):
        return "on", _builtin_mirror_prefixes()
    if low in ("auto", "default", ""):
        return "auto", _builtin_mirror_prefixes()
    if low.startswith("http://") or low.startswith("https://"):
        return "custom", (raw.rstrip("/"),)
    return "auto", _builtin_mirror_prefixes()


def _format_fetch_error(exc: BaseException) -> str:
    msg = str(exc).strip()
    low = msg.lower()
    if "403" in msg and "rate limit" in low:
        return (
            "GitHub 接口访问过于频繁（未认证每小时约 60 次），请稍后再试，"
            "或在设置中将「更新镜像」设为自动/仅镜像后重试。"
        )
    if "429" in msg or "too many requests" in low:
        return "GitHub 请求过于频繁，请稍后再试，或启用更新镜像。"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return (
            "无法连接 GitHub 检查更新（网络超时或被阻断）。"
            "可在设置 → 更新检查 中启用「自动镜像」或填写自定义镜像前缀。"
        )
    return msg or "无法获取最新版本信息"


def _should_try_redirect_fallback(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError) and exc.code in (403, 429):
        return True
    low = str(exc).lower()
    return "rate limit" in low or "too many requests" in low


def _is_retryable_network_error(exc: BaseException) -> bool:
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return True
    if isinstance(exc, urllib.error.HTTPError) and exc.code >= 500:
        return True
    return False


def _parse_release_tag_from_url(url: str) -> str:
    canonical = unwrap_github_url(url)
    path = urlparse(canonical).path
    m = _RE_RELEASE_TAG_PATH.search(path)
    if not m:
        raise ValueError(f"无法从 URL 解析版本标签: {url}")
    return m.group(1).strip()


def _guess_download_urls(tag_raw: str, tag_norm: str) -> tuple[str, str]:
    enc_tag = quote(tag_raw, safe="")
    base = f"https://github.com/{_GITHUB_OWNER_REPO}/releases/download/{enc_tag}"
    return (
        f"{base}/CS2InsightAgent-{tag_norm}-Setup.exe",
        f"{base}/CS2InsightAgent-{tag_norm}-windows-amd64.zip",
    )


def _fetch_latest_release_dict(mirror_prefix: str | None = None, *, timeout_sec: float = 4.0) -> dict[str, Any]:
    api_url = mirror_wrap_url(mirror_prefix, GITHUB_LATEST_API) if mirror_prefix else GITHUB_LATEST_API
    headers: dict[str, str] = {
        "Accept": "application/vnd.github+json",
        "User-Agent": _USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = _github_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(api_url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_latest_release_dict_via_redirect(mirror_prefix: str | None = None, *, timeout_sec: float = 4.0) -> dict[str, Any]:
    page_url = mirror_wrap_url(mirror_prefix, GITHUB_RELEASE_LATEST_PAGE) if mirror_prefix else GITHUB_RELEASE_LATEST_PAGE
    req = urllib.request.Request(page_url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        final_url = str(resp.url)
    tag_raw = _parse_release_tag_from_url(final_url)
    tag_norm = normalize_release_tag(tag_raw)
    setup_u, zip_u = _guess_download_urls(tag_raw, tag_norm)
    release_page = unwrap_github_url(final_url)
    return {
        "tag_name": tag_raw,
        "html_url": release_page,
        "body": "",
        "assets": [
            {"name": f"CS2InsightAgent-{tag_norm}-Setup.exe", "browser_download_url": setup_u},
            {"name": f"CS2InsightAgent-{tag_norm}-windows-amd64.zip", "browser_download_url": zip_u},
        ],
    }


def _fetch_with_api_then_redirect(
    mirror_prefix: str | None,
    *,
    timeout_sec: float = _DIRECT_FETCH_TIMEOUT_SEC,
) -> dict[str, Any]:
    try:
        return _fetch_latest_release_dict(mirror_prefix, timeout_sec=timeout_sec)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as e:
        if _should_try_redirect_fallback(e) or _is_retryable_network_error(e):
            return _fetch_latest_release_dict_via_redirect(mirror_prefix, timeout_sec=timeout_sec)
        raise


def _fetch_mirror_release(mirror_prefix: str) -> dict[str, Any]:
    """镜像站：仅 /releases/latest 跳转（避免镜像 API 403 与长时间挂起）。"""
    return _fetch_latest_release_dict_via_redirect(
        mirror_prefix,
        timeout_sec=_MIRROR_REDIRECT_TIMEOUT_SEC,
    )


def _fetch_direct_release() -> dict[str, Any]:
    return _fetch_with_api_then_redirect(None, timeout_sec=_DIRECT_FETCH_TIMEOUT_SEC)


def _race_release_fetch(candidates: list[str | None]) -> tuple[dict[str, Any], str | None]:
    """并发探测；candidates 中 None 表示直连 GitHub，str 为镜像前缀。"""
    if not candidates:
        raise ValueError("无可用更新检查通道")

    last_err: BaseException | None = None
    max_workers = min(8, len(candidates))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {}
        for item in candidates:
            if item is None:
                futures[pool.submit(_fetch_direct_release)] = None
            else:
                prefix = item
                futures[pool.submit(_fetch_mirror_release, prefix)] = prefix

        try:
            for fut in as_completed(futures, timeout=_UPDATE_RACE_TIMEOUT_SEC):
                mirror_prefix = futures[fut]
                try:
                    return fut.result(), mirror_prefix
                except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as e:
                    last_err = e
        except TimeoutError:
            last_err = last_err or TimeoutError("检查更新超时")

    if last_err is not None:
        raise last_err
    raise ValueError("无法获取最新版本信息")


def _fetch_latest_release_data() -> tuple[dict[str, Any], str | None]:
    """按配置尝试镜像与直连，返回 (release_json, 使用的镜像前缀或 None)。"""
    mode, mirrors = _resolve_mirror_plan()

    if mode == "off":
        return _fetch_direct_release(), None

    if mode == "on":
        if not mirrors:
            raise ValueError("未配置可用镜像前缀")
        return _race_release_fetch(list(mirrors))

    if mode == "custom" and mirrors:
        return _race_release_fetch([mirrors[0], None])

    if mode == "auto":
        return _race_release_fetch([*mirrors, None])

    return _fetch_direct_release(), None


def _apply_mirror_to_payload(base: dict[str, Any], mirror_prefix: str | None) -> None:
    if not mirror_prefix:
        return
    if base.get("release_url"):
        base["release_url"] = mirror_wrap_url(mirror_prefix, unwrap_github_url(str(base["release_url"])))
    downloads = base.get("downloads") or {}
    for key in ("setup_url", "zip_url"):
        raw = downloads.get(key)
        if raw:
            downloads[key] = mirror_wrap_url(mirror_prefix, unwrap_github_url(str(raw)))
    base["downloads"] = downloads


def _apply_version_compare(
    base: dict[str, Any],
    *,
    current_version: str,
    current_source: str,
    tag: str,
) -> None:
    remote_v = parse_semver_loose(tag) if tag else None
    local_v = parse_semver_loose(current_version) if current_source != "unknown" else None
    cur = (current_version or "").strip()

    if local_v is not None and remote_v is not None and remote_v > local_v:
        base["update_available"] = True
    elif current_source == "unknown" and remote_v is not None:
        base["show_latest_release"] = True
    elif remote_v is not None and local_v is None and current_source != "unknown" and cur and cur != "unknown":
        base["show_latest_release"] = True


def build_update_payload(current_version: str, current_source: str, *, force_refresh: bool = False) -> dict[str, Any]:
    global _cache, _cache_expiry
    now = time.monotonic()
    if not force_refresh and _cache is not None and now < _cache_expiry:
        return dict(_cache)

    mode, mirror_presets = _resolve_mirror_plan()
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
        "update_mirror_setting": _update_mirror_setting(),
        "update_mirror_mode": mode,
        "update_mirror_presets": list(mirror_presets),
        "update_via_mirror": None,
    }

    data: dict[str, Any] | None = None
    mirror_used: str | None = None
    fetch_err: BaseException | None = None
    try:
        data, mirror_used = _fetch_latest_release_data()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as e:
        fetch_err = e

    if data is None:
        base["error"] = _format_fetch_error(fetch_err) if fetch_err else "无法获取最新版本信息"
        _cache = dict(base)
        _cache_expiry = now + _ERROR_TTL_SEC
        return dict(base)

    tag = normalize_release_tag(str(data.get("tag_name") or ""))
    base["latest_version"] = tag or None
    base["release_notes"] = str(data.get("body") or "")
    base["release_url"] = str(data.get("html_url") or "")
    assets = list(data.get("assets") or [])
    setup_u, zip_u = pick_download_urls(assets, tag) if tag else (None, None)
    base["downloads"]["setup_url"] = setup_u
    base["downloads"]["zip_url"] = zip_u
    base["update_via_mirror"] = mirror_used
    _apply_mirror_to_payload(base, mirror_used)
    _apply_version_compare(base, current_version=current_version, current_source=current_source, tag=tag)

    _cache = dict(base)
    _cache_expiry = now + _TTL_SEC
    return dict(base)
