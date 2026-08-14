---
name: Symbol directory resolver — canonicalize, never hard-block
description: Why server-side broker-symbol re-resolution must fall back (not reject) when the user's enumerated directory can't resolve.
---

`resolveBrokerSymbol(userId, requested)` reads ONLY the user's *enumerated*
symbol directory (`arx_symbol_specs`, populated by the EA's ENUMERATE_SYMBOLS).
If the user has never enumerated (empty directory) it returns
`SYMBOL_NOT_FOUND` for *everything* — including EURUSD, the proven live path.

**Rule:** when hardening a live path with server-side symbol re-resolution
(e.g. `/trades/live-shared/validate` + `/execute` re-checking a client-supplied
`brokerSymbol`), **canonicalize on an exact resolve, fall back to the provided
value on miss — never hard-reject on not-found/ambiguous.**

**Why:** a hard-reject on resolver miss regresses the working path for any
account with an empty/stale directory and the forex passthrough case. A code
review may flag "accept brokerSymbol verbatim" as a blocking spoof hole and
recommend a strict reject — but the 16-gate symbol allowlist (gate #13) plus the
live-poll boundary casing resolver are already the authoritative rejects at
dispatch. Server-side canonicalization is defense-in-depth (fixes case/spacing,
defeats a spoofed label when the directory CAN resolve it), not the safety net.

**How to apply:** `provided ? (resolve → ok ? canonical : provided) : fallback`,
wrapped in try/catch that falls back on error. Never enable execution, never
change gate semantics.
