---
name: TradingViewLiveChart broadcasts defaultSymbol on mount
description: Shared chart-symbol bus gets overwritten whenever TradingViewLiveChart (re)mounts; toggles must feed it the live bus symbol.
---

`TradingViewLiveChart` runs an effect on `[defaultSymbol]` that calls
`broadcastChartSymbol(defaultSymbol)` — so on **every mount/remount** it pushes
its `defaultSymbol` prop into the shared chart-symbol bus
(`use-chart-symbol.ts`), overwriting whatever the bus currently holds.

**Why:** A live-chart page toggle that conditionally renders TradingView vs a
native chart will unmount/remount TradingView each switch. If TradingView is
mounted with a hardcoded `defaultSymbol="FX:EURUSD"`, switching native→TV resets
the user's selected instrument back to EURUSD. Caught in review of the ARX Native
Chart toggle.

**How to apply:** Any page that conditionally mounts `TradingViewLiveChart`
alongside other bus-aware charts must pass the **current bus symbol** as
`defaultSymbol` (e.g. `defaultSymbol={chartSymbol || "FX:EURUSD"}` from
`useChartSymbol()`), not a constant. Prefer the page-level fix over editing the
shared component's mount effect (other embeds depend on the broadcast).
