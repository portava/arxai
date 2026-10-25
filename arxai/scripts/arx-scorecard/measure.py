#!/usr/bin/env python3
"""Read-only, exact-commit scorecard. Never runs tests or connects to a database."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RUBRIC = 'scripts/arx-scorecard/rubric.json'

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()

def evaluate(rubric, commit, evidence, evidence_dir, exists=lambda p: True):
    checks = {}
    for key, check in evidence.get('checks', {}).items():
        try:
            path = (evidence_dir / check['log']).resolve()
            path.relative_to(evidence_dir.resolve())
            valid = (bool(check.get('command')) and path.is_file()
                     and hashlib.sha256(path.read_bytes()).hexdigest() == check['sha256'])
        except (KeyError, ValueError, OSError):
            valid = False
        checks[key] = 'UNKNOWN' if not valid else 'PASS' if check.get('exit_code') == 0 else 'FAIL'
    exact = evidence.get('commit') == commit
    rows = []
    for c in rubric['criteria']:
        review = evidence.get('criteria', {}).get(c['id'], {}) if exact else {}
        status, why = 'UNKNOWN', 'No exact-commit evidence.'
        if not c['required'] and c.get('deferral'):
            status, why = 'DEFERRED', c['deferral']
        elif review.get('status') == 'FAIL' and review.get('review'):
            status, why = 'FAIL', review['review']
        elif review.get('status') == 'PASS' and review.get('review'):
            linked = review.get('checks', [])
            if not all(exists(p) for p in c['sources']):
                why = 'A required source document is missing at the measured commit.'
            elif not linked or any(checks.get(k, 'UNKNOWN') == 'UNKNOWN' for k in linked):
                why = 'Required check evidence is missing, unreadable or has an invalid digest.'
            elif any(checks[k] == 'FAIL' for k in linked):
                status, why = 'FAIL', 'A required check failed. ' + review['review']
            else:
                status, why = 'PASS', review['review']
        elif review.get('review'):
            why = review['review']
        rows.append({**c, 'status': status, 'evidence': why, 'checks': review.get('checks', [])})
    sections = {}
    for name in ['architecture', 'verification', 'operations']:
        required = [r for r in rows if r['section'] == name and r['required']]
        sections[name] = {'complete': bool(required) and all(r['status'] == 'PASS' for r in required),
                          'counts': dict(Counter(r['status'] for r in required))}
    complete = sections['architecture']['complete'] and sections['verification']['complete']
    return {'version': 2, 'title': rubric['title'], 'commit': commit,
            'historical': rubric['historical'], 'sections': sections, 'criteria': rows,
            'checks': checks, 'evidence_commit_matches': exact,
            'verdict': 'TIER 1 COMPLETE — READY FOR BROKER VALIDATION' if complete else 'TIER 1 NOT COMPLETE'}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--ref', default='HEAD')
    p.add_argument('--evidence', type=Path)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    commit = git('rev-parse', '--verify', a.ref + '^{commit}')
    rubric = json.loads(git('show', f'{commit}:{RUBRIC}'))
    evidence = json.loads(a.evidence.read_text()) if a.evidence else {}
    files = set(git('ls-tree', '-r', '--name-only', commit).splitlines())
    result = evaluate(rubric, commit, evidence, a.evidence.parent if a.evidence else ROOT, files.__contains__)
    # Results excluding this metadata field are deterministic for the same inputs.
    result['measurement'] = {'at_utc': datetime.now(timezone.utc).isoformat(), 'read_only': True}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(result['verdict'])
    print(f'Measured {commit}; saved {a.output}')

if __name__ == '__main__':
    main()
