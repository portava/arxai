# Duplicate colour-pass experiment — 1 November 2026

Verdict: **HELD, QA ONLY.** Correctness evidence supports the tested optimization, and slowed four-view p95 improved in this comparison, but initial loading was inconsistent and worst-frame outliers remain. Do not import the transform into ARX or Replit. No launch-readiness, parity, superiority or architecture-completion claim is made.

Tested source: `ddb3bfdfa2b412415671be121f3e9a2ff6025193`, based on accepted QA source `da62c7a5595f63be526362c3327a27366da6dc68`. Unmodified production build `ced5065092d86a1e`; candidate `5ab3aed87eac840f`. Both used the same clean commit, production React and minified Vite. Dependency and bundle identities are recorded in `build-manifest.json`.

## Change

In the installed lightweight-charts 5.2.0 renderer, fresh raw items are already coloured. When data and options are both invalid, the base pane immediately maps those items again to apply colours. The QA-only `--initial-colour-pass-experiment` skips that second pass for the six built-in series after fresh raw items are prepared. Options-only changes still repaint normally. Custom series retain the original path.

The transform requires the exact production module SHA-256 `8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945`, checks its single replacement seam and records the transformed hash. Missing/duplicate transformation fails closed. All notices remain. No installed dependency, application source, lockfile or API was edited. Neither earlier held row-reuse transform is present or enabled; only neutral QA fixture/probe scaffolding was reused.

## Correctness

- Nine semantic/transform tests and the QA typecheck pass on the exact commit. The seven series tests execute the real vendor base, colour helper and raw-item builders through nine state transitions each: initialization, options-only, data-only, combined changes, grouping, grouped options, ungrouping with options, clear and repopulate. That is 63 compared states. Unrelated coordinate/render implementations are stubbed in this unit layer.
- Two mutations were caught. Restoring the duplicate pass fails six built-in behaviour assertions. Disabling the options-only path fails all seven series flows. The mutation byte-consistency assertion also fails; behaviour failures were checked separately.
- Four complete stress matrices in baseline → candidate → candidate → baseline order: 16 valid cases, 72,000 accepted final-candle revisions, 2,880 retained frame samples, full canonical/display OHLC and study checks passing, no page exceptions. The full-recompute study oracle uses the same calculator; it is not independent formula validation.
- Separate native-canvas runs, after all timing matrices: baseline and candidate each pass 576 lifecycle states. Six built-in types × four scales × default/overridden colours × grouping off/on × six phases (initial, options-only, combined data/options, historical correction, clear, repopulate).
- Every candidate canvas pixel hash matches its baseline counterpart: **zero differences in 576 comparisons**. All 1,152 states have stable hashes across another frame, visible hosts and exact series data. All nonempty states have plotted-palette pixels (minimum 21,973), so the checks no longer rely only on grid/background differences. All 48 default-colour options-only pairs visibly repaint in both versions. Empty states are explicitly allowed to have no plotted ink. No page exceptions.

This is stronger lifecycle evidence than the earlier static probe, but not full ARX seven-style/drawing/replay acceptance, physical paint, real-device/provider testing, or an independent review of a deployable dependency patch. The historical-correction case uses the fitted history; a later caching change should also deliberately zoom onto corrected bars.

## Performance

The unchanged workload keeps full history, 12 studies and 40 drawings per view, processes 180 frames with ten final-candle revisions per frame per view, and periodically pans/zooms. Four-view ranges are linked. Fresh documents and browsers are used; all samples/outliers remain. No owned build or tests overlapped the timing matrices. Semantic/type checks later overlapped part of the untimed candidate visual run; no latency claims are drawn from those visual runs. Whole-host quietness was not established.

P95 frame intervals, milliseconds:

| Case | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| 10k, one view, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 50k, one view, normal CPU | 66.7 | 66.7 | 66.7 | 66.7 |
| 5k, four views, normal CPU | 33.4 | 33.4 | 33.4 | 33.4 |
| 5k, four views, 4× CPU slowdown | 133.3 | 100.1 | 100.1 | 133.3 |

The strict 16.7 ms target remains unmet in all 16 cases. The slowed four-view improvement is observed evidence for this session, not proof that the removed pass caused all steady-state improvement. No call-count diagnostic of the timed browser loop was performed.

Setup through three animation frames, milliseconds:

| Case | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| 10k, one view | 162.9 | 164.1 | 196.7 | 164.4 |
| 50k, one view | 602.5 | 563.7 | 597.0 | 601.7 |
| 5k, four views, normal | 341.6 | 291.5 | 310.7 | 335.2 |
| 5k, four views, slowed | 1122.4 | 1255.3 | 1093.4 | 1162.4 |

The normal four-view setup improved in both candidate runs, but 10k candidate setup and slowed setup each regressed in one run. Slowed maximum frames were 199.9/133.4/200.0/266.7 ms; 50k maxima were 166.6/166.7/133.2/166.7 ms. These are retained, not filtered or described as guarantees. This setup measure is not an actual Market Scanner first click, network startup or completed physical paint.

## Next actions

Prefer an application-level investigation before adopting private dependency changes. `LightweightChartsAdapter.setFeedState` calls `applyLivePriceAffordance` when data exists; that helper unconditionally reapplies `priceLineVisible` and `lastValueVisible`, even if the values already match. Inspect actual call frequency and measure a representative feed-state workload. A supported-API equality guard could avoid unnecessary work while preserving every live → stale transition, Heikin Ashi canonical-price rule, series replacement and context reset. Do not infer a performance win from call-count reduction alone. Repeated identical last-price-line updates are another candidate, subject to the same truth checks.

The larger full-history OHLC preparation cost remains open. Any retained-item/incremental strategy must correctly handle historical edits, row insert/delete/clear, index changes, explicit colours, options, grouping, scales, inspection and replay. Reuse only this neutral QA tooling; do not install held transforms or silently shorten history.

If a dependency change is eventually justified, it needs a maintainable exact-version patch for both development and production, full app validation and independent review. [pnpm's patch workflow](https://pnpm.io/cli/patch) supports versioned patches; its [install documentation](https://pnpm.io/cli/install) describes lockfile-only updates without writing node_modules. These current docs were consulted for planning only; no package-manager operation occurred, and the locally installed pnpm version must be checked before relying on version-specific behaviour.

## Receipts and boundaries

Raw: `/Users/areyouok/arx-tier1-release/chart-initial-colour-pass-20261101`. Portable compressed receipts and original/compressed hashes: `docs/validation/chart-initial-colour-pass-20261101/manifest.json`. Builds, exact-source checks, all matrix/visual results, mutation failures, launcher and summaries are preserved. No failed measured browser attempts occurred in this experiment. No full application/backend suite was rerun because application source is unchanged; prior broad results remain tied to their own commits.

Owned browser/fixture sessions were closed. No Replit import, main merge, publication/deployment, existing database changes, API/worker activation, emails, funds movement or live/demo broker tests occurred. Last verified Replit source/checkpoint remain the earlier recorded ruler `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd` / `124f5ccc9ecca97a07f2b27a15f9a85a1df8d23e`; Replit was not re-inspected or changed this turn. API activation and the broader competitive/launch gaps stay open.
