---
name: One Truth Snapshot brain pattern
description: How the per-symbol Truth Snapshot composes resolvers, where the rules live, and the advisory write hidden inside the composed scanner resolver.
---

The per-symbol Truth Snapshot (api-server `lib/truth/symbolTruthSnapshot.ts`) COMPOSES
the five canonical resolvers (chart candles, news radar, scanner market-edge, scalp,
timing) through injectable deps — it never duplicates their logic. All
verdict/evidence/invalidation/stale-level RULES live in the pure domain composer
(`lib/domain/src/truth/composeVerdict.ts`); the brain only normalizes (data-state
quality mapping, humanize, label/source maps, a local ATR). Served by ONE endpoint
`GET /api/me/market/truth/:symbol?tf=` (per-user — must be `/me/*` for the per-user CI
isolation guard). A failed/absent SOURCE degrades to an absent component
(`present:false`), never a fabricated value, and absent components are never cited as
evidence; conflicts carry both sides.

**Why:** two surfaces on the same page must never disagree about freshness / news /
price / verdict. One composer + one endpoint is the only structural guarantee. Keeping
rules out of the brain keeps them unit-testable with injected deps (no DB/network).

**How to apply:** extend the single composer/brain — never add a parallel truth
derivation inside a surface. New components = an injectable dep + a component
descriptor; all copy goes through humanize/label maps (no raw enum tokens reach UI).
Frontend `useSymbolTruth` layers additively over `useScannerTruth` (which stays the
freshness/price/permission authority) and only ever applies a one-way conservative cap
(BUY/SELL → WATCH_ONLY), never an upgrade.

**Gotcha — "read-side" is not write-free:** the composed scanner resolver
`buildRubyMarketEdgeForUser` performs a best-effort per-user UPSERT into
`signalMemoryTable` on every call (advisory "what changed since last look"
continuity). It is NOT an execution/gate/permission write, but the brain's "writes
nothing" claim is overstated, and snapshot polling now drives that upsert more often.
The timing dep is therefore called explicitly with `persistSnapshot:false`
(`computeTimingRead` defaults persist to TRUE) to avoid heat-snapshot writes — mirror
that discipline for any future persisting dep, and prefer threading a skip-persist flag
through composed resolvers rather than assuming a GET is side-effect-free.
