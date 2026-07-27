#!/usr/bin/env python3
"""Benchmark the pending Demo ingest-picker query against its legacy form."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import closing
from pathlib import Path
import sqlite3
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_db import DemoDB


LEGACY_ANTI_JOIN = """
AND NOT EXISTS (
    SELECT 1 FROM demo_files ing
    WHERE ing.id != d.id
      AND (
        lower(d.path) = lower(ing.path)
        OR lower(d.filename) = lower(ing.filename)
        OR (
          d.content_md5 IS NOT NULL AND trim(d.content_md5) != ''
          AND ing.content_md5 IS NOT NULL AND trim(ing.content_md5) != ''
          AND d.content_md5 = ing.content_md5
        )
      )
      AND (ing.status != 'pending' OR ing.id < d.id)
)
"""


def _measure(conn: sqlite3.Connection, sql: str, repeats: int) -> tuple[int, float]:
    samples: list[float] = []
    result = 0
    for _ in range(max(1, repeats)):
        started = time.perf_counter()
        row = conn.execute(sql).fetchone()
        samples.append((time.perf_counter() - started) * 1000)
        result = int(row[0]) if row else 0
    return result, statistics.median(samples)


def _seed(conn: sqlite3.Connection, rows: int) -> None:
    conn.execute("DELETE FROM demo_files")
    payload = [
        (
            f"C:/bench/demo-{index}.dem",
            f"demo-{index}.dem",
            1024 * 1024,
            "pending" if index % 2 == 0 else "loaded",
            "2026-07-27T00:00:00+00:00",
            f"hash-{index}",
        )
        for index in range(rows)
    ]
    conn.executemany(
        """
        INSERT INTO demo_files(path, filename, file_size, status, added_at, content_md5)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        payload,
    )
    conn.commit()


async def _initialize(db_path: Path) -> DemoDB:
    db = DemoDB(db_path)
    await db.init_db()
    return db


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--rows", type=int, nargs="+", default=[500, 1000, 2000, 4000])
    cli.add_argument("--repeats", type=int, default=5, help="Median repeats for the optimized query")
    cli.add_argument("--skip-legacy", action="store_true", help="Skip the intentionally slow baseline")
    args = cli.parse_args()

    sizes = [value for value in args.rows if value > 0]
    if not sizes:
        cli.error("--rows must contain at least one positive value")

    with tempfile.TemporaryDirectory(prefix="cs2-insight-ingest-bench-") as temp_dir:
        db_path = Path(temp_dir) / "bench.sqlite3"
        db = asyncio.run(_initialize(db_path))
        optimized_sql = (
            "SELECT COUNT(*) FROM demo_files d WHERE d.status = 'pending'"
            + db._discovered_not_already_in_library_sql("d")
        )
        legacy_sql = "SELECT COUNT(*) FROM demo_files d WHERE d.status = 'pending'" + LEGACY_ANTI_JOIN

        print("rows\tlegacy_ms\toptimized_ms\tspeedup")
        with closing(sqlite3.connect(db_path)) as conn:
            for row_count in sizes:
                _seed(conn, row_count)
                optimized_count, optimized_ms = _measure(conn, optimized_sql, args.repeats)
                if args.skip_legacy:
                    print(f"{row_count}\t-\t{optimized_ms:.3f}\t-")
                    continue
                legacy_count, legacy_ms = _measure(conn, legacy_sql, 1)
                if legacy_count != optimized_count:
                    raise RuntimeError(
                        f"query result mismatch at {row_count} rows: "
                        f"legacy={legacy_count}, optimized={optimized_count}"
                    )
                speedup = legacy_ms / optimized_ms if optimized_ms else float("inf")
                print(f"{row_count}\t{legacy_ms:.3f}\t{optimized_ms:.3f}\t{speedup:.1f}x")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
