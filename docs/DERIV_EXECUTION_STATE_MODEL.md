# Deriv execution state model

The governing rule:

> **ARX may be conservative, but it may never be falsely certain.**

Everything below exists to keep those two halves apart. Over-warning is
acceptable; asserting something the venue never said is not — in either
direction. Reporting an open position as closed strands capital; reporting a
closed position as open sends someone hunting a contract that no longer
exists. Both are false.

## Evidence classes

Every fact ARX reports is one of three kinds, and they are never mixed.

| Class | Meaning | Examples |
|---|---|---|
| **VENUE-PROVEN** | the venue asserted it | `contract_id` in a buy receipt; `is_sold` in a contract re-read; a venue error frame on our `req_id`; `buy_price`; `entry_spot` / `exit_spot` |
| **INFERRED** | ARX concluded it from something local | that a frame reached the socket; that a quote's price is what a fill will cost |
| **UNKNOWN** | no sufficient evidence | a request written to the wire whose reply never arrived |

**Venue evidence dominates local inference.** Where a local conclusion and a
venue statement disagree, the venue wins, and the disagreement is reported.

## Order states

| State | Entered only on | Class |
|---|---|---|
| `NOT_SENT` | the transport reports `wireWritten === false` — the state check, a null socket, or a throwing `sock.send()` | VENUE-PROVEN *(non-transmission is locally provable)* |
| `REJECTED` | a venue error frame correlated to our `req_id` | VENUE-PROVEN |
| `OPEN` | a buy receipt carrying a numeric `contract_id` | VENUE-PROVEN |
| `UNKNOWN` | the frame was written and nothing adjudicated it | UNKNOWN |
| `SETTLED` | a contract re-read with `is_sold` truthy | VENUE-PROVEN |
| `CONTRADICTED` | a sell receipt exists **and** the re-read says `NOT_SOLD` | VENUE-PROVEN *(both statements are the venue's)* |

`NOT_SENT` is the **only** clean no-trade. Non-transmission is the one thing
ARX can prove about the venue without the venue: bytes that never left cannot
have been acted on.

## Forbidden transitions

- **UNKNOWN → REJECTED** without a venue refusal. Silence is not a "no".
- **REJECTED → UNKNOWN** because an attempt was recorded. The order counter
  records *intent* before the write; it cannot establish transmission, and
  deciding on it produced the literal falsehood *"transport is DISCONNECTED …
  the buy frame WAS written to the socket"*.
- **anything → SETTLED** on expiry alone. For a multiplier the close path is a
  **sale**; Deriv can report a contract expired, unsold and not settleable.
- **anything → SETTLED** on a sell receipt alone. A receipt reports an event;
  closure is the venue's statement about current state.
- **UNKNOWN → resolved** from a reply whose ownership is unproven. A reply for
  a `req_id` ARX never issued is discarded.

## The one resolution that IS allowed

**UNKNOWN → OPEN or REJECTED on a late correlated reply.** `req_id` is
per-transport and **monotonic across reconnect** (measured: 2 → 3, no reset),
so ids are never reused and a reply bearing one ARX issued is provably ours.
Attribution uses the op ARX *issued* under that id, never the op the reply
happens to contain. Draining is one-shot.

Discarding such a reply is not conservative — it is a 20-second local timer
outranking later, correlated, authoritative venue evidence, which is the
precedence rule inverted.

## Settlement evidence is three-valued

`SOLD` · `NOT_SOLD` · `ABSENT` · `UNRECOGNISED`

A boolean made *"the venue says not sold"* indistinguishable from *"the reply
carried nothing usable"*. `UNRECOGNISED` (an `is_sold` type ARX does not
accept) names itself, so a schema drift sends a reader to the schema rather
than to the venue to hunt a position that may already be closed.

## Partial fill: not representable

Settled from the schemas, not from MT5 intuition.

- `buy_request` requires only `["buy","price"]` — no quantity, size or lots.
- `buy_response.buy` requires all nine fields and defines **no** filled-amount
  field.
- A multiplier position is stake × multiplier, not lots.

The buy is **atomic**: a contract is created or it is not. Modelling
`PARTIALLY_FILLED` would invent a state the venue cannot express — false
certainty aimed at a phantom. A source pin fails if the concept appears
anywhere in the new-API tree.

`price` is documented as *"Maximum price at which to purchase the contract"*,
so ARX's ceiling is venue-enforced; `buy_price` is *"Actual effected purchase
price"*, and that — never the quote — is what reconciliation reads.

## Reporting rules

- A PASS step never claims closure before the venue confirms it. The sell step
  says **"sell receipt"**, not "closed".
- `current_spot` is the live streaming quote at read time and is labelled
  `streamingSpot`. The contract's own `entry_spot` / `exit_spot` are the only
  values reported as the trade's movement, with **no fallback** to the quote.
- A value the venue did not state is reported as unstated, never defaulted.
- An UNRESOLVED step keeps its machine-readable error code.

## What still requires live venue evidence

These cannot be settled offline, and none is a plan — each needs explicit
owner authorization:

1. **Which key the sell receipt actually arrives under.** The schema says
   `sell`; ARX also accepts `sold` from an early fixture. Harmless (a wrong
   guess yields UNRESOLVED, never a false close) but unconfirmed.
2. **Whether Deriv ever returns a receiptless-but-successful sell.** The
   schema permits it; it has not been observed.
3. **Real requote behaviour** when the price moves between proposal and buy.
   The ceiling is documented; the venue's actual response is not observed.
4. **Genuine rejection codes** for a live multiplier buy. The codes handled
   are documented, not observed.
