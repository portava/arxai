# Scanner toolbar layout experiment — 31 October 2026

**HELD: do not install this experiment in Replit or use it as the next development
base.** The slow-CPU navigation target still fails; desktop improves modestly,
mobile does not show a consistent end-to-end improvement. Tests passing are not
performance acceptance. No main merge, deployment, database, worker or broker work.
Continue application work from 4944c950 (app b107f1db), preserving this branch.

## Evidence and implementation

The new durable navigation recorder reproduced slow first-click rendering locally
at 4× CPU slowdown. Baseline first post-click long tasks were 119–158ms; all ten
attempts missed 100ms. A CPU profile pointed to synchronous toolbar measurement:
getComputedStyle/clientWidth during the initial layout effect. Its sampled
callback self-time was about 39.8ms. **The profile only retained the final document
across the reload sequence**, about 1.217 seconds/975 samples. It cannot attribute
all navigation cost, establish the remote Replit cause or explain every sample.
Much time remained in program/native/React work; do not call the toolbar the sole cause.

Candidate fa85336f4d7c9e33ae587bae66d0e0020b2d20fd uses ResizeObserver's content
width instead of forcing a synchronous mount measurement. A synchronous state
commit in the observer preserves disclosure/focus changes before its paint phase.
The observer is stable across opening/closing Tools; obsolete deliveries and
non-finite/zero widths are ignored. Keyboard focus still moves before controls
hide. Two regression tests failed before this change (three passed).

Initial results were mixed, so 81b7f0a8e9f127df9bbaf56048cd68f0b49655c2 also starts
narrow viewports collapsed rather than first laying out expanded mobile controls.
Actual pane size is still authoritative after observation. That regression test
failed before the follow-up; five others passed. This is a local candidate, not
installed application behavior. Review was a separate self-review, not another agent.

## Exact-source checks

- fa85336f: 2560 frontend pass / 11 skip / 0 fail; 87 guards, 7 bindings,
  dashboard typecheck/build and clean isolated production fixture build pass.
- 81b7f0a8: 2561 frontend pass / 11 skip / 0 fail (175 files pass / 1 skip),
  87 guards, 7 bindings, dashboard typecheck/build and fixture build pass.
- Final fixture a48be51297ad7d78; initial candidate 8954a87ac8bfc2f6;
  unchanged baseline tooling 643899a0, fixture 231a719410806a0e.
- Full root/backend CI was not run for this frontend-only candidate. Build
  sourcemap/chunk-size warnings and jsdom navigation notices remain in logs.

## Actual Scanner measurements

Headless Chrome 156.0.8078.79, Mac-compatible UA, 14 logical processors reported,
DPR1. Controlled CDP CPU slowdown 4×, returned to1× afterward. Quiet local window;
no concurrent local build/tests. Synthetic historical200bars, mocked80ms response,
reader unavailable. Production fixture imports the actual Scanner/App. Full
reloads with prepared browser resources, not cold browser-process startup.
No real provider, physical-device, physical-paint, published-app or competitor proof.

Each row has five desktop and five emulated-mobile attempts. All source/build/OHLC
and 150ms click-readiness checks passed. The same100ms completed-chart target
remains unchanged; valid measurements can still fail that target.

| Source/run | CPU | Desktop median / max | Mobile median / max | Under100ms |
|---|---:|---:|---:|---:|
| Baseline first |4×|331.8 /354.4ms|272.0 /297.5ms|0/10|
| Baseline repeat |4×|318.0 /332.5ms|262.3 /298.6ms|0/10|
| fa85336f initial candidate |4×|297.7 /323.5ms|292.7 /295.2ms|0/10|
| 81b7f0a8 final first |4×|296.1 /337.4ms|257.8 /285.9ms|0/10|
| 81b7f0a8 final repeat |4×|293.9 /304.3ms|264.7 /266.2ms|0/10|
| 81b7f0a8 ordinary CPU |1×|38.1 /97.6ms|37.7 /99.1ms|10/10|

All60 measured attempts remain; no failures/outliers discarded. The additional
10 profiled attempts remain explicitly diagnostic-only and are excluded from
performance comparisons. Earlier 1× baseline results belong to the previous
receipt report; do not present these runs as a controlled 1× A/B comparison.
The modest desktop shift and overlapping mobile results do not justify an
across-device speedup claim or installation as the latency fix.

Actual-browser resize/focus checks passed on both candidate commits: wide-to-narrow
focus moves to Tools, widening returns it to Pan, open tools preserve focus across
resizes, Escape collapses safely. Full canonical/display data and engine identity
stay unchanged; no horizontal document overflow or page exceptions. Screenshots
were inspected. These are bounded focus/layout checks, not full mobile acceptance:
the floating assistant can still overlap lower content at some scroll positions.
The synthetic-data safe-mode warning and unavailable automated reading are expected.

## Next actions

1. Keep this experiment isolated and backed up. Do not import it with the Replit
   navigation-recorder update already running. That update was still confirmed
   busy at the last read-only check; it was not restarted.
2. Retrieve that exact remote run's evidence before attributing its delay.
3. Profile the remaining initial Scanner render/layout, including below-fold
   panels and repeated chart/parent commits. Test candidates against complete
   source-correct rendering, layout/focus and mobile behavior; do not mask slow work
   behind an early-feedback success mark or weaken gates.
4. Real authenticated first-click latency, broker/runtime validation and
   TradingView/MT5 capability/performance gaps remain open. Architecture incomplete.

Receipts: docs/validation/scanner-toolbar-layout-20261031/manifest.json.
Full raw logs: /Users/areyouok/arx-tier1-release/scanner-navigation-profile-20261031.
Owned browsers and fixture servers closed. Replit's separate authorized update
remains in progress; no new update was submitted by this experiment.
