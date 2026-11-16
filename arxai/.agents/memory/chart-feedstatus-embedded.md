---
name: ARX chart feed status is embedded in the candles response
description: Drive chart feed-confidence UI off the candles payload's feedStatus, never a second /api/chart/feed-status poll.
---

`GET /api/chart/candles` (`ChartCandlesResponse`) embeds the **full**
`feedStatus` object (`ChartFeedStatus`: source, isLive, lastTickTime,
lastCandleTime, latencyMs, missing/duplicate/outOfOrder/invalid counts, stale,
quality, warning, aiUsable, feedReadinessState, message). A standalone
`useGetChartFeedStatus` hook also exists.

**Why:** The native chart already polls candles every 8s. Adding a parallel
feed-status poll would double the request rate on a hot path for zero new data.
Keep new endpoints off the request hot path (project perf rule).

**How to apply:** Any chart feed-confidence / quality / AI-usable UI (Level 3
badge and beyond) should read `data.feedStatus` from the candles query, not call
the dedicated feed-status endpoint. The frontend verdict is centralized in
`lib/feed-confidence.ts` (`feedConfidence()` → statusLabel/severity/aiUsable/
message/suggestFallback) — never upgrade the backend's quality/aiUsable verdict;
only translate it. `aiUsable` is true ONLY when quality is `clean`, so Level 5 AI
overlays must gate on it.
