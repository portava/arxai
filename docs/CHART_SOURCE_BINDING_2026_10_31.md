# Chart source binding — 31 October 2026

Status: locally accepted duplicate-work reduction. First-navigation target remains NOT GREEN; no material speedup, competitive parity or architecture-completion claim. No Replit import yet.

Exact final tested source: `8fe1414eb084520ebd382dce3c054c290d65a768` (application `677ca0e3` plus reader token type correction). Production fixture `8f9c308733b0db65`. Baseline `7fd1c3ac399e63b73c25040375dc49df575c9176`, fixture `64a08af4b1ceeaa6`. Parent branch includes the tested object visibility/search controls; held performance experiments excluded.

## Change and review

Previously a source-context change reset the engine, delivered replacement candles, and incremented a state counter that triggered another binding/data-delivery pass. The binding token now combines source context with engine generation. Source changes bind in their existing render; only actual engine creation schedules the additional render needed to expose its ref to children. Source resets, clearing old geometry, stream ownership, deferred comparison setup, styles/studies and reader invalidation remain intact.

A regression proves the previous application delivers nonempty replacement candles twice on a same-provider identity change. The candidate clears old candles first and delivers the replacement once, retaining the engine. Existing tests cover rejected old-stream frames, half-finished drawing cancellation, linked ranges, deferred engine errors and context changes.

The first candidate broke a linked-range test: primary initialization re-registered its peer link twice. It now registers synchronously on creation; only deferred comparison arrival adds a registration generation. The original failing run is retained. The first full check also caught the reader's number-only generation-token type; that declaration was corrected and all final checks rerun on `8fe1414e`.

Review was self-review, not an independent agent review. No source reset or full-readiness gate was removed to save work.

## Validation

- Final frontend: 2,584 passed, 11 skipped, 0 failed.
- Dashboard typecheck/build passed; 87 guards and 7 binding assertions passed.
- Focused candidate: 133/133. Baseline with new regression: 1 failure, 36 passes in stream suite; the new failure is the duplicate delivery.
- Actual Scanner: six symbol/interval combinations preserved exact canonical and displayed candles and historical/nonlive status. Two provider switches separately checked canonical candles, historical/nonlive status and retained chart/adapter identity. A same-provider identity replacement cleared the in-progress drawing tool.
- Actual two-chart workspace: deferred comparison setup, linked zoom, fullscreen controls and Search Escape passed. Strict linked witness requires both ranges to become narrower and correspond within one bar. Primary changed 150–299 to 168.625–280.375; peer changed to 168–281. This matches loaded-bar rounding, not exact fractional range equality. Both engines/data remain unchanged by fullscreen actions.
- First comparison runner wrongly required 200 bars on a standalone page requesting 300, and timed out. Corrected 300-bar run passed; self-review then strengthened its equality-only range check to require a real zoom in both charts. The strict rerun passed. Both earlier receipts remain, and only the strengthened run supports linked-zoom acceptance.
- Root/backend/server/broker lanes not run for this frontend lifecycle change. Expected offline unavailable API errors and blocked background requests remain recorded.

## Matched ordinary navigation

Fresh browser sessions per source, identical strict source/visibility witnesses, no concurrent owned build/test work. Order: baseline 4× then 1×, candidate 1× then 4×. Other host load uncontrolled. Forty planned attempts, all valid and retained.

| CPU / viewport, n=5 each | Baseline median / max | Candidate median / max | ≤100 ms baseline / candidate |
|---|---:|---:|---:|
| 1× desktop | 42.6 / 99.5 ms | 44.1 / 97.8 ms | 5/5 · 5/5 |
| 1× mobile width | 40.3 / 98.8 ms | 39.4 / 99.0 ms | 5/5 · 5/5 |
| 4× desktop | 319.7 / 342.2 ms | 317.3 / 322.9 ms | 0/5 · 0/5 |
| 4× mobile width | 298.3 / 306.3 ms | 287.7 / 305.7 ms | 0/5 · 0/5 |

Small sample sizes, similar/worse normal-CPU medians, and all slow-CPU failures mean this does not establish a reliable overall speedup. Nearest-rank p95/p99 equal the maximum at n=5. The accepted benefit is fewer proven duplicate source deliveries. No changed timing threshold, artificial skeleton success, deferred analysis or discarded outlier. Prior Replit first-navigation and slow-touch failures remain open. This offline 200-bar workload and resized desktop browser do not establish provider, physical-device, heavy-history or TradingView/MT5 performance.

## Evidence and remaining work

Portable runners, compressed complete JSON results and raw-file hashes: `docs/validation/chart-context-bindings-20261031/`. Raw logs: `/Users/areyouok/arx-tier1-release/chart-context-bindings-20261031`. The compressed archive roundtrip was verified. All owned browsers/servers closed.

Replit render-isolation update was still busy at the last read-only check. Retrieve its exact combined validation before importing this candidate or the preceding object controls; preserve concurrent source and existing auth/startup/Truth/safety behavior. No main merge, publish/deploy, existing-database change, worker/trading enablement or broker/live/demo testing occurred.

The initial synchronous mount remains expensive. Continue the exact-source mount investigation; preserve the full competitive scope including catalog completeness, replay/heavy history, touch/accessibility, scripts/server alerts/cloud workspaces and matched competitor workloads. This change addresses one measured redundant binding path, not the complete loading bottleneck.
