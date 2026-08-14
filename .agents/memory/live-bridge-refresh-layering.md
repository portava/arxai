---
name: Live bridge auto-refresh hook layering
description: How the auto-refresh UX layer wraps the shared live snapshot without opening a second SSE, and the bridge-state mapping honesty rule.
---

# Live bridge auto-refresh hook layering

`useLiveBridgeRefresh` is split into two exports on purpose:

- `useLiveBridgeRefreshState(base)` — a **pure** layer over an
  already-obtained `UseLiveAccountSnapshotResult`. It adds the auto-refresh
  toggle (localStorage `arx_autoRefresh_enabled`, default on), `refreshNow`,
  `isRefreshing`, `lastRefreshAt`, `nextRefreshInMs`, and `bridgeState`. It
  opens **no transport of its own**.
- `useLiveBridgeRefresh()` — the standalone convenience = `state(useLiveAccountSnapshot())`.

**Rule:** pages already wrapped in `<LiveAccountSnapshotProvider>` (e.g. the
dashboard) must feed the layer from the context via
`useLiveBridgeRefreshState(useLiveAccountSnapshotCtx())`. Calling the standalone
`useLiveBridgeRefresh()` there opens a **second** SSE stream.
**Why:** the shared provider exists specifically so all live cards share one
stream and show identical numbers; a second stream double-connects and can show
divergent state.

**bridgeState honesty:** `deriveBridgeState(connectionStatus, freshness)` must
map **every** `Freshness` member. `Freshness` includes `"delayed"`; the original
mapping only handled `"fresh"` and let `"delayed"` fall through to `"offline"`,
which mislabels a merely-delayed bridge as offline. Map both `"fresh"` and
`"delayed"` into the `delayed` bucket. A disconnected/unavailable connection
always wins → `offline`, even if the (stale) payload still says `freshness:"live"`.

**Honesty inherited from the base hook:** never relabel stale/offline as live;
`isRefreshing` is true only during an in-flight reload and clears only when a
genuinely newer `lastUpdatedMs` arrives (no optimistic clear); `nextRefreshInMs`
is null while the SSE connection is `live` (the stream already pushes updates).

**Test approach:** the layer takes `base` as a plain argument, so the
deterministic test (`useLiveBridgeRefresh.test.ts`) passes a synthetic base
object — no EventSource/network needed. This is what surfaced the `"delayed"`
mapping gap.
