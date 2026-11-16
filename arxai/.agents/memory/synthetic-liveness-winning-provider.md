---
name: Synthetic feed liveness keyed off winning provider, not assetClass
description: Why a synthetic symbol's live/aiUsable verdict must check which provider served the candles, not just assetClass==="synthetic"
---

# Synthetic feed liveness = winning provider, not asset class

**Rule:** For `assetClass === "synthetic"` symbols, only require a fresh Deriv WS
tick (`hasLiveTick` / `hasRecentDerivTickFor`) when the feed is **actually
Deriv-backed** — i.e. the *winning provider* (`result.primaryProvider` /
candle `source`) is `deriv*`. Any other provider (notably `mt5_broker`) is
judged on **candle freshness alone**. Compute
`derivBacked = synthetic && (source === "deriv" || source.startsWith("deriv"))`.

**Why:** Deriv-class synthetics (V75, BOOM1000, CRASH1000, …) can be served by
fresh MT5 **broker** candles over the bridge, which have NO Deriv WS tick.
Originally `chartDataService.ts` + `symbolFeedVerdictForSymbol.ts` demanded a
Deriv tick for *every* synthetic regardless of provider, so a genuinely fresh
broker feed was demoted to `delayed` / `aiUsable=false` ("historical only /
feed limited / analysis only"). The scanner (`marketScanner.ts`) was already
correct via `derivBacked`; the bug was the chart + verdict resolver layers only.

**How to apply:** When touching any feed-status / liveness layer, key
"awaiting tick" and `isLive` off `derivBacked`, never off `assetClass` alone.
`syntheticAwaitingTick = derivBacked && !hasLiveTick`;
`isLive` requires `(!derivBacked || hasLiveTick)`. Keep the honesty floors: a
stale broker feed still reads `stale` + entry-blocked, and a real
Deriv-awaiting synthetic still demotes to `delayed` (buildFeedStatus unchanged).
This is a *reporting-layer* fix only — no execution/18-gate involvement.

**UI consequence:** broker-served synthetics now have `lastTickTime=null` (no
separate tick stream). The chart `FeedConfidenceBadge` popover renders
"broker candles" in the Last-tick row for that case so the empty tick isn't
misread as a degraded feed.
