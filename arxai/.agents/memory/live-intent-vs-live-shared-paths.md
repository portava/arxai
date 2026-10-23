---
name: Live-intent submit vs live-shared dispatch paths
description: Two different endpoints look like "submit a live trade" but only one actually trades. Wiring approve/confirm buttons to the wrong one silently makes Approve do nothing.
---

`/api/live-intent/submit` is a **tester-only audit-table writer**. It explicitly never calls `placeLiveOrderGuarded`, never inserts into `live_positions` or `mt5_commands`, hard-caps `lotSize` to 0.01, and always returns `accepted: false`. It writes a `vault_events` row + a `live_intents` row and that's it.

`/api/trades/live-shared/validate` → `/api/trades/live-shared/execute` is the **real Phase B dispatch path** through the 16-gate evaluator, with real broker fill, used by `LiveSharedTradeTicket`.

**Rule:** any UI Approve / Confirm / Submit button that the user expects to actually place a trade must branch on `useMasterLiveAccess().canTrade`:
- `canTrade === true` → open `LiveSharedTradeTicket` (real dispatch)
- otherwise → fall through to `/live-intent/submit` (tester-only)

**Why:** without the branch, LIVE_SHARED-approved users press Approve / Live Intent and see audit rows appear with `accepted=false, status=PENDING_MT5_CONNECTION` even when MT5 is connected, gates are green, and the user is fully approved — looks like a server bug, is actually the wrong endpoint.

**How to apply:** when adding any "place trade" action, grep `/api/live-intent/submit` consumers and check each one branches on `canTrade`. Current consumers: `pages/live-ai-assist.tsx` (fixed), `pages/market-scanner.tsx`, `pages/trade-command-room.tsx`, `pages/testing-control-center.tsx`, `pages/live-manual.tsx`, `pages/live-ai-auto-test.tsx`, `pages/tester-playbook.tsx`. The pattern lives in `ScannerTradeModal.tsx` and now `live-ai-assist.tsx`.
