---
name: Instrument Passport (D3b)
description: The canonical per-market instrument registry with provenance-tagged unit facts, the exact unit-conversion closure, which modules are now views, and the USOIL/UKOIL ruling.
---

# Instrument Passport (D3b, build/instrument-passport)

`lib/domain/src/market/instrumentPassport.ts` (exported via
`@workspace/domain/market`) is the ONE canonical record per approved ARX Focus
market: asset class, venues + venue symbols, base/quote currency, pip size,
point size, contract size, min/step lot, session calendar ref
(`sessionCalendarRef` = Focus `sessionProfile`), settlement behaviour
(`CONTINUOUS_24_7` / `WEEKEND_GAP` / `CASH_SESSION_GAP`). Derived 1:1 from
`ARX_FOCUS_MARKETS`, so a market cannot exist without a passport.

**Provenance model.** Every fact is a `PassportField` tagged `DECLARED`
(market convention / symbol-stated truth) or `BROKER_REPORTED` (must come from
`arx_symbol_specs` at runtime; statically `null` + reason
`AWAITS_BROKER_SPEC`). Only strict fiat pairs get declared pip
(0.0001/0.01-JPY) and contract (100,000). Metals/crypto get declared
base/quote from the symbol text; synthetics/indices get nothing invented.

**Unit closure.** All conversions (points→pips→quote P&L→minor units) live in
this module ONCE, over exact bigint decimals (`ExactDec`): a conversion either
round-trips exactly or returns a typed refusal (`NOT_EXACT`,
`NOT_REPRESENTABLE_AT_QUOTE_SCALE`, …) — never rounds, never guesses.
`completeUnitChain` merges broker truth with per-field authority mirroring the
certified resolvers: pip = convention-first (decidePipSize), contract =
broker-first fail-closed (decideContractSize), quote = broker profitCurrency
first. Currency scale comes from the CALLER (`quoteScaleFor:
scaleForCurrency` from `@workspace/money`) so the ISO scale table stays single
(domain deliberately has NO dependency on @workspace/money).
`test:instrument-passport` (scripts) proves the exact round trip for all 43
passports × a broker-spec fixture grid (~8.8k round trips) + the 100,000× lock
(no chain for non-FX without broker spec). Mutations verified red:
FX-lot-leak-to-metals → 26 fails; inline pip in instrumentSpec → 17 fails.

**Views (read-through, APIs unchanged), locked by
`test:instrument-passport-drift`:**
- `api-server/src/lib/mt5/forexPair.ts` → pure re-export of
  FIAT_CODES/splitForexPair/FX_STANDARD_LOT_UNITS from the passport module
  (contractSize.ts re-exports forexPair, so the whole chain is one source).
- `api-server/src/lib/marketModel/instrumentSpec.ts` → decidePipSize reads
  `fxConventionPipSizeNumber` from the passport.
- `api-server/src/brain/symbols/symbolRegistry.ts` → built through
  `alignWithPassport` (brokerSymbol/base/quote overridden from the passport
  for approved symbols; advisory metadata still authored there).
- `api-server/src/lib/data/providers/derivProvider.ts` →
  `DERIV_SYNTHETIC_SYMBOLS` approved entries built `fromPassport(...)` (throws
  at load on a missing passport); V25/V10_1S/V100_1S/STEP stay literal —
  venue-only, outside the approved universe, deliberately not passported.
The drift test also pins sources (regex on file text) so re-inlining a
convention fails even if values coincide. It must stay import-pure: NEVER
import contractSize.ts there (`@workspace/db` throws without DATABASE_URL at
module load).

**USOIL/UKOIL ruling (investigated, deliberate).** The two
symbolRegistry.suggest tests expecting "oil" → USOIL/UKOIL were written for
Task #423 against the Top-250 universe. The Focus lock's Phase-1 owner
command (attached_assets/replit-command-arx-focus-market-lock-phase1_….md)
enumerates ALL 36 approved markets — no oil; Task #570 added only 7
synthetics (→43); `git log -S "USOIL"` on arxFocusMarkets.ts shows oil was
NEVER in the Focus registry. Exclusion is deliberate ⇒ tests updated to the
ruling ("oil" suggests [], with an `oil-exclusion` tripwire that fails if oil
is ever re-admitted, telling the editor to restore the old expectations).
Lane: `test:symbol-suggest` (trading-dashboard), now wired into ci.

**Gotchas hit here:** this sandbox blocks the tsx CLI's IPC pipe — run scripts
tests as `node --import tsx src/<test>.ts` from `scripts/`; several offline
suites (deriv feed status, ci:guards) need a dummy `DATABASE_URL` set locally;
`git checkout <file>` on an UNCOMMITTED-but-tracked file silently wipes your
edits (and does nothing for untracked ones) — revert mutations by re-editing.
