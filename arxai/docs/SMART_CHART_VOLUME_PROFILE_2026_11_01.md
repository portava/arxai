# Smart Chart estimated Volume Profile and evidence alignment — 1 November 2026

Application source: `f6e64fbea949e3ce21a99696dfab0b3c975f6caa`. Benchmark/tooling source: `a02e76bbf9314e1f69d964c93f9801c5ca1e6c1b`. Branch: `codex/chart-volume-profile-integration-20261101`.

**Offline feature acceptance passes. ARX is not declared release-green, architecture-complete, or competitive-parity proven.** This extends the existing Smart Chart, study catalogue, assistant and Truth paths; it creates no second chart or analysis engine.

## What changed

- The existing catalogue now includes Estimated Volume Profile: 8–128 configurable price rows, 1–100% value-area target, exact frozen observed-bar endpoints, POC, configurable appearance, multiple profiles, saved settings, and PNG export. Multiple profiles share a bounded right-hand strip. Panning reprojects their geometry without recalculating or moving the saved range.
- Manual controls and bounded assistant requests use the same calculator and actual renderer aggregate. Requests can show/explain, hide/remove, edit rows/value-area target and explicitly refreeze the visible closed range. Unsupported dates, assets, intervals, compound instructions and ambiguous multiple instances are refused. This remains bounded local language, not a general AI strategy authoring system.
- Quantities require the existing source-qualified Common Stock trade-unit authority, same original series identity, closed-bar evidence and original UTC. A missing selected quantity, source replacement, clock withdrawal or interior unclosed bar holds the whole profile. A saved range never silently shrinks. Explicit recapture may omit one documented forming tail, with disclosure.
- Allocation is uniform across each original OHLC high–low range. These are **estimated price-bin quantities**, not observed executions at price, bid/ask depth, aggressor flow or proven consolidated shares. Time gaps are not filled, and loaded observations are not called a complete session.
- Exact saved-anchor UTC labels now agree in settings, the active-study strip, data window, assistant and PNG header. Labels require the anchor's exact current original bar and source identity; they cannot borrow a newer listing's clock proof. Parent/child effect-order regressions protect unselected comparison panes. PNG labels freeze with the captured image.
- Exact original total trade-unit counts stay exact in the data window, including hidden profiles. Per-bin estimates retain their distinct wording. Volume authority still does not grant missing historical execution-price evidence or trading permission.

## Evidence on the exact application source

All 16 bounded commands passed on `f6e64fbea949e3ce21a99696dfab0b3c975f6caa`: 3,296 frontend tests, 11 skips, zero failures; 513 targeted backend tests; all four typecheck units; both builds; 87 guards and 7 binding assertions. This is not a full live-server or broker acceptance run.

Frozen actual Scanner build `861459da19da2027`: final core journey **278/278**, phone profile **37/37**, existing compact-mobile journey **29/29**, clock/research journey **46/46**: **390 final assertions**, zero page exceptions. An earlier successful 278-assertion journey is retained separately. The final wait matches the comparison's exact AAPL/M15 `limit=300` request, completed fixture response and adapter revision.

The original synthetic AAPL provider response was normalized through backend source `084a036957cc59f28bb3f364c7b2cc4fd24cd68a`; original fixture SHA-256 `47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df`. Original OHLC, UTC declarations, provider quantities and session-gap flags were preserved. Declared normalized-response mutations separately test quantity, clock, finality and identity withdrawal. No real provider, model or broker call occurred.

Browser checks compare every profile bin, total, POC and value area with independent O(bars × rows) arithmetic from original provider values, plus actual native primitive widths and original-price coordinates. All seven styles, four scale modes, inversion, pan/refreeze, manual endpoint selection, hidden parameter edits, duplicates, source replacement, reload, exact VWAP labels and real PNG export are exercised. Root visually inspected the desktop profile, phone chart with assistant, and exported PNG. Phone checks are emulated, not physical-device acceptance.

The later QA-only commit changes only the isolated benchmark and probe. `artifacts` and `lib` tree hashes equal the tested application source; the earlier application's tests are not relabelled as a new all-repository run.

## Repeatable timing evidence

Frozen isolated-adapter build `c01c894faa46a268`, source `a02e76bbf9314e1f69d964c93f9801c5ca1e6c1b`. Two identical runs, each eight workloads: 200/1,000/5,000 loaded bars, 32/128 rows, normal/4× CPU, with SMA, EMA, RSI and MACD retained. Each operation has five retained warmups and 30 measured samples. Show/hide, feature-off/on pan, quantity correction and row edits use actual adapter methods. Every pan must move; every ready aggregate must include all configured bars. Existing indicator identities must survive profile edits.

