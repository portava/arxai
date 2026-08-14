---
name: Chart reach-start handler closure staleness
description: Why a once-bound lightweight-charts timeScale subscription must call the deep-history loadOlder through a ref, not a captured closure.
---

A chart's `subscribeVisibleLogicalRangeChange` handler is typically bound ONCE
per chart rebuild (an effect keyed on `[symbol, timeframe, hasCandles]`, with
exhaustive-deps suppressed so a routine poll never rebuilds the chart). If that
handler closes directly over `deepHistory.loadOlder`, it captures a stale
closure.

**Why:** `useChartDeepHistory.loadOlder` is a `useCallback` whose deps include
`hasMore`. When the backend reports history is exhausted (`hasMoreHistory=false`
/ `nextBefore=null`), `hasMore` flips false and `loadOlder` is recreated — but
the subscription still holds the OLD closure that thinks `hasMore===true`. Panning
near the start then keeps firing back-page fetches forever (request loop / setData
churn / flicker).

**How to apply:** keep a `loadOlderRef = useRef(deepHistory.loadOlder)` updated
by its own `useEffect([deepHistory.loadOlder])`, and have the once-bound handler
call `loadOlderRef.current(...)`. The latest closure (which no-ops once exhausted
and is guarded by an `inFlightRef`) always runs. ARXNativeChart avoids the trap a
different way — it re-registers its reach-start handler via a separate effect that
DOES list `loadOlder` in deps. Either pattern is fine; the bug is only when a
once-bound subscription captures the closure directly. Lock it with a hook-level
guard test (mock `fetchChartHistory`, assert no second fetch after exhaustion).
