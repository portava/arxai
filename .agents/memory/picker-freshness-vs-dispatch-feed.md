---
name: Picker freshness cache is non-authoritative for trades
description: The /api/me/symbols per-symbol freshness ("MISSING") and the live-dispatch feed gate are two independent sources; keep them decoupled.
---

The symbol picker's per-symbol `freshness` (`FRESH|STALE|MISSING`) and the live-trade
dispatch feed gate resolve freshness from **different sources**. They must stay decoupled.

- **Picker `freshness`** = `resolveSymbolsForUser.ts` `en?.freshness ?? "MISSING"`, where `en`
  is the *enumerated broker directory* overlay (`listSymbolsForUser`). `MISSING` = no enumerated
  broker row yet (cold overlay), NOT "no live feed". Display-only.
- **Dispatch live-feed gate** = `liveCommandPipeline` calls `resolveSymbolFeedVerdictForSymbol`
  (`symbolFeedVerdictForSymbol.ts`), which reads the REAL provider feed via `routeCandles` +
  Deriv-tick + trailing-interval staleness → `resolveSymbolFeedVerdict`. Never reads the picker cache.
- **Picker selection + trade ticket CTA** never read `freshness`/`MISSING`; the ticket resolves
  the broker symbol on submit and re-gates at the backend. `tradeable` is a separate broker-spec
  field that only tints a dot/tooltip — it never disables selection either.

**Why:** a cold picker cache (`MISSING`) must NOT be able to false-block or disable a symbol whose
real feed is live. Verified COSMETIC — dispatch resolves feed freshness independently of the picker.

**How to apply:** never make the picker's `freshness`/`MISSING` an input to any trade-decision or
CTA-enable path; if you improve UX, relabel `MISSING`→"checking…"/warm the cache — do not gate trades
on it. The safety floor stays correct because it reads the real feed, not the overlay cache.
