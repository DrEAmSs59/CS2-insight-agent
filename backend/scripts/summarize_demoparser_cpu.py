"""Validate complete benchmark fingerprints and summarize three-run medians."""
import argparse
import json
from pathlib import Path
from statistics import median


def summarize(root):
    manifest = json.loads((root/'manifest.json').read_text(encoding='utf-8-sig'))
    result = {'manifest':manifest, 'samples':[]}
    for index, demo in enumerate(manifest['demos']):
        runs = {variant:[json.loads((root/f'sample-{index}-round-{round_}-{variant}.json').read_text(encoding='utf-8'))
                          for round_ in range(1,manifest['rounds']+1)] for variant in ('before','after')}
        reference = json.loads((root/f'sample-{index}-reference.json').read_text(encoding='utf-8'))
        assert reference['complete'] and all(r['complete'] for values in runs.values() for r in values)
        sample = {'demo':demo,'demo_sha256':reference['demo_sha256'],'workloads':{},'stages':{}}
        for name in reference['workloads']:
            row = {}
            for variant, values in runs.items():
                measured = [v['workloads'][name] for v in values]
                assert len({m['sha256'] for m in measured})==1, (demo,name,variant,'unstable output')
                row[variant] = {k:median(m[k] for m in measured) for k in ('total_seconds','parse_seconds','bridge_export_seconds')}
                row[variant]['sha256'] = measured[0]['sha256']
                if name == 'parquet':
                    for key in ('logical_sha256','file_sha256'):
                        assert len({m[key] for m in measured})==1, (demo,variant,key)
                        row[variant][key]=measured[0][key]
            row['speedup_percent'] = (1-row['after']['total_seconds']/row['before']['total_seconds'])*100
            row['baseline_equal'] = row['before']['sha256']==row['after']['sha256']
            row['reference_equal'] = row['after']['sha256']==reference['workloads'][name]['sha256']
            assert row['reference_equal'],(demo,name,'reference mismatch')
            if name=='parquet':
                key = 'logical_sha256'
                assert row['before'][key]==row['after'][key]==reference['workloads'][name][key], (demo,key)
                row['file_bytes_equal'] = row['before']['file_sha256']==row['after']['file_sha256']
                assert row['after']['file_sha256']==reference['workloads'][name]['file_sha256'], (demo,'reference file bytes')
            before_cols=runs['before'][0]['workloads'][name].get('columns',{})
            after_cols=runs['after'][0]['workloads'][name].get('columns',{})
            row['changed_columns']=[k for k in sorted(before_cols.keys() | after_cols.keys()) if before_cols.get(k)!=after_cols.get(k)]
            sample['workloads'][name]=row
        for stage in ('file_load_seconds','outer_decompression_seconds','staging_write_seconds','constructor_seconds'):
            sample['stages'][stage]={v:median(r[stage] for r in values) for v,values in runs.items()}
        suite = ('events','combat','locations','cosmetics','utility','parquet')
        sample['suite']={v:{stage:median(sum(r['workloads'][w][stage] for w in suite) for r in values)
                           for stage in ('total_seconds','parse_seconds','bridge_export_seconds')} for v,values in runs.items()}
        sample['suite']['speedup_percent']=(1-sample['suite']['after']['total_seconds']/sample['suite']['before']['total_seconds'])*100
        result['samples'].append(sample)
    (root/'summary.json').write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(result,indent=2,ensure_ascii=False))


if __name__ == '__main__':
    cli=argparse.ArgumentParser(); cli.add_argument('root',type=Path)
    summarize(cli.parse_args().root)
