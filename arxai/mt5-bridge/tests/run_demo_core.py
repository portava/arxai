"""Compile the actual MQL execution core against a fake terminal; no broker I/O.

The core uses the common C++/MQL subset. Extract the actual wire parser/poller
as well, so fixtures exercise the production volume and ticket decoding.
MetaEditor compilation remains a separate required release check.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
compiler = shutil.which(os.environ.get('CXX', 'c++'))
if not compiler:
    raise SystemExit('C++ compiler required for MT5 offline behavior tests (no skip).')
# v1.31 and v1.32 share ArxDemoExecution.mqh: v1.31 still runs the original
# checks against its own poller; v1.32 adds the pending-order / TTL checks.
for ea, start, defines in (('ReplitMT5BridgeEA_v131.mq5', 'ulong DemoReadTicket(', []),
                           ('ReplitMT5BridgeEA_v132.mq5', 'ulong DemoReadTicketField(', ['-DARX_V132'])):
    source = (root / ea).read_text()
    with tempfile.TemporaryDirectory(prefix='arx-demo-test-') as folder:
        folder = Path(folder)
        parsers = source[source.index('long JsonReadInt('):source.index('// v1.31 — read a boolean')]
        poller = source[source.index(start):source.index('//| Lifecycle')]
        (folder / 'ea_wire.inc').write_text(parsers + '\n' + poller)
        binary = folder / 'demo_core_test'
        subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', *defines,
                        '-I', str(folder), '-I', str(root),
                        str(root / 'tests/demo_core_test.cpp'), '-o', str(binary)], check=True)
        print(ea + ':', end=' ', flush=True)
        subprocess.run([str(binary)], check=True)
