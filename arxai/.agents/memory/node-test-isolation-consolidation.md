---
name: node:test tsx unit consolidation
description: How to collapse many cold-start `node --import tsx --test` CI scripts into one shared process without losing coverage or correctness.
---

# Consolidating cold-start node:test tsx unit scripts

**Rule:** `node --import tsx --test <fileA> <fileB> …` does NOT share a process —
node's default `--test-isolation=process` spawns a child per file, so every file
re-pays the full tsx loader/module-graph startup (~5-9s each; a bare tsx no-op is
already ~1s). To run many fast pure-unit test files in ONE process pass
`--test-isolation=none` (Node 22.8+; this repo is Node 24). Empirically this cut
the api-server fast-unit group from ~36s (per-file children) to ~7-9s for the
same 127 assertions.

**How to apply (the `test:fast-unit` umbrella pattern):**
- Add ONE aggregator script that lists every underlying `*.test.ts` file with
  `--test-isolation=none --test --test-force-exit` (and
  `--experimental-test-module-mocks` if any file needs it).
- Reference the umbrella in root `ci`; keep each original `test:*` script for
  standalone debugging and add them to `MANUAL_ONLY` in
  `check-test-scripts-wired.ts` as "covered by the <umbrella> umbrella" (same
  precedent as `test:timing-*`). Lockstep or the guard fails.

**Module-mock safety in a shared (`isolation=none`) process:**
`mock.module()` called at a file's top level (not inside a hook) is NEVER
restored — it replaces the module in the loader registry for the whole process.
It is only safe to co-locate such a file with others when the mock is a strict
SUPERSET of the real module (`{ ...realRouter, routeCandles: stub }`) so any
other file importing that module still gets real behaviour for everything else.
Even so, place the module-mock file LAST in the arg list for determinism. If a
mock ever narrows/removes a real export, it must run in its own process.

**Exclude wall-clock / latency-sensitive files — keep them STANDALONE:** tests
that assert on interval boundaries, tick/stream latency, or elapsed-time windows
can PASS alone (and in small pairs) yet FLAKE inside a long (~35s) shared
`isolation=none` run, because the shared event loop shifts WHEN their assertions
land relative to a real-time interval. Empirically `formingBar` (its `[C1]/[C2]
includeFormingTip` interval assertions) and `formingTickStreamLatency` flake
folded-in but pass standalone x2 — keep them individually wired in `ci`, NOT in
the umbrella. Diagnose by bisecting: full-set-minus-suspect green + suspect-alone
green ⇒ load/timing sensitivity, not cross-file state leak. A second top-level
`mock.module` file (e.g. the app `marketScanner` mock in `aiHelperSimulatorMask`)
also stays standalone rather than risk two non-superset mocks in one process.

**Audit for double-wiring before folding:** a file can ALREADY be listed inside
the umbrella's arg list AND still have its own individual `ci` step — it then
runs twice. Folding a file = (a) ensure it's in the umbrella list, (b) delete its
redundant individual `ci` step, (c) allowlist its key in `MANUAL_ONLY`, all in
lockstep (the guard fails if a key is both wired in `ci` and allowlisted).

**Why:** the fixed per-process tsx start dominates CI wall-clock far more than
the test bodies (most run <25ms), so collapsing cold starts is the single
biggest CI-time win for these pure suites.
