"""Extra real-demo regression checks against the complete DemoTracer decode plan.

Run after benchmarking, not concurrently. Pass uncompressed DEM paths.
"""
import argparse
import json
from pathlib import Path

from benchmark_demoparser_cpu import digest
from demoparser2 import DemoParser, WantedPropState


def verify(path):
    parser = DemoParser(str(path))
    events = parser.parse_events(['weapon_fire', 'round_freeze_end'])
    ticks = sorted({t for _, table in events for t in table.get('tick', [])})
    # Every event boundary plus adjacent exact ticks, including segment boundaries
    # encountered throughout the complete match.
    sampled = sorted({t+d for t in ticks[::max(1,len(ticks)//600)] for d in (-1,0,1)})
    continuous = ['X','Y','Z','health','entity_id','total_rounds_played','damage_total',
                  'ducked','ducking','usercmd_input_history','usercmd_subtick_moves',
                  'usercmd_client_tick','usercmd_buttonstate_1','usercmd_forward_move',
                  'usercmd_viewangle_x','usercmd_viewangle_y']
    cosmetics = ['inventory','inventory_weapon_cosmetics','weapon_stickers',
                 'weapon_skin_id','weapon_paint_seed','weapon_float','glove_paint_id',
                 'glove_paint_seed','glove_paint_float']
    results = {}
    for name, props, kwargs in [
        ('continuous', continuous, {'ticks':sampled}),
        ('cosmetics_full', cosmetics, {'ticks':sampled}),
        ('aliases', ['damage_total','damage_total','X','entity_id','total_rounds_played'], {'ticks':sampled}),
        ('state_fallback', ['X','Y','health'], {'ticks':sampled,'prop_states':[WantedPropState('health',100)]}),
    ]:
        actual = parser.parse_ticks(props, **kwargs)
        expected = parser.parse_ticks(props, _reference=True, **kwargs)
        a,b = digest(actual),digest(expected)
        different = [key for key in actual.keys() | expected.keys() if digest(actual.get(key)) != digest(expected.get(key))]
        results[name] = dict(sha256=a, reference_sha256=b, equal=a==b, different_columns=different)
        if name == 'continuous' and actual.get('steamid'):
            player = next(x for x in actual['steamid'] if x)
            a = digest(parser.parse_ticks(props, players=[player], ticks=sampled))
            b = digest(parser.parse_ticks(props, players=[player], ticks=sampled, _reference=True))
            results['player_filter'] = dict(sha256=a,reference_sha256=b,equal=a==b)
    purchases = parser.parse_event('item_purchase')
    results['item_purchase'] = dict(sha256=digest(purchases), columns=sorted(purchases))
    assert all(row.get('equal', True) for row in results.values()), results
    return results


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('output',type=Path)
    cli.add_argument('demos',nargs='+',type=Path)
    args = cli.parse_args()
    results = {str(path):verify(path) for path in args.demos}
    args.output.write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps(results,indent=2))
