#!/usr/bin/env python3
"""Build CSV and a self-contained, offline HTML dashboard from v2 metrics."""
import argparse
import csv
import html
import json
from pathlib import Path

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('metrics', type=Path)
    p.add_argument('--output-dir', type=Path, required=True)
    a = p.parse_args()
    data = json.loads(a.metrics.read_text())
    a.output_dir.mkdir(parents=True, exist_ok=True)
    fields = ['id', 'domain', 'section', 'requirement', 'status', 'evidence']
    with (a.output_dir / 'scorecard.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(data['criteria'])
    esc = lambda x: html.escape(str(x))
    rows = ''.join('<tr>' + ''.join(f'<td>{esc(r[k])}</td>' for k in ['domain','requirement','status','evidence']) + '</tr>' for r in data['criteria'])
    sections = ''.join(f'<p><strong>{esc(k.title())}</strong>: {"complete" if v["complete"] else "incomplete / unverified"} — {esc(v["counts"])}</p>' for k,v in data['sections'].items())
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARX Tier 1 Scorecard v2</title><style>body{{font:16px system-ui;margin:32px auto;max-width:1200px;padding:0 20px;color:#17302b;background:#f6f7f3}}h1{{font-size:32px}}table{{border-collapse:collapse;width:100%;background:white}}th,td{{padding:12px;text-align:left;border-bottom:1px solid #ccd6cf;vertical-align:top}}th{{background:#17302b;color:white}}code{{overflow-wrap:anywhere}}.table{{overflow:auto}}</style>
<h1>{esc(data['title'])}</h1><h2>{esc(data['verdict'])}</h2>
<p>Measured commit: <code>{esc(data['commit'])}</code><br>Measured at: {esc(data['measurement']['at_utc'])}</p>
<p>{esc(data['historical'])}</p>{sections}
<p>Missing evidence is UNKNOWN. Operational readiness is independent of architecture completion. No production actions are performed by this scorecard.</p>
<div class="table"><table><thead><tr><th>Component</th><th>Completion gate</th><th>Status</th><th>Evidence / next action</th></tr></thead><tbody>{rows}</tbody></table></div></html>'''
    (a.output_dir / 'index.html').write_text(page)
    print(a.output_dir / 'index.html')

if __name__ == '__main__':
    main()
