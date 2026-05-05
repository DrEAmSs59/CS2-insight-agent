"""
下载常用竞技地图的雷达平面图到 backend/assets/radar_maps/。

图片来源：GitHub zoidyzoidzoid/csgo-overviews（MIT License），
与 CS 系列雷达视角一致的平面图，用于替换仓库内占位 PNG。

用法（在仓库根目录或 backend 目录均可）::

    cd backend
    python scripts/fetch_overview_radars.py

需联网。下载完成后请保留第三方仓库的 LICENSE 说明（见脚本注释中的链接）。
"""

from __future__ import annotations

import ssl
import urllib.request
from pathlib import Path

# https://github.com/zoidyzoidzoid/csgo-overviews — MIT
_RAW_BASE = (
    "https://raw.githubusercontent.com/zoidyzoidzoid/csgo-overviews/master/overviews/"
)

# 与本项目 calibration.json 中条目对应
_MAP_FILES = (
    "de_mirage.png",
    "de_dust2.png",
    "de_inferno.png",
    "de_ancient.png",
    "de_anubis.png",
)


def main() -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    out_dir = backend_dir / "assets" / "radar_maps"
    out_dir.mkdir(parents=True, exist_ok=True)

    ctx = ssl.create_default_context()
    for name in _MAP_FILES:
        url = _RAW_BASE + name
        dest = out_dir / name
        print(f"GET {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "CS2-insight-agent-fetch-radar/1"})
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            data = resp.read()
        dest.write_bytes(data)
        print(f"  -> {dest} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
