"""Demo 库来源 logo：与合辑/Demo 库卡片同一套 public/images/sources。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

_MAP_TOKEN = re.compile(r"(?:^|[\\/_-])((?:de|cs|ar)_[a-z0-9]+)", re.IGNORECASE)

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent.parent
_REPO_ROOT = _BACKEND_DIR.parent
_SOURCE_DIR = _REPO_ROOT / "frontend" / "public" / "images" / "sources"

# 深色底用白色/彩色版
_SOURCE_FILES: dict[str, str] = {
    "faceit": "faceit-white.png",
    "5e": "5eplay.png",
    "5eplay": "5eplay.png",
    "perfect world": "perfectworld-white.png",
    "perfectworld": "perfectworld-white.png",
    "matchmaking": "valve-white.png",
    "valve": "valve-white.png",
    "esl": "esl-white.png",
    "esea": "esea-white.png",
    "blast": "blast.png",
    "challengermode": "challengermode.png",
    "pgl": "unknown.png",
    "starladder": "unknown.png",
    "flashpoint": "unknown.png",
    "local/other": "unknown.png",
    "local": "unknown.png",
}

_SOURCE_DISPLAY: dict[str, str] = {
    "blast": "BLAST",
    "faceit": "FACEIT",
    "5e": "5E",
    "perfect world": "Perfect World",
    "matchmaking": "Matchmaking",
    "esl": "ESL",
    "esea": "ESEA",
    "challengermode": "Challengermode",
    "pgl": "PGL",
    "starladder": "StarLadder",
    "flashpoint": "Flashpoint",
}


def normalize_demo_source(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return "Local/Other"
    return text


def display_demo_source(raw: Any) -> str:
    text = normalize_demo_source(raw)
    mapped = _SOURCE_DISPLAY.get(text.lower())
    if mapped:
        return mapped
    if text.lower() in {"local/other", "local", "unknown"}:
        return "LOCAL"
    return text.upper() if text.isascii() else text


def resolve_source_logo_path(raw: Any) -> Optional[Path]:
    key = normalize_demo_source(raw).lower()
    filename = _SOURCE_FILES.get(key) or "unknown.png"
    path = _SOURCE_DIR / filename
    return path if path.is_file() else None


def infer_source_from_path(demo_path: str, demo_filename: str = "") -> str:
    blob = f"{demo_path} {demo_filename}".lower()
    if "blast" in blob:
        return "Blast"
    if "pgl" in blob:
        return "PGL"
    if "starladder" in blob:
        return "StarLadder"
    if "challengermode" in blob:
        return "Challengermode"
    if "faceit" in blob:
        return "Faceit"
    if "esl" in blob:
        return "ESL"
    if "esea" in blob:
        return "ESEA"
    if "perfectworld" in blob or "完美" in blob:
        return "Perfect World"
    if "5eplay" in blob or "/5e" in blob or "\\5e" in blob:
        return "5E"
    if "valve" in blob or "match730" in blob:
        return "Matchmaking"
    return "Local/Other"


def infer_map_name(*parts: Any) -> str:
    """从 workspace / Demo 行 / 文件名里取出 de_dust2 这类地图名。"""
    for raw in parts:
        text = str(raw or "").strip()
        if not text:
            continue
        match = _MAP_TOKEN.search(text.replace(" ", "_"))
        if match:
            return match.group(1).lower()
        lowered = text.lower()
        if lowered.startswith(("de_", "cs_", "ar_")):
            return lowered
    return ""


def format_map_label(raw: Any) -> str:
    """de_dust2 → DUST2，供雷达图右侧展示。"""
    token = infer_map_name(raw) or str(raw or "").strip()
    if not token:
        return ""
    for prefix in ("de_", "cs_", "ar_"):
        if token.lower().startswith(prefix):
            token = token[len(prefix) :]
            break
    return token.replace("_", " ").upper()
