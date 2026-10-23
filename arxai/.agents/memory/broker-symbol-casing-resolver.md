---
name: Broker symbol casing resolver
description: Why live synthetic-index dispatch failed (case-sensitive MT5 symbols) and the single-boundary resolver that fixes it
---

# Broker symbol name resolution at the live dispatch boundary

MT5 symbol lookup (SymbolSelect / OrderSend) is **case-sensitive** and uses the
broker's exact Market Watch string. ARX stores command symbols in an internal
form — uppercased display names ("VOLATILITY 75 INDEX") or short aliases
("V75") — which do NOT match the broker's "Volatility 75 Index". Dispatching the
wrong case made the EA reject synthetics with a generic broker rejection
(EA_REJECTED_NO_DETAIL) **even though all 16 server gates passed**. Forex
(EURUSD) was unaffected because its name is already the broker string.

**Rule:** translate ARX-internal symbol → exact broker symbol at exactly ONE
boundary — the EA live-command projection in the `/mt5/live-commands-poll`
handler, AFTER the gate-bearing pickup. Source of truth is the DB `symbols`
table `broker_symbol` column (NOT the brain `symbolRegistry.ts`, whose
`brokerSymbol` values like "R_75"/"1HZ75V" are Deriv-API codes, wrong for MT5
dispatch). Resolver = registry map keyed by a case/space/paren-insensitive
"compact" key, plus short-code aliases that resolve THROUGH the registry.

**Why:** name translation must never weaken a gate, never invent/guess a broker
symbol, never silently re-route to a different instrument. So: forex is a no-op,
unknown symbols pass through **verbatim** (fail honest — EA reports the real
rejection), aliases only yield a broker symbol that is actually registered, and
the stored command row is never mutated (audit/idempotency preserved).

**How to apply:** any new code path that hands a symbol to the EA for live
dispatch must route it through `resolveBrokerSymbolName`. The other EA-facing
routes only accept results/sync (no symbol projection), so the poll handler is
the correct single choke point. A compact-key collision detector logs a warning
at map-build time if two registry rows normalize to the same key — that is the
signal the compact normalization has become too lossy for the live registry.

**Owner note:** owner/admin bypasses allowlist + per-symbol lot + synthetic
floor server-side, and the settings API filters `allowedSymbols` to forex-only,
so you cannot (and need not) seed synthetics into `allowed_symbols` to live-test
them — the casing resolver is the genuine necessary fix for synthetic live
dispatch.
