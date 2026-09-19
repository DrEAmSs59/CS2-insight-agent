"""Run in a fresh process with PYTHONPATH pointing at an extracted wheel.

All fingerprints are computed AFTER timing. Floats retain their binary64 bits;
columns are sorted, but row and nested-list order are preserved.
"""
from __future__ import annotations

import argparse
import ast
import gc
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    h = hashlib.sha256()

    def feed(v):
        if v is None:
            h.update(b'n')
        elif isinstance(v, bool):
            h.update(b't' if v else b'f')
        elif isinstance(v, int):
            h.update(b'i' + str(v).encode() + b';')
        elif isinstance(v, float):
            h.update(b'd' + struct.pack('<d', v))
        elif isinstance(v, str):
            data = v.encode('utf-8')
            h.update(b's' + struct.pack('<Q', len(data)) + data)
        elif isinstance(v, (bytes, bytearray)):
            h.update(b'b' + struct.pack('<Q', len(v)) + v)
        elif isinstance(v, dict):
            h.update(b'{' + struct.pack('<Q', len(v)))
            for key in sorted(v):
                feed(key)
                feed(v[key])
        elif isinstance(v, (list, tuple)):
            h.update(b'[' + struct.pack('<Q', len(v)))
            for item in v:
                feed(item)
        else:
            raise TypeError(type(v))

    feed(value)
    return h.hexdigest()


def constant(path, name):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


def main():
    args = argparse.ArgumentParser()
    args.add_argument('demo', type=Path)
    args.add_argument('output', type=Path)
    args.add_argument('--reference', action='store_true')
    args.add_argument('--only', default='events,replay,combat,locations,cosmetics,utility,parquet')
    opt = args.parse_args()
    assert 'DEMOTRACER_PROFILE' not in os.environ, 'Disable profiler before benchmarking'
    assert os.environ.get('DEMOTRACER_PROFILE_PROPERTIES') != '1', 'Disable property profiler'
    from demoparser2 import DemoParser
    import demoparser2.demoparser2 as native
    from importlib.metadata import version

    report = dict(demo=str(opt.demo), native_path=native.__file__, version=version('demoparser2'),
                  revision=getattr(DemoParser, 'cpu_runtime_revision', lambda: 'baseline')(),
                  reference=opt.reference, workloads={})
    started = time.perf_counter()
    raw = opt.demo.read_bytes()
    report['file_load_seconds'] = time.perf_counter() - started
    report['input_bytes'] = len(raw)
    report['outer_decompression_seconds'] = 0.0
    report['staging_write_seconds'] = 0.0
    path = opt.demo
    opt.output.parent.mkdir(parents=True, exist_ok=True)
    if opt.demo.suffix == '.zst':
        import cramjam
        started = time.perf_counter()
        raw = bytes(cramjam.zstd.decompress(raw))
        report['outer_decompression_seconds'] = time.perf_counter() - started
        path = opt.output.parent / (opt.demo.stem + '.staged.dem')
        started = time.perf_counter()
        path.write_bytes(raw)
        report['staging_write_seconds'] = time.perf_counter() - started
    report['demo_sha256'] = hashlib.sha256(raw).hexdigest()
    report['demo_bytes'] = len(raw)
    del raw
    started = time.perf_counter()
    parser = DemoParser(str(path))
    report['constructor_seconds'] = time.perf_counter() - started
    opt.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        opt.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

    def measure(name, fn):
        gc.collect()
        started = time.perf_counter()
        value = fn()
        total = time.perf_counter() - started
        native_s = parser.last_parse_seconds()
        result = dict(total_seconds=total, parse_seconds=native_s,
                      bridge_export_seconds=total-native_s, sha256=digest(value))
        if isinstance(value, dict):
            result['columns'] = {k: dict(length=len(v) if hasattr(v, '__len__') else None, sha256=digest(v)) for k,v in sorted(value.items())}
        report['workloads'][name] = result
        save()
        print(name, round(total, 3), result['sha256'], flush=True)
        return value

    # Real analysis event scan, with round events also supplying reproducible replay windows.
    names = list(constant('app/features/demo_analysis/analyzer.py', '_SHARED_BATCH_EVENT_NAMES'))
    player = list(constant('app/features/demo_analysis/analyzer.py', '_SHARED_BATCH_PLAYER_FIELDS'))
    events = measure('events', lambda: dict(parser.parse_events(names, player=player,
                         other=['total_rounds_played', 'winner', 'reason', 'site'])))
    by_name = dict(events)
    ends = by_name['round_end']['tick']
    starts = by_name['round_freeze_end']['tick']
    windows = [(i+1, t, next((end for end in ends if end > t), t)) for i,t in enumerate(starts)]
    windows = [(i,s,e) for i,s,e in windows if e>s]
    sys.path.insert(0, str(ROOT))
    from app.features.demo_analysis.replay_match_cache import _sample_ticks
    pairs = {tick:i for i,s,e in windows for tick in _sample_ticks(s,e,64.0,32.0)}
    ticks = sorted(pairs)
    sparse = sorted(set(by_name.get('weapon_fire', {}).get('tick', [])))
    fields = list(constant('app/features/demo_analysis/replay_match_cache.py', '_RAW_PLAYER_FIELDS'))
    reference = {'_reference': True} if opt.reference else {}
    selected = set(opt.only.split(','))
    queries = {
        'replay': (fields, ticks),
        'combat': ([f'CCSPlayerController.CCSPlayerController_ActionTrackingServices.{p}' for p in
                    ['m_iKills','m_iDeaths','m_iAssists','m_iDamage','m_flTotalRoundDamageDealt']], sparse),
        'locations': (['last_place_name'], None),
        'cosmetics': (['inventory','weapon_stickers','weapon_skin_id','item_id_high','item_id_low',
                      'item_def_idx','glove_paint_id','glove_paint_seed','glove_paint_float'], sparse),
    }
    report['sample_ticks'] = len(ticks)
    report['sparse_ticks'] = len(sparse)
    for name, (props, sample) in queries.items():
        if name in selected:
            value = measure(name, lambda: parser.parse_ticks(props, ticks=sample, **reference))
            del value
    if 'utility' in selected:
        value = measure('utility', parser.parse_utility_effects)
        del value
    if 'parquet' in selected:
        parquet = opt.output.with_suffix('.parquet')
        metadata = measure('parquet', lambda: parser.write_replay_parquet(str(parquet), fields, ticks, [pairs[t] for t in ticks]))
        # Complete logical readback plus exact file hash, all outside write timing.
        groups = [DemoParser.read_replay_parquet_round(str(parquet), group['row_group']) for group in metadata['row_groups']]
        report['workloads']['parquet']['logical_sha256'] = digest(groups)
        report['workloads']['parquet']['file_sha256'] = hashlib.sha256(parquet.read_bytes()).hexdigest()
        save()
    report['complete'] = True
    save()


if __name__ == '__main__':
    main()
