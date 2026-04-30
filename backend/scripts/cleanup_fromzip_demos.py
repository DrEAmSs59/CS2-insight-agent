"""
删除因 zip 重复解压产生的冗余 .dem：库表 demo_files 中 filename 含 _fromzip_ 的记录，
及对应磁盘文件；并清理监听目录里已无库记录的同名孤儿文件。

用法（在仓库根目录）:
  python backend/scripts/cleanup_fromzip_demos.py
  python backend/scripts/cleanup_fromzip_demos.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import aiosqlite  # noqa: E402

from app.demo_db import DemoDB  # noqa: E402
from app.env_utils import load_config, resolve_config_path  # noqa: E402


async def _all_demo_paths(db_path: Path) -> set[str]:
    async with aiosqlite.connect(db_path) as conn:
        cur = await conn.execute("SELECT path FROM demo_files")
        rows = await cur.fetchall()
    return {str(r[0]) for r in rows if r and r[0]}


async def _list_fromzip_rows(db_path: Path) -> list[dict]:
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
            "SELECT id, path, filename FROM demo_files WHERE instr(lower(filename), '_fromzip_') > 0",
        )
        return [dict(r) for r in await cur.fetchall()]


async def _cleanup_db_rows(demo_db: DemoDB, rows: list[dict], dry_run: bool) -> tuple[int, int]:
    removed_files = 0
    removed_db = 0
    for r in rows:
        p = Path(r["path"])
        if not dry_run:
            try:
                if p.is_file():
                    p.unlink()
                    removed_files += 1
            except OSError as e:
                print(f"WARN: 无法删除文件 {p}: {e}")
            ok = await demo_db.delete_demo(int(r["id"]))
            if ok:
                removed_db += 1
        else:
            print(f"  [dry-run] 将删除 id={r['id']} file={p.name}")
            removed_db += 1
    return removed_files, removed_db


def _orphan_fromzip_files(cfg_paths: list[str], known_paths: set[str]) -> list[Path]:
    out: list[Path] = []
    for raw in cfg_paths:
        if not str(raw).strip():
            continue
        root = Path(raw).expanduser()
        if not root.is_dir():
            continue
        try:
            for f in root.iterdir():
                if not f.is_file():
                    continue
                if f.suffix.lower() != ".dem":
                    continue
                if "_fromzip_" not in f.name.lower():
                    continue
                key = str(f.resolve())
                if key not in known_paths:
                    out.append(f)
        except OSError as e:
            print(f"WARN: 无法扫描目录 {root}: {e}")
    return out


async def main_async(dry_run: bool) -> None:
    db_path = resolve_config_path().parent / "cs2-insight.db"
    if not db_path.is_file():
        print(f"未找到数据库: {db_path}")
        return

    demo_db = DemoDB(db_path)
    await demo_db.init_db()

    rows = await _list_fromzip_rows(db_path)
    print(f"发现 {len(rows)} 条「_fromzip_」库记录。")
    if not rows and dry_run:
        print("无需要处理的库记录。")

    files_n, db_n = await _cleanup_db_rows(demo_db, rows, dry_run=dry_run)
    if not dry_run:
        print(f"已删除库记录 {db_n} 条，已删除磁盘文件 {files_n} 个（库内 fromzip 条目）。")

    cfg = load_config()
    known = await _all_demo_paths(db_path)
    orphans = _orphan_fromzip_files(list(cfg.demo_watch_paths or []), known)
    if orphans:
        print(f"发现 {len(orphans)} 个监听目录内孤儿 _fromzip_ .dem（已无库记录）。")
        for f in orphans:
            if dry_run:
                print(f"  [dry-run] 将删除孤儿文件 {f}")
            else:
                try:
                    f.unlink()
                    print(f"已删除孤儿文件: {f}")
                except OSError as e:
                    print(f"WARN: 无法删除 {f}: {e}")
    elif not dry_run:
        print("无孤儿 _fromzip_ 文件。")


def main() -> None:
    ap = argparse.ArgumentParser(description="清理 zip 重复解压产生的 _fromzip_ demo")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的操作")
    args = ap.parse_args()
    asyncio.run(main_async(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
