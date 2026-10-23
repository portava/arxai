---
name: Unified account-mode resolver shape
description: How `/api/me/account-mode` resolves currentAccountMode and why an armed user never silently demotes.
---

The resolver at `artifacts/api-server/src/routes/meUnifiedMode.ts` exposes one mode envelope every page consumes via `useTradingMode()`. The precedence rule that is non-obvious from the code alone:

> An armed user is ALWAYS `currentAccountMode = "LIVE_SHARED"`, even when something is wrong. We never silently demote them to DEMO or PAPER. Instead, every incomplete state attaches a `cleanBlockedReason` and forces `canManualTrade=false` + `canAutoTrade=false`.

**Why:** the silent-demote bug was real before this resolver. An armed user whose operator yanked `tradingMode` to DISABLED would show "Demo mode" in the banner while still attempting to dispatch live commands elsewhere — the worst possible disagreement. Keeping mode pinned to LIVE_SHARED + surfacing the blocking reason means the human sees "you are armed but X is blocking you" instead of two contradictory banners.

**How to apply:**
- Any new incomplete state for an armed user → add a branch to the `if (liveExecutionArmed)` block that sets `cleanBlockedReason` (admin gets technical detail, user gets generic). Do NOT branch on `liveExecutionArmed` outside this block and override `currentAccountMode`.
- The admin-only branch is the only place `getEnvelope()` and `detectCurrentConnectedBridge()` run. `getEnvelope()` seeds `global_trading_settings` on first read; calling it in the user path breaks the read-only contract.
- `brokerExecutionStatus {server, operator, effective}` is admin-only — must stay inside `adminDiagnostics`, never at the top of the response. Normal users only learn whether they're armed and what's blocking them in clean human language.
- Admin previewing as user (effective role downgraded by `applyEffectiveViewMode`) gets NO admin diagnostics — only the `isAdminPreviewingUserMode` badge flag.
