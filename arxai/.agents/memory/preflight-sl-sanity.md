---
name: Preflight SL sanity is physics not policy
description: Why the BUY-SL<entry / SELL-SL>entry / distance≤50% check in liveCommandPipeline.preflight must run for every profile, owner-unrestricted included.
---

**Rule:** The SL-direction + SL-distance sanity check in
`preflight()` (artifacts/api-server/src/lib/live/liveCommandPipeline.ts)
applies to EVERY risk profile — including `isOwnerUnrestricted`. It is
NOT one of the four policy caps (symbol allowlist, per-symbol lot,
daily-loss USD, SL/TP requirement) that the owner profile is allowed
to bypass.

**Why:** A long whose SL is above current ask, or a short whose SL is
below current bid, is malformed regardless of how much trust the
account has. MT5's broker layer will reject with `INVALID_STOPS`
(retcode 10016) anyway — pre-flight just catches it earlier with a
useful message. Bug that motivated this: a BUY EURUSD with SL=1.80
(spot ~1.16, so SL ~55% above entry) cleared pre-flight as
"PRE-FLIGHT PASS" then got a generic "Trade blocked by safety checks"
banner from the 16-gate. Pre-flight lying first is the same class of
bug as the "feed is live and fresh / data is delayed" contradiction.

**How to apply:**
- Place the check AFTER the existing four policy caps and BEFORE
  `return { ok: true }` — so policy refusals still fire first for
  non-owner accounts, but the physics check still bites owner-unrestricted.
- Fetch the reference price best-effort via
  `getMarketProvider().getLiveQuote(symbol)` (BUY uses ask, SELL uses
  bid, falling back to price). If the quote source is unavailable,
  skip silently — the 16-gate and MT5's INVALID_STOPS still catch
  truly malformed stops downstream. Do NOT fail closed here; an
  empty quote chain would otherwise wedge every live trade.
- Refusal codes: `STOP_LOSS_WRONG_SIDE` (wrong side of price) and
  `STOP_LOSS_UNREASONABLE` (|SL−ref|/ref > 0.5, the pip/price-typo
  case). Both must be present in `LiveDraftRefusal["reason"]` AND in
  `liveSharedReasonCopy.ts` with a copy mapping, or the frontend will
  fall through to the generic "Trade blocked by safety checks"
  sentence and the operator will be left guessing again.
- Distance threshold is intentionally loose (50%). It is a typo
  catcher, NOT a risk-management gate. Don't tighten it without
  consulting risk-template config — wide-stop swing positions on
  high-vol indices/synthetics can legitimately sit >5% away.
