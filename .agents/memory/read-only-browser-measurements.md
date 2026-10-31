---
name: Read-only browser measurements
description: Prevent passive Scanner navigation from causing automatic application writes during read-only QA.
---

For read-only browser measurements, block every non-GET/HEAD/OPTIONS request at
the browser-context level before the first navigation. Merely avoiding Scan or
Trade buttons is not enough. Keep real GET data and its source/freshness gates;
do not fulfill writes with fake success or substitute candles.

**Why:** A prior Scanner acceptance pass observed an automatic alert-scan POST
even though the tester never clicked Scan. The owner explicitly requires new
navigation measurements to block automatic background writes.

**How to apply:** Record blocked attempts separately from real requests and
ordinary QA login/logout. Permit only the tester's normal logout after timing.
Keep page/controls, correct candles and completed-analysis timings separate;
module or empty-canvas readiness must not be reported as data readiness.

Immediate-first-click acceptance must also record navigation-ready-to-click
delay. Batch passive timing and navigation rather than allowing tool/model
roundtrips to leave the page idle for tens of seconds. Preserve biased samples
as warm observations, not cold-click acceptance. Later screenshots are paint
upper bounds, not first-paint timestamps.

**Why:** An initial timing pass left modules fully warmed before the first click;
visible reader content and late pixel checks did not establish fresh first paint.

**How to apply:** Keep failed/late samples, explicitly mark onboarding or runner
blockers, and do not claim a target pass when precise readiness is unverified.

Archive the actual browser/runtime, CPU controls, complete outer driver and
enforced execution deadlines before timing. Persist each pending attempt before
navigation and each result after collection, outside the measured interval.
An unfinished slot is incomplete evidence, not zero attempts or a passing run.

**Why:** A short outer browser-action deadline previously discarded an entire
idle batch held only in memory. Browser-side measurement timeouts do not extend
the outer tool's budget.

**How to apply:** Use separate sufficiently bounded batch executions and recover
private journals after browser/server exit. Permit diagnostic writes only to an
isolated recorder, never an application API. Distinguish mock preparation,
browser responseEnd, cache readiness, module evaluation and confirmed rendering;
none proves the next stage, and overlapping tasks do not establish causation.

A missing Playwright-managed executable does not establish that no browser is
available. Check existing workspace browser executables before proposing an
installation. Workspace and remote-automation loopback/runtime are not equivalent.

**Why:** The managed browser cache was absent while an existing workspace
Chromium was usable; remote and workspace fixture preflights also differed.

**How to apply:** Preserve no-install boundaries, verify the executable actually
launched, label the execution realm and CPU observability limits, and never
attribute timing differences between unlike runtimes to application improvement.

Match a fixture's storage-reset policy to the scenario before testing saved
preferences or drawings across reload. An intentional fixture reset is not a
product persistence failure.

**Why:** Initial chart acceptance runs used fresh-navigation reset semantics;
reload therefore discarded the synthetic studies/annotations being tested.

**How to apply:** Use the fixture's existing preservation opt-in in an isolated
profile for persistence acceptance, retain reset semantics for fresh-navigation
measurements, and archive the original failures. Do not change application
storage behavior or silently replace failed receipts to repair a fixture setup.
