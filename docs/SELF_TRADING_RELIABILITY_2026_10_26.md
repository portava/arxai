# Self-Trading reliability review — 2026-10-26

This change improves execution correctness and recovery. It does not establish trading profitability, production readiness, or a “world class” rating. The controlled autonomous cycle remains admin-triggered; it does not introduce an always-on trading loop.

## Architecture and responsibilities

| Component | Job | Authority |
| --- | --- | --- |
| `decisionEngine.ts` and domain decision pipeline | Build and rank market/strategy candidates; apply chart truth and supervisor decisions | Produce decisions; cannot dispatch |
| `executionGate.ts` and domain execution permission | Resolve agent funding, kill switches, access, quota and governor facts | Add refusals before the common trading pipeline |
| `agentExecutor.ts` | Size an approved decision, reserve its execution attempt and request the existing trade engine | Uses the existing governed entry path |
| `agentReconciliation.ts` | Advance prepared/dispatched entries and managed closes from owned command evidence | Reads command outcomes; never sends orders |
| `livePositionManager.ts` | Evaluate real positions and request protective changes through Position Guardian | L2 advises; L3+ may request existing permitted operations |
| `executionLifecycle.ts` | Define command ownership, settlement evidence, pending management and operator explanations | Pure evidence rules, no broker calls |
| Position Guardian and Trade Engine | Enforce registered management authority, stop direction and shared dispatch gates | The existing execution boundary remains authoritative |
| Agent ledger and AACI learning | Account for real outcomes and update advisory trust | Outcome consumers; not order authority |

## Confirmed defects addressed

1. **Human-confirmed drafts were not reconciled.** The previous loop inspected only `DISPATCHED`, leaving an L1 `PENDING_TICKET` record behind after a real fill. Both states now follow the same evidence rules. Cancelled drafts resolve without becoming fills.
2. **Polling time replaced event time.** Fill and close timestamps now use the underlying command’s real event timestamps. A delayed poll no longer moves a trade across a UTC daily-budget boundary.
3. **Accepted stop requests were recorded as completed protection.** Previously the manager immediately updated `slPrice` and `beMoved` on `ok: true`. It now waits for a settled modification command and a matching or stronger observed broker stop. Existing optimistic `beMoved` values do not override current broker protection.
4. **Overlapping cycles could repeat management requests.** Each position now receives a durable compare-and-set claim before dispatch. Concurrent cycles cannot claim the same unchanged state. Claims survive restart; neither age, timeout, acknowledgement nor an unknown outcome releases them.
5. **Management refusal discarded command identity.** The existing instant close/modify path now retains command IDs on failures after draft creation. An ambiguous command stays linked for reconciliation. A returned pre-draft refusal can release the claim because no command exists; a thrown outcome after calling the pipeline remains held.
6. **Close and entry evidence needed stronger binding.** Entry evidence checks executing user, agent, decision, command type, symbol and side. New self-trade drafts persist the requested canonical symbol and exact resolved broker symbol together in the integrity-signed payload. Older drafts require an exact symbol match. Management evidence additionally binds the entry command’s bridge, account login and server to the observed position and management command; same-user account switches cannot free claims or settle another account’s trade. Missing/ambiguous identity is held for review. Entry and full-close completion require the requested and executed quantities to match the intended quantity, as well as valid prices and event times.
7. **The control room could claim a close before settlement.** Cycle completion counts now reflect confirmed stops/closes. The execution feed explains pending broker confirmation and unlinked outcomes requiring review.

Reconciliation also reads only active execution states and batches linked command reads, avoiding one command query per execution. The compare-and-set update uses the execution primary key and previous status/JSON state; it does not hold a database transaction open while the broker pipeline runs.

## Evidence model

