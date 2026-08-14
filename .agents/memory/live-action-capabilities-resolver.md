---
name: Frontend live-action capability resolver
description: The one place the dashboard decides open/modify/close live-risk affordances, and which surfaces must (not) route through it.
---

# resolveLiveActionCapabilities (trading-dashboard)

`src/lib/liveActionCapabilities.ts` is the single frontend source of the
open-vs-close live-risk rule, derived purely from the `useTradingMode` envelope:

- `canOpen = canManualTrade && !isFrozen && !bridgeBlocked`
- `canModify` ALWAYS mirrors `canOpen` (modify can increase risk → same gate)
- `canClose` is ALWAYS `true` — a revoked or kill-switch-frozen trader must keep
  the ability to reduce risk. Row-level close still needs a real broker ticket.
- `blockedReason`/`blockedLabel` precedence: `BRIDGE_DISCONNECTED > FROZEN > NOT_APPROVED`.

**Why:** the role/permission audit left these as Class-5 frontend surfaces. The
open-gate (`canManualTrade && !isFrozen` [+ `!blocked`]) was re-derived inline on
every trade surface with subtly different formulas; close was (correctly) gated
only on broker-ticket presence.

**How to apply:**
- Open/modify gates route through the resolver: `trade-command-room.tsx`,
  `useLivePositionOverlays.ts`, `ScannerChartPanel.tsx`.
- `OpenLivePositions.tsx` deliberately imports NO trading-mode hook — close is
  ticket-based so revocation/freeze can never hide the exit. Keep it that way.
- Do NOT wire `scannerTruth.ts` (demo/live split + large contract suite) or
  `CockpitCards.tsx` (`waitingApproval`, a different concept) into the resolver.
- It is display-only: never add a field that *grants* execution; the backend
  18-gate pipeline stays authoritative. Investor/admin nav containment lives in
  `routeAccess.ts` + the nav surfaces, not here.
