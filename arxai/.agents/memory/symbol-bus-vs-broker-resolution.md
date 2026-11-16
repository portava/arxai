---
name: Symbol selection writes brokerSymbol; ticket owns ambiguity resolution
description: Where display→broker resolution and SYMBOL_AMBIGUOUS handling live across the symbol-selection UIs
---

**Durable rule:** any UI where the user picks a *concrete* instrument (the
top-bar `SymbolPicker`, scanner chips) must write that row's **exact
`brokerSymbol`** onto the shared chart-symbol bus. Picking a concrete row is
itself the resolution — there is no ambiguity, so no `/resolve-symbol` call
belongs there. The ONLY place display→broker resolution and `SYMBOL_AMBIGUOUS`
(typed shorthand like "V75" → multiple candidates) are handled is the trade
ticket (`LiveSharedTradeTicket`), which calls `resolveBrokerSymbol(intent.symbol)`
server-side at confirm.

**Why:** the bus is a single symbol-carrying channel read by multiple surfaces
(the candles fetch uppercases it; the ticket re-resolves it). If different pick
paths emit different identifier kinds (raw legacy string vs broker vs canonical),
downstream behavior drifts. The legacy "Recent" list stores arbitrary historical
strings — a pick path that re-emits those raw violates the exact-broker contract,
so map recents back onto the live inventory and drop any no longer enumerated.

**How to apply:** the picker's symbol set comes ONLY from the user's EA-enumerated
inventory (`useMt5Symbols` → `/api/me/mt5/symbols`); when none is enumerated the
list is honestly empty (never a static/fabricated fallback). Keep the
candidate-chooser for TYPED entry at the ticket, never at list-pick. Do the
list-source swap and the ticket's typed chooser as SEPARATE batches.

**Note on `SymbolExplorer`:** it is a *different* surface with a typed search box
running client-side `resolveSymbol` over `symbolRegistry` (a static client
registry, separate from the EA-enumerated set). Rewiring it overlaps with the
typed-entry/candidate-chooser work, not the pure picker swap.
