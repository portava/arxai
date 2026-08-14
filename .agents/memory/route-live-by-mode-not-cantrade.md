---
name: Route live accounts by mode, not canTrade
description: How the scanner trade modal must decide between the live ticket and the demo body without flashing the wrong surface.
---

# Route live accounts by account MODE, not by canTrade alone

In the scanner trade modal (`ScannerTradeModal.tsx`), a LIVE_SHARED account must
be routed to `LiveSharedTradeTicket` based on **account mode**
(`tradingMode.isLiveShared || liveSharedAccess.canTrade`), never on `canTrade`
alone.

**Why:** `canTrade` is derived from live master access and can flip to `false`
transiently (bridge heartbeat stale, allocation recompute, pool freshness). If
routing keyed only on `canTrade`, a genuine live account would fall through to the
DEMO order body the moment a gate momentarily failed — exactly the demo-leak the
LIVE-only path forbids. Routing by mode keeps a live user on the live ticket; the
live ticket then surfaces the specific block reason instead of dumping them into
demo.

**How to apply:**
- Read `useTradingMode()` and `useMasterLiveAccess()` *before* any conditional
  return (no hook-order hazard).
- Render a neutral loading skeleton while
  `tradingMode.isLoading || !liveSharedAccess.loaded` so nothing flashes before
  mode resolves.
- Only non-live (DEMO/PAPER) accounts may reach the demo body — that body must
  stay for genuine demo users; do NOT delete it.
- A static guard (`scripts/src/liveSurfaceDemoWordingTest.ts`,
  `test:live-surface-no-demo`) fails the build if demo/sim wording or a demo
  blocker regresses into the live surface.
