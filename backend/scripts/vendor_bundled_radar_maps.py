"""
将 ``python -m awpy get maps`` 下载到 ``~/.awpy/maps`` 的文件同步进仓库。

使用前（仅需维护地图资源的机器执行一次）::

    pip install awpy
    python -m awpy get maps

然后::

    cd backend
    python scripts/vendor_bundled_radar_maps.py

会把 ``map-data.json`` 与 ``*.png`` 复制到 ``assets/bundled_radar_maps/``，
提交后可移除本机 ``awpy``，运行时不再依赖该包。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def main() -> int:
    src = Path.home() / ".awpy" / "maps"
    backend_dir = Path(__file__).resolve().parent.parent
    dst = backend_dir / "assets" / "bundled_radar_maps"

    if not src.is_dir():
        print(f"源目录不存在: {src}", file=sys.stderr)
        print("请先安装 awpy 并运行: python -m awpy get maps", file=sys.stderr)
        return 1

    meta = src / "map-data.json"
    if not meta.is_file():
        print(f"缺少 {meta}", file=sys.stderr)
        return 1

    pngs = list(src.glob("*.png"))
    if not pngs:
        print(f"{src} 下没有 PNG，请先 awpy get maps", file=sys.stderr)
        return 1

    dst.mkdir(parents=True, exist_ok=True)
    shutil.copy2(meta, dst / "map-data.json")
    for p in pngs:
        shutil.copy2(p, dst / p.name)

    print(f"已写入 {dst}（{len(pngs)} 张 PNG + map-data.json）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
