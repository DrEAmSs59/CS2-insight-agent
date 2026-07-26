#!/usr/bin/env python3
"""阶段 S-A：烟雾体素帧格式研究（只读分析，不进生产路径）。

对 ``parse_grenades(extra=[...])`` 导出的 ``m_VoxelFrameData`` bytes 做统计：

- 长度分布、与 ``m_nVoxelFrameDataSize`` 的关系
- 熵、唯一字节、字节直方图
- 相邻帧（同实体、按 tick）diff 数量
- 固定头部 / RLE 线索的启发式标记

用法::

    python backend/scripts/analyze_smoke_voxel_frames.py \\
        --demo path/to.dem --out docs/replay-effects-validation/probe-output/smoke-sa-001
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import native_table as pd


def shannon_entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = collections.Counter(data)
    n = len(data)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def byte_histogram(data: bytes, top_n: int = 16) -> list[dict[str, Any]]:
    counts = collections.Counter(data)
    return [
        {"byte": int(b), "count": int(c), "ratio": round(c / max(1, len(data)), 4)}
        for b, c in counts.most_common(top_n)
    ]


def count_diffs(a: bytes, b: bytes) -> dict[str, Any]:
    if a is None or b is None:
        return {"comparable": False}
    n = min(len(a), len(b))
    diffs = sum(1 for i in range(n) if a[i] != b[i])
    return {
        "comparable": True,
        "min_len": n,
        "len_a": len(a),
        "len_b": len(b),
        "changed_bytes": diffs,
        "len_delta": len(b) - len(a),
    }


def detect_header_hints(data: bytes) -> dict[str, Any]:
    """启发式：是否像固定头 / 长度前缀 / 稀疏零填充。"""
    if not data:
        return {"empty": True}
    leading_zeros = 0
    for b in data:
        if b != 0:
            break
        leading_zeros += 1
    zero_ratio = data.count(0) / len(data)
    # 简单 RLE 线索：连续相同字节 run 较长
    max_run = 1
    run = 1
    for i in range(1, len(data)):
        if data[i] == data[i - 1]:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    return {
        "empty": False,
        "leading_zeros": leading_zeros,
        "zero_ratio": round(zero_ratio, 4),
        "max_equal_run": max_run,
        "possible_fixed_capacity": len(data) in {1024, 2048, 3072, 4096},
        "prefix_hex_32": data[:32].hex(),
    }


def summarize_frame(data: bytes, declared_size: Any = None) -> dict[str, Any]:
    declared = None
    if declared_size is not None and not (isinstance(declared_size, float) and math.isnan(declared_size)):
        try:
            declared = int(declared_size)
        except (TypeError, ValueError):
            declared = None
    return {
        "length": len(data),
        "declared_size": declared,
        "declared_matches_length": (declared == len(data)) if declared is not None else None,
        "sha256": hashlib.sha256(data).hexdigest(),
        "entropy": round(shannon_entropy(data), 4),
        "unique_bytes": len(set(data)),
        "histogram_top": byte_histogram(data),
        "header_hints": detect_header_hints(data),
    }


def analyze_entity_series(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """rows: [{tick, voxel_update, declared_size, data: bytes}, ...] 已按 tick 排序。"""
    frames = []
    diffs = []
    prev_data = None
    prev_update = None
    for row in rows:
        data = row.get("data")
        if not isinstance(data, (bytes, bytearray)):
            continue
        data = bytes(data)
        summary = summarize_frame(data, row.get("declared_size"))
        summary["tick"] = row.get("tick")
        summary["voxel_update"] = row.get("voxel_update")
        frames.append(summary)
        if prev_data is not None:
            d = count_diffs(prev_data, data)
            d["from_tick"] = frames[-2]["tick"] if len(frames) >= 2 else None
            d["to_tick"] = summary["tick"]
            d["update_changed"] = prev_update != row.get("voxel_update")
            diffs.append(d)
        prev_data = data
        prev_update = row.get("voxel_update")

    lengths = [f["length"] for f in frames]
    declared_match = [f["declared_matches_length"] for f in frames if f["declared_matches_length"] is not None]
    return {
        "frame_count": len(frames),
        "length_min": min(lengths) if lengths else None,
        "length_max": max(lengths) if lengths else None,
        "length_unique": sorted(set(lengths)),
        "declared_match_ratio": (
            sum(1 for x in declared_match if x) / len(declared_match) if declared_match else None
        ),
        "distinct_hashes": len({f["sha256"] for f in frames}),
        "mean_entropy": round(sum(f["entropy"] for f in frames) / len(frames), 4) if frames else None,
        "adjacent_diffs": diffs[:50],
        "sample_frames": frames[:20],
    }


def collect_smoke_rows(demo_path: Path, max_rows_per_entity: int = 80) -> dict[str, list[dict[str, Any]]]:
    from demoparser2 import DemoParser

    parser = DemoParser(str(demo_path))
    frame = parser.parse_grenades(
        extra=["m_VoxelFrameData", "m_nVoxelFrameDataSize", "m_nVoxelUpdate", "m_nRandomSeed"]
    )
    if not isinstance(frame, pd.DataFrame):
        frame = pd.DataFrame(frame)
    if "grenade_type" in frame.columns:
        frame = frame.loc[frame["grenade_type"] == "CSmokeGrenadeProjectile"]
    by_entity: dict[str, list[dict[str, Any]]] = {}
    for entity_id, group in frame.groupby("grenade_entity_id", sort=False):
        rows: list[dict[str, Any]] = []
        work = group.sort_values("tick")
        # 优先保留 update 变化边界，避免只采前 N 行全是未引爆空帧
        if "m_nVoxelUpdate" in work.columns:
            updates = pd.to_numeric(work["m_nVoxelUpdate"], errors="coerce")
            changed = updates.ne(updates.shift(1)).fillna(True)
            prioritized = work.loc[changed]
            if len(prioritized) < max_rows_per_entity:
                extra = work.loc[~changed].head(max_rows_per_entity - len(prioritized))
                work = pd.concat([prioritized, extra]).sort_values("tick")
            else:
                work = prioritized.head(max_rows_per_entity)
        else:
            work = work.head(max_rows_per_entity)
        for _, row in work.iterrows():
            data = row.get("m_VoxelFrameData")
            if not isinstance(data, (bytes, bytearray)):
                continue
            rows.append({
                "tick": int(row["tick"]) if pd.notna(row.get("tick")) else None,
                "voxel_update": (
                    int(row["m_nVoxelUpdate"])
                    if "m_nVoxelUpdate" in row and pd.notna(row.get("m_nVoxelUpdate"))
                    else None
                ),
                "declared_size": row.get("m_nVoxelFrameDataSize"),
                "random_seed": row.get("m_nRandomSeed"),
                "data": bytes(data),
            })
        if rows:
            by_entity[str(entity_id)] = rows
    return by_entity


def run_analysis(demo_path: Path, out_dir: Path, max_entities: int = 12) -> dict[str, Any]:
    started = time.perf_counter()
    by_entity = collect_smoke_rows(demo_path)
    entity_ids = list(by_entity.keys())[:max_entities]
    entities_out = {}
    for eid in entity_ids:
        entities_out[eid] = analyze_entity_series(by_entity[eid])

    length_counter: collections.Counter[int] = collections.Counter()
    declared_pairs = 0
    declared_matches = 0
    for rows in by_entity.values():
        for row in rows:
            data = row["data"]
            length_counter[len(data)] += 1
            summary = summarize_frame(data, row.get("declared_size"))
            if summary["declared_matches_length"] is not None:
                declared_pairs += 1
                if summary["declared_matches_length"]:
                    declared_matches += 1

    report = {
        "demo": str(demo_path),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "duration_sec": round(time.perf_counter() - started, 2),
        "entities_total": len(by_entity),
        "entities_analyzed": len(entities_out),
        "global": {
            "length_histogram": {str(k): int(v) for k, v in sorted(length_counter.items())},
            "declared_match_ratio": (
                declared_matches / declared_pairs if declared_pairs else None
            ),
            "notes": [
                "若 length 恒为 3072 而 declared_size 变化，优先怀疑定长容量缓冲，有效载荷由 size 字段描述。",
                "本脚本不解码体素网格；解码需在布局假设验证后再做。",
            ],
        },
        "entities": entities_out,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "smoke-voxel-analysis.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-entities", type=int, default=12)
    args = parser.parse_args(argv)
    demo = Path(args.demo)
    if not demo.is_file():
        print(f"找不到 demo: {demo}", file=sys.stderr)
        return 1
    report = run_analysis(demo, Path(args.out), max_entities=args.max_entities)
    print(
        f"entities={report['entities_analyzed']}/{report['entities_total']} "
        f"declared_match={report['global']['declared_match_ratio']} "
        f"out={Path(args.out).resolve()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
