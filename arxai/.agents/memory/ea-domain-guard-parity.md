---
name: EA / domain safety parity & time units
description: MQL5 EA safety logic must mirror the pure TS domain contract exactly; MQL5 is untestable here so drift is silent. Includes the TimeGMT seconds-vs-ms epoch trap.
---

# EA / domain safety parity & time units

Any safety check that exists BOTH as a pure TS domain contract AND inside the
MT5 EA (MQL5) must be in exact parity: same checks, same reason keys, same
fail-open/fail-closed semantics, same order.

**Why:** MQL5 cannot be compiled or unit-tested in this environment, so the only
guard against the two drifting apart is review + a TS fixture suite. Two real
defects shipped this way and were caught only by review/validation, never by an
automated check:
1. The EA pre-trade guard once omitted checks the domain enforced (TP-too-close,
   stop-inside-freeze).
2. MQL5 `TimeGMT()` returns **seconds**; the TS drift evaluator expects epoch
   **milliseconds**. Sending raw seconds made drift ~1000x too large and
   false-tripped SEVERE on every healthy heartbeat, hard-blocking the Live Test.

**How to apply:**
- Edit BOTH sides of any mirrored guard together; re-diff the two `mt5-bridge*/`
  `.mq5` files so they stay byte-identical.
- Cross-runtime epoch/time values are a recurring trap. MQL5 time funcs are in
  seconds; JS `Date.now()` is ms. Normalize at the boundary and add a defensive
  normalizer (seconds-scale value, < 1e12, gets *1000) so older EAs stay safe.
- Fail-CLOSED for live-tick checks (quote freshness, no-price, spread, market
  open); fail-OPEN for spec-number legs (lot min/max/step, stops/freeze) only
  when the broker genuinely reports 0/no-constraint.
- Server preflight intentionally enforces only the deterministic subset; the
  live-tick checks are the EA's job. That asymmetry is by design.
- Unparseable EA timestamp is deliberately WARN (not SEVERE) for compatibility —
  it does NOT hard-block the Live Test. Revisit if malformed heartbeats need a
  harder stance.
- There is no cross-language parity harness yet (proposed follow-up). Until one
  exists, manual diff + the TS guard/drift tests are the safety net.

## Deviation/slippage + market-open parity (added later)
- EA-side slippage protection needs BOTH: a guard-level deviation check against
  a server-supplied reference price (parity with the domain DEVIATION_TOO_LARGE,
  fail-open when no reference price) AND MT5's native CTrade.SetDeviationInPoints
  on every live + demo OrderSend (the hard broker-enforced backstop). The server
  deliberately does NOT enforce slippage (no reliable per-symbol tick) — it is an
  EA-only responsibility by design.
- A server-supplied "reference price" that the EA must honour is threaded through
  the live-command payload, set ONLY from a typed server-side argument and
  stripped from any client-supplied payload (same smuggle-prevention pattern as
  the no-stop-loss override bit).
- Market-open must use real broker SESSION windows (SymbolInfoSessionTrade for
  the current server day-of-week), NOT a SYMBOL_TRADE_MODE != DISABLED proxy.
  Fail-open when the broker exposes no session info (can't prove closed).
- Reason-key parity is checked at the edge cases too: zero/non-quoted bid/ask is
  NO_PRICES, a stale-but-present tick is QUOTE_STALE — reviewers WILL flag a
  collapsed mapping even when behaviour (refuse) is identical.

## EA↔server report/response key & enum contracts are also silently untestable
When the EA POSTs to a server route (e.g. update-report) or reads a JSON
response (update-check), the phase/outcome enum literals and the response key
names must match the server exactly. MQL5 is uncompilable here, so a freeform
"check"/"started" vs server enum CHECK/OK mismatch, or reading "blockReason"
when the server returns "reason", fails 400/degrades silently and is caught
ONLY by review. **How to apply:** when adding any EA↔server JSON contract,
diff the MQL5 literals against the server zod enum + the exact response key
names by hand.

## Serve EA-parsed fields at TOP LEVEL; the MQL5 parser is flat
The EA's JsonReadString is a flat substring search, but a server response that
nests the update package (`manifest.{version,sha256Checksum,downloadUrl}`) is a
silent contract break: even when a flat search *might* find a nested key, it's
brittle (key-ordering / prefix collisions like targetVersion) and a reviewer
will (correctly) reject it. **How to apply:** any field the EA reads must be
emitted at the response top level. Extract a pure response builder and unit-test
exact key parity (ALLOW serves package, BLOCK withholds it) so the contract is
enforced without compiling MQL5.
