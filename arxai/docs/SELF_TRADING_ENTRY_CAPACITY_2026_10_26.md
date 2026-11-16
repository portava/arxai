# Self-trading atomic admission — 2026-10-26

This follow-up depends on the broker-evidence and management-claim work in PR #77. It changes admission/accounting correctness, not trading strategy, profitability, broker authorization or deployment readiness. It requires no schema migration.

## What each part does

| Component | Responsibility |
| --- | --- |
| `executionGate.ts` | Existing permission and risk prechecks; its read-only result is advisory to admission because facts may change. |
| `entryReservation.ts` | Lock the agent, reload identity/settings/funding/decision, reject stale inputs, check committed and pending capacity, and atomically insert an audited reservation. No broker calls run inside its transaction. |
| `agentExecutor.ts` | Size through existing logic, obtain reservation, recheck kill switch, write intent, then call the existing Trade Engine. Preserve reservations on uncertain outcomes. |
| `agentReconciliation.ts` | Existing #77 broker-evidence authority settles linked reservations. A returned request or elapsed time cannot release capacity. |
| `agentLedger.ts` | Serialize fund, withdraw and realized-P/L posting under the same agent lock. Never withdraw behind an active reservation/position. |
| `service.ts` | Configure, activate and change autonomy using agent-first locking, so state changes do not commit stale funding assumptions. |

## Guarantees and changed behavior

- Different decisions from overlapping cycles compete for the same agent capacity. Checking a limit and reserving the slot happen in one PostgreSQL transaction.
- `PENDING_TICKET` and `DISPATCHED` consume concurrency and daily headroom. Old unresolved entries still count after UTC midnight and server restart. `FILLED` consumes concurrency until a confirmed close, even when the current position snapshot is absent.
- The daily filled count remains actual fills. Pending headroom is a separate admission calculation; prepared drafts are not presented as filled trades.
- Valid `PREPARE_ONLY` decisions still stage a draft for a person. They reserve capacity until confirmed or definitively canceled/rejected.
- A decision ID is consumed once an execution row commits, including terminal outcomes. A new attempt requires a fresh decision ID. Audit/transaction failure before commit leaves no reservation.
- Fresh owner identity is mandatory. An orphan `USER` agent cannot borrow its creator's identity. Operator-fleet agents require their explicit creator context and no user-owner field. Decision/agent/side/protection mismatches are refused.
- Any change to the agent, settings, ledger or decision snapshot used by the permission gate/sizer causes admission to refuse stale work. Settings and funding are not silently replaced after sizing.
- A known pre-draft refusal can release capacity. A returned command ID, thrown submission, or lost command-link write retains the pending reservation. No timeout or lease silently enables a second order.
- A database failure is reported as reservation unavailability, not as a duplicate decision.
- Withdrawals now refuse while the agent has pending, dispatched or filled executions. This conservative rule prevents capital withdrawal behind an already sized attempt. Funding remains available. Concurrent funding and realized-P/L posting cannot overwrite balances or post the same execution twice.

## Lock order and deployment requirements

Admission takes `agent → settings → ledger → decision`, then reads execution state and inserts reservation/audit rows. Funding, withdrawal and realized-P/L posting take `agent → ledger`; settings edits take `agent → settings`. Activation and autonomy changes lock the agent before reading dependent facts. Protective reconciliation updates execution rows without taking the agent lock; a concurrent settlement can temporarily make admission conservative but cannot create extra capacity.

The existing active-key unique index remains a backstop. All-status decision replay prevention and capacity serialization depend on the agent-lock protocol. Every active server must run the updated admission code before relying on the guarantee; an older writer during a mixed-version rollout does not participate in that protocol. This work does not perform a rollout.

The design uses PostgreSQL row locks and short transactions, consistent with [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html). External broker work stays outside the transaction.

## Validation and limits

Run `pnpm --filter @workspace/api-server test:self-trade-entry-postgres`. PostgreSQL's `initdb`, `pg_ctl` and `createdb` must be available; set `ARX_TEST_PG_BIN` to their directory when needed. The runner creates a new temporary cluster/database with a unique private Unix socket, disables network listeners, discards inherited credentials, and removes the cluster after tests. It never connects to the application's configured database. The suite is registered in the release integration lane (`ci:integration`), separately from the default offline CI job. PostgreSQL binaries are a required integration-runner dependency; missing binaries fail instead of silently skipping. It can be run alone without provisioning any application database.

The tests exercise actual PostgreSQL row locks, audit rollback, client disconnect, fresh application connections, 24-way capacity contention, terminal retries, UTC rollover, settings changes, funding/withdrawal, duplicate P/L posting and a withdrawal/activation barrier. Actual executor tests use synthetic venue responses to inject submission crashes, uncertain command responses and command-link write loss. Broker functions are replaced with fixtures; no broker connection or order is made.

Still unresolved:

- **Dispatch account pinning:** entry owner is checked here and #77 checks persisted dispatch account evidence, but the shared dispatcher can select/rebind a bridge later. Target-account/session pinning across every boundary still needs implementation and tests.
- **Mutable facts after admission:** the follow-up [dispatch-authority change](SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md) adds fresh agent/sizing authority checks at draft, confirmation and final claim. Account/session pinning and changing market/platform facts remain separate concerns; shared dispatch gates remain authoritative.
- **Quantity-aware partial/external-close accounting:** unresolved partial fills, manual closes and missing close evidence remain held. A pending claim cannot be repaired solely by age; a scoped audited evidence-based repair workflow remains necessary.
- **Portfolio/risk-budget semantics:** this reserves position count and daily attempt headroom, not cash margin or portfolio VaR. Existing shared risk gates still apply. Broker lot steps, current quote quality and strategy validation remain separate work.
- **External validation:** no live/demo broker timing, account-switch, failover, partial-fill or profitability claim is established by these tests.
