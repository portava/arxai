# Deriv new-API transport

ARX speaks to two Deriv API generations. They are not variants of one protocol
and are never allowed to mix.

| | Legacy | New |
|---|---|---|
| App ID | numeric (e.g. `1089`) | alphanumeric |
| Credential | API token via an `authorize` WS message | Personal Access Token as a REST Bearer |
| Session | connect, then `authorize` | REST → account → OTP → authenticated WS |
| Quote field | `symbol` | `underlying_symbol` |
| Account in request | `loginid` | none — the session carries it |

Mode comes from `lib/deriv/apiMode.ts`. It sits outside `newApi/` and imports
nothing, so both generations read the *same* detector. An explicit
`DERIV_API_MODE` wins over inference; otherwise an alphanumeric App ID plus a
token means new, a numeric App ID means legacy.

## Session lifecycle

```
DISCONNECTED → OTP_REQUESTING → WS_CONNECTING → WS_READY
                     ↓                ↓            ↓
                  FAILED           FAILED     RECONNECTING → OTP_REQUESTING
```

Only `WS_READY` may send. A request issued earlier is refused, not queued —
queueing turns a connection problem into a trade that fires at an unknown
later moment.

**No `authorize` is ever sent.** The OTP established the account context; a
handshake after open would be the legacy flow leaking into the new generation.
A test asserts the socket receives *zero* messages on connect.

**The OTP is a credential.** Single-use, treated as expired at 90s (Deriv
allows ~120s; the margin stops an in-flight request straddling expiry), never
logged, and dropped from any URL before it reaches a log line. A ticket is
marked consumed even when the dial *fails*, because a dialled OTP is spent
either way. Reconnect always requests a fresh one.

**A 401/403 during OTP is not retried.** A bad credential does not improve on
retry, and hammering it buries the real cause.

**A close rejects every in-flight request.** A caller that never hears back
cannot reconcile, which is the failure the UNKNOWN work exists to prevent.

## Account selection

Deterministic and fail-closed: an explicitly configured demo id, otherwise
exactly one active demo, otherwise refuse. Two demos is `ACCOUNT_AMBIGUOUS`,
never a guess. A configured id that resolves to a **real** account is refused —
explicit configuration is not authority to trade real money. Unknown account
type is never treated as demo.

## Normalizer honesty

A wrong request mapper fails loudly at the venue. A wrong response normalizer
invents a position that does not exist, or hides one that does. So:

- A success-shaped `buy` with **no `contract_id` is not a purchase**. Same rule
  the MT5 path enforces: no ticket is never a fill.
- An open contract with **no settlement evidence is open**, not settled.
- Missing numbers stay `null`, never `0` — `0` reads as a free contract, or a
  funded-but-empty account.
- Malformed portfolio rows are skipped **and counted**. Coercing an id corrupts
  reconciliation; dropping the batch hides real positions; a silent skip lets
  one vanish with no signal.
- `buy` refuses an unbounded price. Price is a ceiling; without one the venue
  may reprice between quote and fill with ARX consenting to nothing.

## Read-only certification

```bash
pnpm --filter @workspace/api-server run certify:deriv-new-api
```

Makes real calls with the configured PAT. Places **no trade**: every payload
passes an allow-list that refuses `buy`, `sell`, and anything not explicitly
permitted, including operations Deriv adds after this was written. A `proposal`
*is* taken — it is a quote, commits nothing, and its buyable id is the evidence
certification needs.

Halts on first failure; a partial run is never reported as passed and the
command exits non-zero. Output carries no token, OTP, header, full account id,
or balance figure — asserted by a test, not by care.

Deliberately not in `ci`: CI must not depend on a third party being reachable,
and a certification that runs automatically stops being a decision someone made.

**Certifying the transport is not certifying trading.** Order placement stays
uncertified until the separate demo-trade certification is run deliberately.

Status 2026-08-25: **17/17 steps pass** against the live venue on a demo
account. See Ruling 16 in `OWNER_DECISIONS.md`.

### Step 9 is load-bearing — and it has now answered

The endpoints are published under `/trading/v1/options/` while ARX trades
**multipliers**. That was carried as an open assumption for the whole build,
never as a fact.

**Settled 2026-08-25: `R_100` returned 65 contract types including
MULTUP/MULTDOWN.** `options` is an umbrella product name and the surface serves
ARX's actual market. The step remains in the sequence because a venue can
change what it offers, and a transport that works but cannot price the
contracts ARX trades is useless — so this fails loudly rather than passing
quietly.

Note the request shape: `contracts_for` is `additionalProperties: false` and
takes **only** `{contracts_for: "<symbol>"}` plus the optional envelope keys.
The symbol is the value, not a field — the `symbol` → `underlying_symbol`
rename does not propagate here. Multiplier capability is discovered from
`available[].contract_type` in the RESPONSE; it was never a request filter.
Sending `currency` or `contract_type` here is rejected as
`InputValidationFailed`.

## Separation from legacy (Ruling 15a)

New mode must never fall through to the legacy handshake. A test scans **every**
file in `newApi/` — not a fixed list — and fails if any imports the legacy
client, names the legacy WebSocket host, references the bootstrap app id, or
builds an `authorize` payload. A new module is covered the moment it exists.

Comments are stripped before scanning. This tree discusses the legacy path
constantly, and matching prose instead of code has produced false passes four
times in this workstream.