| Run | CPU | Worst operation p95 synchronous work | Worst operation p95 completion proxy | Largest retained single proxy sample |
|---|---|---:|---:|---:|
| 1 | 1× | 7.3 ms | 35.8 ms | 36.2 ms |
| 1 | 4× | 31.4 ms | 55.7 ms | 72.8 ms |
| 2 | 1× | 7.2 ms | 35.3 ms | 36.3 ms |
| 2 | 4× | 30.9 ms | 55.6 ms | 57.0 ms |

Both runs meet the local 100 ms p95 proxy target. The proxy waits for a second animation frame; it is **not physical paint, actual Scanner click/navigation latency, or a competitor comparison**. Fit history caps the 5,000-bar price viewport around 2,000 visible bars; pan uses a 0.9 zoom and records actual visible counts. The aggregate still includes all 5,000 original test bars. Row-edit samples explicitly record the destination row count. Constructed benchmark evidence is not provider qualification. All warmups, outliers and failed experiments are retained.

## Failures retained and corrected

1. Source defect: exact aggregate totals rounded to eight significant digits. Two regressions failed before correction, then all15 formatter tests passed.
2. Source defect found by actual Scanner acceptance: `STALE_FROM_PREV_TF` was treated as corruption. The producer emits it for any >2-interval gap, including session closures. Original flags were not removed from the fixture. A failing regression now passes; only that advisory was removed from the corruption gate. Strict context, UTC, finality, quantity and true-corruption checks remain.
3. Harness endpoint selection omitted the real focus refresh after pan; corrected through the existing focus interaction.
4. Harness source-change waits could match the separate `limit=200` query. The retained failed run showed the actual `limit=300` request arriving5.36s later. Final waits bind the exact request and actual installed revision. No event-loop-starvation or product-source failure is inferred from that attempt.
5. The first benchmark correctly failed when small fully fitted views could not pan. It also exposed an overbroad full-history label for the 5,000-bar case. Both workload and scope were corrected; first-run timings remain excluded from accepted performance, not deleted.

## Competitive gaps and source research

TradingView documents lower-timeframe inputs and richer fixed/session-range behavior. ARX currently estimates from loaded chart-timeframe OHLC; it has no attested lower-timeframe profile loader, exchange tick-size binning, complete-session profile, footprint, TPO or aggressor delta. POC ties choose the lower-price row as an explicit ARX convention. Value-area expansion starts at POC, chooses the larger adjacent row and stops before exceeding the remaining target; target and achieved percentages are distinct. [TradingView methodology](https://www.tradingview.com/support/solutions/43000502040-volume-profile-indicators-basic-concepts/), [fixed-range controls](https://www.tradingview.com/support/solutions/43000480324-fixed-range-volume-profile-indicator/).

MT5 distinguishes Forex tick counts from actual stock traded volume; its documented volume-indicator catalogue does not establish a universal built-in Volume Profile algorithm. ARX does not substitute tick counts for traded size. [MT5 volume indicators](https://www.metatrader5.com/en/terminal/help/indicators/volume_indicators).

First-click Scanner load, full application interaction tails, broader AI language, other automatic drawing families, deeper research strategies/capital/benchmarks and competitive parity remain open. Existing large-history frame-time gaps are not superseded by the scoped timing proxy above. Technical source captions and real-device polish also remain review items.

## Reproduction and development status

Local raw scripts, exact logs, snapshots, images, independent review and failure archives: `/Users/areyouok/arx-tier1-release/chart-volume-profile-20261101/`. `final-receipt.json` indexes results. `checks.py`, `run-volume-profile.py`, `run-mobile-profile.py`, `run-mobile-layout.py`, `run-clock-research.py`, and `run-profile-performance.py` reproduce this local session. The checked-in `scripts/chart-qa/volume-profile-benchmark.mjs` exports the Playwright page workload; `scripts/scanner-qa/shared-chart-fixture/build.mjs --volume-profile` creates its immutable fixture, served with `--serve=<build-id>` on loopback4209. Actual Scanner browser journey scripts remain in the local evidence package; portable packaging is still a follow-up.

Replit's previous import completed at application `1b352c2e24d8282cc910cf8705326fc6cc220b33`, checkpoint `fb307edb33aedcb35b8ed1dd97ab750116251f12`, with partial browser acceptance. Its source differs from this new application; prior results are not transferred. Current source sync is tracked separately in the durable checkpoint. Existing API/runtime artifacts and published application were preserved. No main merge, deployment, existing database change, worker/trading enablement or live/demo broker test occurred.
