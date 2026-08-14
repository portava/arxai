---
name: LiveSharedTradeTicket auto-confirm when armed
description: How LiveSharedTradeTicket skips the Confirm button when oneClickArmed; placement of the auto-confirm effect and why it waits for SL.
---

## Rule
`LiveSharedTradeTicket` auto-confirms on open when `oneClickArmed` is true.

## How it works
1. Fetches `/api/me/one-click/status` on mount → `armedOneClick` state
2. Reset effect pre-fills volume from `defaultVolume` when armed
3. `autoConfirmFiredRef` prevents double-fire within one open session
4. Auto-confirm `useEffect` depends on `[open, armedOneClick, intentValid, actionsLocked, busy]` — placed AFTER `intentValid` declaration to avoid TS2448 ("used before declaration")
5. For users with `slRequired=true`, `intentValid` becomes true only after ATR suggestion prefills SL (~350ms delay) — auto-confirm naturally waits

## Why
Code review required "no confirmation interstitial when armed" across ALL Buy/Sell surfaces. LiveSharedTradeTicket was the only remaining surface with a manual Confirm step; ScannerChartPanel/OpenLivePositions already route directly via executeInstantTrade.

## Safety
Auto-confirm is UX-only. All 16 Phase B gates still run server-side via the full createLiveDraft → confirmLiveCommand → dispatchLiveCommand pipeline.

## Hooks ordering trap
The `useEffect` for auto-confirm must come AFTER all variables it references are declared (esp. `intentValid`, which is derived from IIFE below `intent` useMemo). Placing it before causes TS2448.
