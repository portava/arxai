---
name: Perf — polling defaults & mutation invalidation rules
description: Global React Query defaults for the trading dashboard, plus the invalidation contract that prevents staleness regressions when polling intervals are loosened.
---

## Rule 1 — Global QueryClient defaults (trading-dashboard)

App.tsx sets these defaults for every `useQuery` unless overridden:
- `refetchIntervalInBackground: false` — ALL polling pauses when `document.hidden`
- `staleTime: 30_000`
- `gcTime: 5 * 60_000`
- `retry: 1`
- `refetchOnWindowFocus: false`
- `refetchOnReconnect: "always"`

**Why:** Dashboard had ~30 components each setting their own `refetchInterval` (3-30s) with no defaults. Hidden-tab polling alone was wasting most background CPU/network. The `refetchIntervalInBackground:false` flag is the single biggest perf win — keep it.

**How to apply:** When a new query needs to override, set explicit `staleTime` / `refetchInterval` on that one query — don't broaden the global default.

## Rule 2 — Manual `setInterval` must check `document.hidden`

React Query's `refetchIntervalInBackground:false` only gates React Query polling. Pages with their own `setInterval(load, …)` are NOT gated unless you add `if (!document.hidden) void load();` inside the callback.

**Why:** Pages like `alerts.tsx` and `live-trading-control.tsx` are commonly left open in background tabs. Without the gate they keep firing parallel fetches.

**How to apply:** Any new manual `setInterval` on a page should follow the same pattern. Long-term, prefer migrating to React Query so the global default applies.

## Rule 3 — `useTradingMode` poll is 60s; mutations MUST invalidate `['me','account-mode']`

`useTradingMode` polls `/api/me/account-mode` at 60s with `staleTime:30s`. It also installs a `visibilitychange` listener that invalidates the key when the tab becomes visible.

**Why:** Account-mode rarely changes mid-session, so a 60s poll cuts traffic 4x vs the old 15s — BUT any write that flips the unified mode envelope (`currentAccountMode`, `userCanManualTrade`, `liveExecutionArmed`, `cleanBlockedReason`, routing override) would otherwise lag the UI up to 60s.

**How to apply:** Every mutation that can change mode/arming/permissions/routing MUST call `qc.invalidateQueries({ queryKey: ["me", "account-mode"] })` in `onSuccess`. Current invalidation sites:
- `LiveTradingUnlockCard` — arm + disarm
- `LiveKillSwitchButton` — engage + release
- `my-account.tsx` `BridgePreferenceCard` — bridge preference PUT (also invalidates `['me','account-shell']`)

When adding a new mode-affecting endpoint (e.g., admin master-live approve, freeze flips, kill-switch admin, shell switch), wire the same invalidation. Bridge-related writes also need `['me','account-shell']`.

## Rule 4 — Alert badge has TWO unread-count keys

The active topbar `NotificationBell` uses Orval key `getGetAlertUnreadCountQueryKey()` = `['/api/alerts/unread-count']`. The legacy `AlertBell` uses `['me','alerts','unread-count']`.

**Why:** Two bell components coexist (Orval-generated + legacy hand-rolled) and they hit different endpoints with different keys. Invalidating only one leaves the other stale.

**How to apply:** Any alert mutation (mark-read, dismiss, mark-all-read, server-pushed alert resolution) MUST invalidate BOTH keys, or the badge lags up to its poll interval (20s). See `alerts.tsx::invalidateBadge` for the canonical pattern; `CriticalAlertBanner` and `AlertsDrawer` already invalidate the Orval key.