- `LIVE_ACKNOWLEDGED`, `LIVE_PARTIALLY_FILLED`, `LIVE_UNKNOWN` and `LIVE_RECONCILIATION_REQUIRED` do not mean a complete fill.
- An old unlinked management claim is not safe to retry automatically. The command may have been accepted just before the process lost its response or command-link write.
- A positive executed quantity survives cancellation of the remaining quantity; this change does not erase that exposure or label it a full fill. A status marked filled with a smaller or missing executed quantity cannot settle the full intended volume. A later close of a remainder after an external partial close remains unresolved instead of fabricating full-volume P/L.
- Management retries after a matching terminal rejection begin with a fresh evaluation. A pending claim retains the same claim ID across calls and restarts.
- After an ambiguous submission, an operator must inspect the existing command/event and broker evidence before any release. This PR deliberately adds no automatic claim reset endpoint or TTL expiry.

These choices are consistent with MetaQuotes’ distinction between accepting a request and executing it, and FIX’s distinction between pending changes and confirmed replacement. They are engineering comparisons, not a claim of FIX certification or regulatory compliance. [MetaQuotes OrderSend](https://www.mql5.com/en/docs/trading/ordersend), [FIX Trade specification](https://cdnws.fixtrading.org/wp-content/uploads/download-manager-files/Trade-COMPLETE.pdf).

The offline fault tests and retained results follow the general testing/monitoring practices described in [FINRA Notice 15-09](https://www.finra.org/sites/default/files/notice_doc_file_ref/Notice_Regulatory_15-09.pdf). Atomic, short updates follow [PostgreSQL concurrency semantics](https://www.postgresql.org/docs/17/explicit-locking.html). No applicability assessment of securities regulation is made here.

## Remaining work before an elite-system claim

| Area | Current gap and next evidence required |
| --- | --- |
| Entry admission under concurrency | Different cycles produce different decision IDs. Per-decision idempotency is not a per-agent atomic capacity reservation. Test and reserve in-flight entries against agent quota/headroom before submission. |
| Partial fills and external closes | The agent layer retains incomplete fills without pretending they are full. It still needs quantity-aware lifecycle/accounting for partial entry/close and broker/manual/SL/TP closure paths. |
| Crash reconciliation | Unlinked claims safely stop automatic retries but require evidence-based repair. Add a narrowly scoped, audited repair workflow with command/outbox correlation; never release solely by time. |
| Funding concurrency | Review `ensureLedgerRow`, funding, defunding and realized-P/L posting with real PostgreSQL concurrent transactions. A comment saying a row is locked is not a row-lock proof. |
| Fresh decision and position facts | Revalidate mutable agent settings/funding, setup expiry, market prices and position observation freshness immediately before acting. Add malformed/future timestamp and stale snapshot fixtures. |
| Account identity | This change resolves exact symbol/account identity from the persisted attributed entry command and checks management evidence against it. A remaining dispatch-level task is pinning a target account through the shared pipeline’s bridge selection/rebinding and testing account/session changes between decision, reservation and dispatch. |
| Strategy evidence | Reproducible, provenance-aware historical/paper datasets, costs/spread/slippage, out-of-sample evaluation and regime stress tests are needed. Unit tests do not demonstrate alpha or profitability. |
| Operational SLOs | Establish reconciliation lag, unresolved-claim age, rejection/duplicate rates, cycle latency and workload limits, with failure drills and actionable alerts. |
| Broker validation | Verify real command result timing, stop snapshots, partial fills, restart recovery and account matching in an explicitly authorized broker test environment. This work did not perform such testing. |

## Validation

The new suite exercises real manager/reconciler orchestration with an in-memory SQL seam and fake guardian, plus pure evidence tests. Database/network access is rejected inside the integration fixture. Concurrency tests assert the actual generated compare-and-set predicates and only one state advancement. Restart tests reimport the manager while preserving only the durable row state; they are process-state fault simulations, not a PostgreSQL crash test.

Run `pnpm --filter @workspace/api-server test:self-trade-lifecycle` for the new suite. It is wired into root CI. The validation receipt accompanying this PR records the test totals, both typechecks/builds and architecture guards. No deployment, production mutation, broker connection or live/demo order was made.
