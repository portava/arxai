---
name: Scanner header vs card actionability reconciliation
description: How the Scanner header Action cell and the selected-symbol card agree on ONE actionability verdict without a third opinion.
---

The Scanner header strip's Action cell and the selected-symbol Focus scalp card
must show the SAME actionability verdict. The card is setup-aware (it knows the
scalp-engine status, not just the feed); the header's own consolidated block is
data-only (setup = UNKNOWN), so it is strictly more conservative. Left to
recompute independently they contradict each other — the canonical bug was a card
reading "Ready now" while the header read "Wait for confirmation".

The fix: the selected card LIFTS its computed `ScannerActionability` to a
page-scoped store (`selectedActionStore`, keyed by `${UPPER_SYMBOL}|${timeframe}`);
the header CONSUMES it through the single precedence function
`resolveSelectedSymbolActionability(lifted, dataOnly)` = `lifted ?? dataOnly`.

**The key MUST include timeframe, not just symbol.** A scalp verdict is
timeframe-specific (the 1m scalp card publishes under bus timeframe `"1m"`); if the
store were keyed by symbol alone, switching timeframe on the same symbol would
leave a stale lower-timeframe verdict in the header Action cell. Publisher and
reader must agree on BOTH casing (store uppercases both) AND timeframe coercion:
the header reads `get(bareSymbol, coerceVisibleTimeframe(timeframe))`, so the
publish timeframe must be a visible chip value (e.g. `"1m"`/`"15m"`), never the
broker name `"M1"` — publishing `"M1"` silently misses the read. The cross-
timeframe correctness comes from the KEYED read (a `(SYM,"1m")` entry simply
misses `get(SYM,"15m")` → data-only fallback); clear-on-switch/unmount is the
secondary guard.

**Why:** The card has richer (setup-aware) knowledge than the header's data-only
verdict, so the card's verdict must win; the data-only verdict is only the
fallback when no card has published (other tabs, loading, mid symbol switch).
Never let the header derive a third, independent verdict — that is exactly what
reintroduces the contradiction this design exists to kill.

**How to apply:**
- One precedence point only: `resolveSelectedSymbolActionability` (pure, in
  `scannerActionability.ts`). Do not add a parallel reconciliation anywhere.
- The lift must clear stale entries on symbol switch and on unmount, or the
  header shows a previous symbol's verdict. The store's `get` returns null for an
  unpublished symbol → header falls back to its own data-only verdict (honest, not
  fabricated).
- Honesty floor still wins: a feed cap (e.g. SYNCING → FEED_LIMITED) caps the
  card's verdict BEFORE it is lifted, so lifting can never offer a live action on
  an unconfirmed feed.
- The regression lock lives in `scannerTruthRegression.test.ts` block "(11)":
  assert card READY_NOW vs header data-only WAIT_FOR_CONFIRMATION, then
  `resolveSelectedSymbolActionability` picks the card's; plus null-fallback and the
  FEED_LIMITED-over-READY floor. Test the real pure functions, never a mocked echo.
