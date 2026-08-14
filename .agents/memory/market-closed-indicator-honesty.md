---
name: Market-closed / frozen-quote indicator honesty
description: Why the "Market closed — last quote …" chart badge must require broker-stale AND wall-fresh, not broker-stale alone.
---

# Closed market vs dead feed must be distinguished

The chart "Market closed — last quote HH:MM UTC" badge is derived from the
last tick's **broker timestamp** staleness — NOT a hardcoded weekend/holiday
calendar (so it covers holidays + arbitrary broker hours). The verdict
(`marketFrozen`) is computed server-side in `getFeedFreshness()`
(`formingBarComposer.ts`, thresholds in `data/freshness.ts`) and pushed to the
client as an SSE `feed_status` event on `/api/chart/tick-stream`.

**The rule:** `marketFrozen = true` requires BOTH
- `brokerStaleMs > MARKET_FROZEN_BROKER_STALE_MS` (broker quote frozen in the past), AND
- `wallStaleMs <= MARKET_FROZEN_WALL_FRESH_MS` (ticks are STILL arriving — wall-clock receipt is fresh).

**Why:** broker-stale alone is ambiguous. A *closed market* keeps streaming
ticks (the EA replays its last quote → broker time stale, wall time fresh). A
*dead/broken feed* stops streaming entirely (broker time stale AND wall time
stale). Gating on broker-staleness only would mislabel a dead feed as "market
closed" — a dishonest reading. The wall-fresh requirement is what makes the
badge mean "closed", and lets the normal stale/broken-feed surfaces speak for a
dead feed. (This was the architect's FAIL → fix.)

**How to apply:** any freshness/closed-market verdict derived from a provider's
own timestamps must ALSO require recent wall-clock receipt before claiming
"closed/frozen". Unknown broker time ⇒ assert nothing (never claim closed). And
reset per-stream display state (`setMarketFrozen(null)`) at the START of the SSE
effect so a prior symbol/timeframe's verdict can't linger after a stream-key
change.

**Scope:** display/telemetry ONLY. The `feed_status` payload carries just
symbol/timeframe + freshness numbers — no gate, fill, balance, broker account,
token, or execution path is touched. Deterministic coverage:
`formingBar.test.ts` section [E] (closed vs dead-feed) + the
`ARXNativeChart.tick-stream.test.tsx` closed-market badge block (display +
symbol-switch reset).
