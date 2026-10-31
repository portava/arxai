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
