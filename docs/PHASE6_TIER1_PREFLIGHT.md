# Phase 6 — Tier 1 pre-flight

**No order is placed by this document.** It states exactly what must be true
before the first Deriv DEMO order, and how each fact is established.

## What the runtime will require

| # | Requirement | How it is enforced |
|---|---|---|
| 1 | `ARX_EXECUTION_TIER=TIER_1_DEMO_GUIDED` set explicitly | `resolveExecutionTier` whitelists exact literals. Absent, empty, `"1"`, `"true"`, wrong case and near-misses all resolve to `TIER_0_DRY_RUN`. Presence is never consulted, only value. |
| 2 | Account proven DEMO by **venue evidence** | `resolveDerivDependencies` requires `DemoEvidenceSource` of `VENUE_ACCOUNT_ATTRIBUTE` or `VENUE_ACCOUNT_LIST`. `INFERRED_FROM_NAMING` is REFUSED. Token naming, env naming, a UI label and the adapter's URL allow-list are all insufficient by construction. The classification itself is Phase 5's certified `isDemoAccount`, which is strict: only an explicit `demo`/`virtual` marker qualifies and an **unknown type is not demo**. |
| 3 | Connection owned by the authenticated user | Checked at both hops: connection→user and account→connection. |
| 4 | No unresolved prior Deriv intent | `derivOrderIntentsRepo.hasUnresolvedIntent` — checked in the resolver AND in the guided service. |
| 5 | Kill switch clear | Checked in the resolver before credentials are touched. |
| 6 | Approved, unexpired ticket whose terms fingerprint still matches | Pure authorization + a CAS claim against the database clock. |
| 7 | Constitution permits, evaluated AGAIN at dispatch | A version change since approval refuses; the ticket is not re-based. |

## The command that establishes DEMO from venue evidence

Run on Replit. **Read-only** — it authenticates and reads the account list. It
places no order.

```bash
pnpm --filter @workspace/api-server run diagnose:deriv-new-api
```

What must come back: the account list, with the target account reporting
`account_type` of `demo` (or `virtual`).

> **Corrected.** An earlier version of this document said to look for
> `is_virtual`. That was wrong — I wrote it before reading Phase 5's certified
> classifier. Deriv's new API reports **`account_type`**, and
> `accounts.ts:isDemoAccount` is what decides. A `VRTC` prefix is naming, not
> evidence, and remains insufficient either way.

## Confirm no unresolved intent

```bash
psql "$DATABASE_URL" -P pager=off -tAc "select count(*) from deriv_order_intents where resolved_at is null and write_disposition in ('WRITTEN','UNRECORDED');"
```

Must be `0`. Any other number means an earlier attempt may still have an order
standing at the venue, and no new order may assume that exposure is absent.

## Schema still to apply

`docs/phase6-additive-schema-2.sql` — one table, four indexes, additive only.
The forensic ledger does not persist until it is applied.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/phase6-additive-schema-2.sql
```

## The harness

```bash
pnpm --filter @workspace/api-server run certify:tier1-demo -- \
  --account=<loginid> --user=<id> --i-authorize-one-demo-order
```

Runs all six pre-flight checks and **refuses on any failure without placing an
order**. With no arguments and no environment it fails all six — the safe
default is refusal, not action.

The flag is required because a script that places an order when run with no
arguments is a script that places an order by accident. Nothing about the
environment substitutes for it.

The harness does **not** place the order itself. It clears pre-flight, then
hands over to the guided product path — propose, approve in the inbox, dispatch
— so what gets certified is the path a user actually takes, rather than a
shortcut the harness invented.

## The certification ticket

Smallest practical stake: **$1 stake, multiplier 100, R_100**, with a stop
attached (the Constitution requires one). One order, reconciled fully before any
consideration of a second.

## Stop conditions — halt immediately

If any execution state becomes UNKNOWN or UNRESOLVED: **stop placing orders**,
do not retry, and resolve through the certified Phase 5 reconciliation model. A
retry against an uncertain exposure is how one approval becomes two positions.

## What is NOT authorized by this document

Live-money execution, autonomous execution, unattended dispatch, Tier 2+
session-wide approval, or weakening any gate to make an order pass.
