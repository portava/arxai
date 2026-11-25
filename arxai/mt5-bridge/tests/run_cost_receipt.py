"""Compile ArxDemoCostReceipt.mqh (EA v1.35) against a fake terminal and pin its wires.

The binary prints the entry result, the close result and one bound tick
envelope. They must equal tests/fixtures/ati_demo_cost_wire.json byte for
byte; the server suite validates that same fixture with the real parsers.
MetaEditor compilation remains a separate required release check.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
compiler = shutil.which(os.environ.get('CXX', 'c++'))
if not compiler:
    raise SystemExit('C++ compiler required for MT5 offline behavior tests (no skip).')
with tempfile.TemporaryDirectory(prefix='arx-cost-test-') as folder:
    binary = Path(folder) / 'cost_receipt_test'
    subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-Wno-format-nonliteral',
                    '-I', str(root), str(root / 'tests/cost_receipt_test.cpp'), '-o', str(binary)], check=True)
    out = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
lines = out.stdout.splitlines()
fixture = json.loads((root / 'tests/fixtures/ati_demo_cost_wire.json').read_text())
expected = [fixture['entryRaw'], fixture['exitRaw'], fixture['boundTick']]
if lines != expected:
    for name, got, want in zip(('entryRaw', 'exitRaw', 'boundTick'), lines, expected):
        if got != want:
            print(f'{name} differs from the fixture:\n  got  {got}\n  want {want}')
    raise SystemExit('EA v1.35 wire changed: update the fixture only together with the server test.')
for line in lines:
    json.loads(line)  # every wire is strict JSON
print(out.stderr.strip(), '| wires match fixture')
