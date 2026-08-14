# TradingView Advanced Charts — licensing & availability verdict

**Status:** NOT licensed / NOT bundled in ARX AI.
**Decision:** Keep **lightweight-charts v5** as the labeled, real rendering engine
behind the ARX chart-engine adapter. The TradingView Advanced Charts engine is
registered as a descriptor only, marked `available: false`, and the factory
refuses to instantiate it.

This report exists so a future maintainer does not waste time assuming the
"TradingView" we already embed is the same thing as the licensable charting
library — it is not.

---

## 1. The two different "TradingView" products

ARX AI currently uses TradingView in exactly one form, and it is the FREE one.

| Product | What it is | License | In ARX today |
| --- | --- | --- | --- |
| **TradingView Widgets** (Advanced Real-Time Chart widget) | A free, hosted `<iframe>`/embed script (`s3.tradingview.com/tv.js` / embed widgets). Data + rendering are served by TradingView. | Free, attribution-bound, **no source access**. Cannot be self-hosted, themed beyond widget options, or fed your own data. | ✅ Yes — `TradingViewLiveChart.tsx` (reference/fallback). |
| **TradingView Advanced Charts** (formerly "Charting Library") + **Trading Platform** | A private, downloadable JS library you self-host and feed via a **Datafeed API**. Full drawing tools, custom studies, saved layouts, broker/trading integration. | **Proprietary, application-gated.** Free of charge for many use cases BUT requires signing TradingView's license agreement and being granted private repo access. **Not on npm.** | ❌ No. |

The licensable engine the task asks about is the **second** row — *Advanced
Charts*. We hold no grant for it and it is not present in the repo or lockfile.

## 2. Availability evidence (this build)

- **Not in dependencies.** No `tradingview` / `charting_library` /
  `advanced-charts` package in `package.json` or `pnpm-lock.yaml`. It is
  distributed via a private TradingView GitHub repo after license approval, never
  via the public npm registry, so it cannot appear here without a manual,
  license-gated vendor step that has not happened.
- **No license artifact.** No signed TradingView Advanced Charts agreement, no
  vendored `charting_library/` bundle, no Datafeed adapter.
- **What we embed instead is the free widget**, which is a hosted iframe and
  explicitly **does not** grant access to the Advanced Charts source, custom data
  feeds, or drawing-tool APIs.

**Conclusion:** ARX AI is almost certainly NOT licensed for TradingView Advanced
Charts, and nothing in this build can render through it.

## 3. Why this matters for the Smart Chart Shell

The whole point of the Task #373 chart-engine adapter is that the **Shell** owns
all state and the **engine is swappable**. If/when a TradingView Advanced Charts
license is obtained, a new adapter implementing the same `ChartEngineAdapter`
contract can be dropped in without touching the Shell. Until then:

- `CHART_ENGINE_DESCRIPTORS["tradingview-advanced"]` is present but
  `available: false` and labeled **"TradingView Advanced Charts (not licensed)"**.
- `createChartEngineAdapter("tradingview-advanced")` **throws** rather than
  silently degrading — a mis-wire is loud, never a fake chart.
- `DEFAULT_CHART_ENGINE_ID` stays `"lightweight-charts"`.

## 4. What it would take to enable it later (NOT in scope)

1. Apply at tradingview.com → Advanced Charts, sign the license agreement, and be
   granted access to the private distribution repo.
2. Vendor the approved `charting_library/` bundle (self-hosted; it is not an npm
   install) and record the license terms.
3. Implement a **Datafeed API** adapter that sources candles from the EXISTING
   honest ARX market-data contract (`/api/chart/candles` /
   `marketDataRouter.ts`) — never TradingView's own data for execution-adjacent
   surfaces, and never fabricated/simulator candles.
4. Implement `TradingViewAdvancedChartsAdapter implements ChartEngineAdapter`
   and flip its descriptor to `available: true`.
5. Keep every safety invariant: the chart stays a renderer; trades still route
   only through `executeInstantTrade` → live command pipeline → 16-gate.

## 5. Recommendation

**Keep lightweight-charts v5 (MIT, on npm, already integrated) as the production
engine.** It satisfies every current need (candles, price-line overlays, zones,
markers, price↔coordinate for DOM bubbles) and is the labeled real fallback. Do
not attempt to use the free TradingView widget as if it were Advanced Charts —
the widget cannot host ARX overlays, our own datafeed, or drawing tools.

> Drawing tools and draggable orders (advertised as `false` in the
> lightweight-charts capability descriptor) are future work (Task #374 and
> beyond) and are independent of the TradingView licensing question.
