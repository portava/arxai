# Smart Chart initial candle binding — 31 October 2026

Status: accepted usability fix; first-navigation latency remains open. No architecture-complete, launch-ready or competitor-parity claim.

## Exact source

Branch `codex/chart-initial-binding-20261031`, base `21fd3918884bbb5b8c2e4a104d211ed79c207974`. Application commits `3e1bbdd3` and final **`f9eb6c5d2ca3f92f9c0661da74c943d32578e2be`**. Final browser fixture `5910e67713b9da39` was built clean from that application. Subsequent receipt commit does not alter application code.

## Behavior

Opening Studies and typing while initial candles load now preserves the same input, query and keyboard focus. A committed workbench generation distinguishes initial source binding from real provider/market/interval changes; the latter still reset the workbench. Losing candles after a previous binding does not grant another initial-load exemption. Chart engine, truth and data reset paths are unchanged.

On the transition from empty to populated history, an active field inside the toolbar scrolls into view only if it would otherwise be outside the visual viewport. It never takes focus. External focus causes no geometry read; already-visible fields do not scroll. Keyboard-sized visual viewports are covered.

## Validation on final application

- Full frontend: **2619 passed, 11 skipped, 0 failed**; 179 passing files and one skipped file.
- Dashboard typecheck and production build pass; **87/87 guards and 7/7 binding assertions** pass.
- Actual Scanner offline production fixture: **16/16 browser checks** at 1440×1100 and 390×844. Synthetic 200-bar candle response held then released; exact input identity, query, focus, full source equality, visible/unobscured focused field, provider-change reset, no overflow and no page exceptions checked.
- Screenshots visually inspected: focused Donchian query readable in both layouts. Mobile scrolls to the active tool; this is not acceptance of the entire chart being visible simultaneously. Fixture shows historical/unavailable analysis and blocked trading.
- Self-review only; no independent agent review. Full root/backend/database lanes were not rerun for this frontend change. No real provider, authenticated-owner or broker acceptance.

## First-navigation measurements: no meaningful speedup

Timings are on intermediate **3e1bbdd3**, fixture `63b873a0642398c8`, versus baseline application **f1a47fcc791742a2c7e6ed20451a65f60bcce479**, fixture `7b91fefefadc931a`. Final focus-visibility addition f9eb6c5d was **not re-timed**. Do not attribute these timings to it.

Unchanged runner: fresh documents, 200 synthetic bars, 80 ms candle delay, complete canonical/displayed source witness, minimum 100×100 visible/unobscured chart and two paint frames. Readiness-to-click budget 150 ms; visible completion target 100 ms. Forty slots, all valid: 20 normal-speed completion passes, 20 slowed completion failures. Five samples per viewport/variant; p95/p99 equal maximum at this sample size. Order: baseline 4× then 1×; candidate 1× then 4×.

| CPU / viewport | Baseline median / max ms | Candidate median / max ms |
|---|---:|---:|
| 1× desktop | 51.6 / 52.8 | 53.6 / 57.3 |
| 1× mobile | 50.8 / 71.8 | 49.2 / 51.3 |
| 4× desktop | 386.5 / 430.5 | 386.0 / 387.8 |
| 4× mobile | 372.5 / 385.8 | 374.1 / 394.9 |

The result supports preserving active work, not faster navigation. Next performance work should examine synchronous page mounting and route/tab work using exact-source evidence, rather than repeat toolbar micro-optimizations or relax acceptance gates.

## Failures retained

Baseline new regression: 39 pass / 1 fail. Viewport regression before fix: 37 pass / 1 fail. The first browser attempt passed desktop checks then timed out on mobile because the harness inspected compact Tools visibility before layout settled. Explicitly awaiting that control produced 14/14 passes. A stronger visible-field check then exposed a real mobile bug after 11 checks: focus survived below the viewport. Final application fixes that bug and passes 16/16. All attempts, timing failures, logs, scripts, JSON and screenshots are archived without discarding outliers.

## Separate Replit completion

Read-only connector report, not independently rerun local evidence: earlier object-navigation integration finished at application **49d13ac49fff432db8ff947e93feecf7c4aa5bc2**, workspace checkpoint **140121e380c3905eca67d6a0d72ffdd508bc45f9**, recovery **a1c6d9b31df8249bafab0e941170b5226613a368**. Workspace clean. Frontend 2588 pass / 11 skip / 0 fail; account scheduling 13, recorder/disclosure 22, guards 87, binding 7 all pass; types and both builds pass. Large-chunk warning remains.

Navigation: **0 valid, 4 invalid, 16 unstarted**; valid median/max null. Normal ready→click 165.9/175.7 ms; completion 156.8/290.9 ms. Slowed ready→click 202.6/172.5 ms; completion 1034.2/984.4 ms. All fail unchanged readiness and completion budgets. Earlier 40 invalid slots, two 180-second sustained-zoom timeouts and other loading/touch failures remain open. Four short zoom observations establish no sustained improvement. Comparison checks skipped; replay, owner-authenticated and real-provider acceptance unverified. Detailed connector response retained in the archive.

Volume-evidence, range-study and initial-binding follow-ups are separate local/GitHub source at this report time; their results must not be attributed to that Replit checkpoint.

## Evidence and boundaries

Archive: `docs/validation/chart-initial-binding-20261031/manifest.json` records original and archive SHA-256 hashes. Non-image files are gzip-compressed; images retained directly. Raw local folder: `/Users/areyouok/arx-tier1-release/chart-initial-binding-20261031`.

No main merge, publishing, deployment, existing-database change, worker activation or live/demo broker test. Owned local browser sessions and fixture server stopped after validation. Held performance branches remain excluded.
