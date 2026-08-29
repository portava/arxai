---
name: Global symbol picker merged resolver
description: Why the picker reads a merged approved+enumerated resolver, and the honesty rule for its source tags.
---

The global SymbolPicker must NEVER go dark ("No enumerated symbols yet") just
because the EA-enumerated directory (`arx_symbol_specs` via `listSymbolsForUser`)
is empty. The fix is a single backend resolver `resolveSymbolsForUser(userId)`
(api-server `lib/mt5/resolveSymbolsForUser.ts`) exposed at `GET /api/me/symbols`
(per-user, requireUser), consumed by `useResolvedSymbols()` →
`components/layout/SymbolPicker.tsx`.

**Rule:** the approved universe is ALWAYS the row source — map over
`ARX_FOCUS_MARKETS` (the 36/43-market lock) and OVERLAY enumerated metadata when
present. Non-approved broker rows are dropped (lock preserved).

**Why:** enumeration is async/late; approved markets (EURUSD, V75…) have live
candles and must be viewable/scannable before the broker enumerates.

**Honesty (the trap):** `tradeable=true` ONLY when an enumerated row exists AND
is tradable AND has a brokerSymbol; everything else sets
`executionRequiresBrokerConfirmation=true`. Execution is unaffected — orders
still resolve the exact broker symbol + run the full preflight + 23-gate dispatch.
The `source` tag must be reported from REAL evidence only: enumerated /
shared_bridge / default. Do NOT infer a richer source (e.g. "active_candles")
from chart selection alone — `getCandles()` reads the SIMULATOR, so it can't be
used as a live-feed witness. An approved-but-unenumerated market is honestly
`default` (broker confirmation pending), never a fabricated "has live feed" tag.

This is display/scanner-only: it touches no execution path, gate, or per-user
isolation (everything routes through `resolveEffectiveSymbolOwnerId` +
`listSymbolsForUser`, userId-scoped).
