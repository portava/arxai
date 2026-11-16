---
name: Shared-bridge symbol-directory fallback
description: Why /api/me/mt5/symbols falls back to the master account's directory for shared-bridge users, and why that is not a per-user isolation leak.
---

Shared-bridge users run NO own MT5 EA, so they have zero rows in `arx_symbol_specs`.
`listSymbolsForUser(userId)` filters `WHERE userId=<user>` → empty → "symbols not
displayed" in the SymbolPicker. Fix: `resolveEffectiveSymbolOwnerId(userId)` resolves
the effective DISPLAY/RESOLVE owner — the user themselves if they have own specs,
otherwise (only for APPROVED shared-bridge users) the active master connection's owner
(`arx_master_account_config.is_active` → `mt5_connection.user_id`). Wired into the three
`meMt5Symbols.ts` routes only.

**Why it is not a leak:** `arx_symbol_specs` hold instrument metadata only (digits, lot
steps, tick size, tradability) — never positions, balances, account numbers, or tokens.
An approved shared-bridge tenant's tradable universe IS the master account's directory
because their orders execute on that master account. Bounded, honest exception to strict
per-user row ownership.

**Why execution is unaffected:** the live pipeline resolves broker symbols via
`resolveBrokerSymbolName` (reads `symbolsTable`), NOT `resolveBrokerSymbol` /
`listSymbolsForUser` (`arx_symbol_specs`). The fix is display/resolve-layer only; no gate
is touched.

**How to apply:** keep the fallback fail-closed and route-scoped. Fallback fires ONLY when
all hold: no own specs AND `approvedForMasterLive` AND `masterLiveStatus='APPROVED'` AND an
active master-config row resolves to a different owner. Non-approved users get honest empty
(verified live: approved → 600 symbols; non-approved → count:0). SymbolPicker calls
`useMt5Symbols({ includeStale:true })`, so STALE/MISSING-fresh master specs still display.
