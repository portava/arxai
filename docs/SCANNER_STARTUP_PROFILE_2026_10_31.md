# Scanner startup diagnosis and Replit checkpoint — 31 October 2026

Status: diagnostic evidence and development handoff, not a new performance fix. No application changes in this branch. Goal remains incomplete.

## Authoritative Replit completion

The read-only connector reports the pending-engine import complete, clean, with no newer tracked changes:

- Application **e83090cbb14b130a679130d43764670e644d5e15**.
- Workspace checkpoint **6243c71939ad9801e9de044e75a33c208ad18595**.
- Recovery **b96382154517ae2acfd2a5267e5625d061d31472**.
- Branch `codex/pr103-smart-chart-development-20261031`.
- Frontend 2,623 pass / 0 fail / 11 skip; pure API76, scheduling13, recorder22, guards87, bindings7 pass; typechecks and both builds pass. Existing large-chunk warning retained.
- 39 distinct offline browser checks across57 passing executions. Do not count57 as distinct checks.

One normal-CPU desktop navigation attempt has true source and visibility witnesses but fails timing acceptance: readiness-to-click1,393ms versus150ms, first container166.3ms after click, full source-correct visible completion239.3ms versus100ms. **0 valid /1 invalid /9 unstarted; valid median/max null.** No subsequent timing attempts were run. Three corrected browser-harness failures and one reporting-parser failure remain recorded. Earlier0valid/4invalid/16unstarted, older40invalid slots and both sustained-zoom timeouts remain unresolved. These results belong to this remote source, not local DMI/drawing-shortcut sources.

API activation remains deferred; the API was not restarted, so the volume correction still lacks refreshed-process acceptance. Topbar fixture picker503, owner-authenticated/provider, physical-device and actual comparison/linked-range browser gaps remain explicit. Remote report `ARX_CHART_PENDING_ENGINE_DEVELOPMENT.md`; evidence `generated-artifacts/arx-pending-engine-validation/`. This is connector-reported evidence; raw remote files have not been independently inspected locally.

## Fresh local diagnosis

Clean source **bcba1b6115f1333210167f93c6d2f7b4a3d25d02**, application **d83a02d773743990704465548af7cea556851d0c**. Diagnostic fixture **8f6acf0b362423f1** on its separate loopback origin. Existing React profiling runtime, candle timeline and Chrome CPU sampling at500µs; two trusted navigation visits, desktop1440×1100 and phone-width390×844, 4× CPU throttle. All owned build/test work finished before capture. No performance acceptance sample was produced by this profiling runtime.

| Observed stage relative to click | Desktop ms | Phone-width ms |
|---|---:|---:|
| Candle fetch starts |29.5|−41.4|
| Fetch callback resolves / JSON starts |177.4|216.0|
| JSON promise resolves |364.6|253.7|
| Query success |365.5|254.9|
| First200-bar engine installation starts |416.1|290.6|
| First200-bar engine installation ends |418.6|292.8|

Both traces retain a later second200-bar installation; no samples or outliers discarded. Timeline dropped0 events. Mobile prefetch began before the click, so the two visits are not a matched comparison. JSON elapsed time includes scheduling, not just parsing CPU. Engine installation is only one stage, not source-correct visible completion.

Sampled CPU self-time points to the workbench's synchronous layout-measurement callback:36.375ms desktop and44.721ms mobile. The compiled location was checked against the actual build: the layout effect reads computed padding and client width before installing ResizeObserver. Much sampled time is native/program, React, DOM operations or profiling overhead and remains unattributed. The CPU sample window also includes pre-click actionability and post-render work. Do not sum nested fiber times or assign this entire duration to first chart load.

This finding confirms that synchronous measurement deserves investigation; it does not prove removing it will improve completed rendering. The prior observer-only/compact-first toolbar experiment **81b7f0a8** remains **HELD**: its repeated source-correct mobile results did not show a consistent gain and all slowed attempts failed100ms. That earlier report was reread at `/Users/areyouok/arx-chart-toolbar-layout-20261031/docs/SCANNER_TOOLBAR_LAYOUT_EXPERIMENT_2026_10_31.md`. It is not an accepted base and must not be imported into Replit. No held candidate was installed here.

## Next actions

1. Selectively import the already tested drawing shortcuts and DMI from **bcba1b61**, tested application **d83a02d7**, into the completed Replit checkpoint, preserving concurrent changes. These features have their own exact-source tests and browser receipts; they do not claim to resolve startup speed.
2. Obtain the resulting combined source, checkpoint and actual validation, with failures/skips/unstarted runs retained. Keep API activation deferred.
3. Use this trace to design a materially different startup candidate or deeper layout attribution. Preserve focus/disclosure, actual source correctness and the unchanged readiness/completion gates. Do not simply reinstall the old observer-only candidate or mask work behind early feedback.
4. Real-provider, owner-authenticated, physical-device and matched competitor validation remain open. No architecture percentage or parity claim.

## Evidence and boundaries

Raw `/Users/areyouok/arx-tier1-release/chart-startup-profile-20261031`; portable archive `docs/validation/chart-startup-profile-20261031/manifest.json`, original/archive SHA-256 checksums. The capture script and full CPU profiles are retained for repeatability. Existing diagnostic tooling built successfully; no application edits require a fresh full regression run. The latest application checks remain tied to d83a02d7 in the DMI report. Local owned browser/server closed.

No main merge, deployment, existing database changes, API/worker activation, funds movement or live/demo broker tests. TradingView/MT5 capability and performance gaps remain open.
