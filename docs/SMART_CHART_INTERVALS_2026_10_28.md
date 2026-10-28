# Smart Chart intervals — 28 October 2026

This slice starts at `21ecb1376a5da7dcbc63f84517d19dae9bb8d45e`. It expands the native chart from seven selectable intervals to 19: M1, M2, M3, M4, M5, M6, M10, M12, M15, M20, M30, H1, H2, H3, H4, H6, H8, H12, D1. The existing seven quick buttons remain; the other 12 are in a compact More intervals control. Each chart keeps its own interval, and restored primary/native/comparison workspaces retain it.

The interval contract is shared by replay, chart reading, linked crosshair/range containment, and offline fixtures. It does not resample missing provider data, fill gaps, or turn offering an interval into a feed-availability claim. Replay still requires source identity, exact observed closes, finality and the correct observation cutoff. A selected interval change retains the chart engine and canvas.

## Two known unsupported intervals remain open

MetaTrader 5 documents 21 standard intervals, including W1 and MN1. This change does not claim 21-interval support or TradingView/MT5 parity. Both unavailable codes are visible but disabled in the picker. Recognized saved W1/MN1 values remain visible with the specific limitation, instead of silently changing to M15 or a comparison default. Native candle/intelligence requests and the badge's market Truth requests are disabled for either; cached bars/intelligence are withheld.

- **W1:** `formingBarComposer.ts` floors epoch milliseconds by 604800000, which anchors weeks to Thursday. `chartDataService.ts` previously allowed any newer forming open to append. For a Monday 19 October 2026 provider bar, a Thursday 22 October tick can create a second bar inside the same week. The SSE path uses the same unsafe bucket. A fixture using that floor cannot prove correct source alignment. The composer only knows provider + symbol, while historical source identities also bind bridge connection, owner, environment, broker symbol and sub-provider. It also receives MT5's broker clock directly. No safe source-matched weekly origin can be inferred from this contract. A future repair must propagate matching provenance and verified timestamp semantics, anchor to actual provider boundaries, reject absent/contradictory/cross-source evidence, and never relabel OHLC already folded into another bucket. A provider-history-only weekly view may be qualified separately using offline evidence; broker testing is not inherently required for that code path.
- **MN1:** the chart normalizer derives closes from the shared 31-day upper-bound interval, while the previous chart reader used 30 days. Neither proves actual calendar-month close boundaries. Missing months, leap February, month lengths and provider timezone/session semantics must be tested with original source boundaries. The new reader/replay do not guess either duration.

The backend weaknesses above are recorded, not fixed by this frontend slice. A separate safety repair will withhold unsupported synthetic tips and overlapping insertions; that repair alone will not complete W1/MN1.

## Validation

Focused checks cover every supported duration and saved comparison context; actual adapter crosshair/range behavior at exact closes and real gaps; native picker selection without remount; native and comparison restoration of unavailable W1/MN1; unsupported query/cached-data/stream refusal; and replay source/finality/close-boundary guards. The shared primary restore helper is tested directly. Type checking includes the dashboard; workspace library declarations were also built successfully before the focused checks.

Local receipts are under `/Users/areyouok/arx-tier1-release/chart-intervals-20261028/`. Exact final commit, pass/fail counts and receipt filenames are reported with the handoff. Earlier 20-interval test receipts are superseded: they did not detect the weekly source-boundary bug found by independent review. No browser acceptance, full combined CI, broker test, deployment, existing-database operation or performance parity claim is part of this slice.

## Primary references checked 28 October 2026

- [MQL5 chart periods](https://www.mql5.com/en/docs/constants/chartconstants/enum_timeframes): the 21 named intervals.
- [MetaTrader 5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage): chart interval controls.
