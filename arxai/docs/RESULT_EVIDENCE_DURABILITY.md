# Concurrent result evidence

Base: `8042af50`, 2026-10-26. This slice repairs server receipt durability. It
does not certify terminal delivery, account/session identity, broker execution,
strategy returns, or production throughput.

## Research and acceptance

MetaTrader 5 exposes multiple transactions for one request and does not guarantee
the order of their arrival. Its terminal transaction queue is bounded, so an
application must distinguish receipt, later execution evidence and recovery.
[MetaQuotes transaction handler](https://www.mql5.com/en/docs/event_handlers/ontradetransaction).

PostgreSQL row locks serialize competing changes until transaction completion.
A fresh statement after acquiring the lock sees prior committed changes under
READ COMMITTED. Per-command evidence numbering therefore belongs behind the
command lock, with result and evidence in one transaction.
[PostgreSQL explicit locks](https://www.postgresql.org/docs/current/explicit-locking.html),
[transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

PostgreSQL sequence allocation is concurrent-safe, but rolled-back allocations
are not reclaimed. Globally gapless serial IDs are not a durability guarantee;
this change retains the existing serial identifiers and uses the existing
per-command sequence uniqueness for persisted observation order.
[PostgreSQL sequences](https://www.postgresql.org/docs/current/functions-sequence.html).

PostgreSQL identifies row versions with `xmin`; `ctid` changes on update or a
physical rewrite. Neither is permanent row identity, and transaction IDs wrap.
The manual-close snapshot guard therefore retains the primary key and full row
identity, rejects old/ambiguous transaction age, and bounds its full-XID interval
to fewer than one billion transactions. A changed token holds local application;
it never establishes broker event order.
[PostgreSQL system columns](https://www.postgresql.org/docs/current/ddl-system-columns.html).

Acceptance criteria set before timing:

- Twenty identical simultaneous reports and later retries produce one applied
  outcome, receipt, critical audit row and side-effect application.
- Every distinct recognized report in 24-way conflict and mixed-writer fixtures
  remains durable, with one accepted outcome; no stale duplicate counter loss.
- An execution-event, ordinary audit or critical-chain write failure rolls back
  the result and counter. It cannot produce a successful receipt. Recovery and
  retry apply once, including after a cancelled database transaction.
- The existing hash algorithm, redaction, global chain lock and verification
  remain intact. All observed chain links verify, including concurrent commands.
- Account/owner checks happen after the command lock. A concurrent bridge switch
  or unknown-outcome sweep cannot be bypassed by a stale reader.
- ACK and partial results use the existing legal transitions. Incompatible or
  out-of-order reports stay as evidence without downgrading exposure or replacing
  a terminal result. No transition permission is added.
- The legacy bridged result route returns a failure when authoritative result
  persistence fails. Unbridged/manual acknowledgement behavior stays unchanged.
- Previous exact-target, accounting-hold and entry authority tests remain green.
- Measure actual previous/current server response and all-unique-receipt commit
  observation, median/p95/p99/max, under sequential, identical retry, distinct
  report and independent-command loads. Current local p95 target: under 100 ms.
  Report baseline missing evidence as incomplete, never omit it to improve timing.

## Implementation and compatibility

A shared strict event writer locks the command before allocating its next event
number. No retry-on-sequence-conflict loop silently drops an event. Both pipeline
and reconciliation append paths use it. No schema migration or permission change
is required; the existing command/sequence unique index remains authoritative.

The result handler locks the owned command, checks its current bridge, and hashes
a canonical form of the recognized report fields. Exact retries find that durable
fingerprint and return the latest committed command, then retry only idempotent
settlement consumers. A new report either follows an existing legal transition or is retained as late evidence.
Distinct retained reports increment the counter under the same lock. The counter
now means additional distinct reports, rather than HTTP request attempts.

Outcome, execution receipt, ordinary result audit and existing critical hash-chain
append commit together. Failure propagates; an unknown chain hash is not accepted
as successful evidence. The chain format/redaction algorithm is unchanged. The
critical row includes the report fingerprint, binding the recognized report's
canonical contents to that existing chain. Reports predating this version lack
fingerprints; their first new retry is retained conservatively and never reapplies
an already terminal outcome. No historical event is mutated or deleted.

Lock order for this transaction is command → security-chain advisory lock. No
agent, bridge or position lock is acquired inside it. Existing exact-target
post-processing still starts its own transaction in agent-first order after the
result transaction commits. Current other chain writers acquire no command locks,
so no reverse chain→command edge is introduced. Reconciliation/snapshot callers
use the same per-command event writer outside their prior status transactions.
Those other status/event pairs are not made atomic by this slice. In particular,
an event-storage failure after pickup/dispatch state commits can still leave a
command needing UNKNOWN/reconciliation handling; this change does not certify
lossless command delivery.

## Evidence boundary and unresolved work

"Durable receipt" means the server committed the recognized result fields and its
audit. It is not proof that the intended MT5 account executed the command. This
change does not widen the trusted identity envelope. The prior exact-row and
whole-agent accounting holds remain intact.

The route still stores the raw legacy mirror result separately before forwarding.
Its accepted live result/evidence is authoritative and first-write-wins; the mirror
itself remains a mutable legacy transport record. The canonical fingerprint covers
fields accepted by the result API, not arbitrary unknown raw HTTP fields. Terminal
account/session pinning, complete raw-report ingestion and legacy mirror redesign
remain separate work. The preserved legacy, unbound manual ghost-close path is
still ticket-only; it is excluded for all new signed-basis commands, but historical
identity repair needs a separate migration/authority design. The preexisting
advisory Mission callback still passes floating P/L as `realisedPnl` for manual
closes; this slice does not certify that value as realized profit.

EA154's `PostResultStruct`/`PostResultRaw` call `PostJson`, which logs a non-200 reply
but has no persistent result outbox or delivery retry. Returning 503 honestly does
not make that EA resend. End-to-end lossless reporting needs a terminal outbox,
stable report identity, restart recovery and authenticated acknowledgement protocol.
No terminal code or broker call is changed or tested here.

The result receipt commits before position, exposure and accounting side effects.
Exact retries resume exposure settlement using the latest committed command;
existing reservation compare-and-set prevents double application. Automatic full
closes retry the exact signed-target consumer; the existing snapshot repair also
uses it. Both paths retain the authoritative stored reported identity, rather than
using the new retry body to reinterpret the accepted result.

Newly receipted manual CLOSE results apply cumulative executed volume minus the
last durably applied cumulative volume. A `POSITION_RESULT_APPLIED` event and the
position update commit together under position → command locks. New manual CLOSE
drafts capture an optional server-created, integrity-signed local position basis
under the position lock. Each application requires either that unchanged row
version or the exact version written by the preceding application marker. Missing
basis, changed identity/revision, unverified or oversized volume, and disagreement
with the accepted receipt hold settlement. A broker snapshot invalidates the
version even when it reports the same volume, preventing a double subtraction
when the snapshot already reflects the fill. Missing local evidence does not
prevent protective command creation/dispatch. Changed broker
messages or reordered identity observations can produce distinct evidence, but
cannot shrink the position twice. Fingerprinted manual full results also use this
consumer during snapshot repair, excluding them from the legacy ticket-only ghost
closure. Older manual results retain their prior repair path.

A pre-upgrade partial result can already have changed the position without such
an application marker. Its first new full report is held as
`LEGACY_PARTIAL_APPLICATION_UNKNOWN`; the server never invents zero prior applied
volume. Authoritative position/history reconciliation must resolve that mixed
version case. No historical event or balance is rewritten to infer missing facts.

Successful live acknowledgements expose `receiptPersisted` separately from
`positionSettlement` (`APPLIED`, `HELD`, or `NOT_APPLICABLE`) and the hold reason.
Applied position volume is not certified realized P/L: automatic historical
accounting holds remain independent and unchanged. A consumer transaction error
can still return a failure after the receipt committed; an exact retry resumes it.

There is no durable job scheduler/outbox in this slice. Periodic full-close repair
or another received report can recover a missed position application; a partial
manual close with no retry and no later full report still needs reconciliation.
Advisory mission callbacks/failure-streak accounting are not made durable jobs.
Complete autonomous recovery requires a transactional post-processing workflow;
these limits must not be described as complete end-to-end settlement.

The shared appender propagates failures. Some legacy non-result callers still log
and contain those errors (for example standalone partial-fill observation). Their
entire status/evidence lifecycle is not promoted to atomic in this bounded change.
This limitation must not be described as lossless end-to-end audit capture.

Tests execute the actual result handler, actual strict event writer and unchanged
security chain against synthetic disposable PostgreSQL. Exposure side effects are
stubbed; the preceding management suite exercises the actual close consumers.
Snapshot race fixtures execute the actual `mt5Live` snapshot handler extracted
from its TypeScript AST, with real PostgreSQL/ledger/repair and controlled bridge
authentication plus advisory notifications/guardian scheduling. They exercise
snapshot ingestion writes, not HTTP delivery or broker snapshot ordering. The new
signed-basis repair skips targets no longer in the open-row set, avoiding a transaction per historical close while retaining
explicit exclusion from the legacy ticket-only fallback.
Transport acknowledgement tests execute the actual route handler extracted from
its TypeScript AST with controlled middleware/DB/forwarder seams; they do not open
HTTP connections or validate EA retry behavior. No remote CI run, deployment,
production migration, broker test or order is implied.

## Local validation and performance checkpoint

The isolated correctness checks cover 79 management/result-recovery cases,
16 concurrent result/evidence cases, and 73 entry authority/accounting cases.
The final focused lifecycle/integrity/route/epistemology/reconciliation group has
136 passing cases. API typechecking, the production API build, all 87 guards and
46 open-position guard fixtures pass. These
numbers describe local synthetic fixtures, not a remote CI or broker trial.
Independent source review found no new command/position/security-chain lock-order
inversion; it is not an additional deadlock stress measurement.

The actual old/current report benchmark alternates order, retains all outliers,
and uses the same PostgreSQL fixture and real security-chain algorithm. It
measures handler resolution separately from independently observed durable
completion. The baseline lacks the new durability guarantee, so faster baseline
acknowledgements with missing evidence are not equivalent successful completion.

| Workload | Previous response p95 | Current response p95 | Current all-receipt completion p95 | Previous/current distinct evidence |
| --- | ---: | ---: | ---: | --- |
| Sequential | 5.585 ms | 4.918 ms | 5.737 ms | 100/100; 100/100 |
| Eight identical retries | 10.412 ms | 12.755 ms | 9.299 ms | old 164 redundant rows; current 30 unique receipts |
| Eight distinct concurrent reports | 12.625 ms | 28.697 ms | 36.639 ms | 172/240; 240/240 |
| 32 distinct concurrent reports | 40.790 ms | 92.673 ms |**126.176 ms** | 677/960; 960/960 |
| Eight independent commands | 20.325 ms | 21.297 ms | 27.216 ms | 240/240; 240/240 |

The 100 ms completion budget is **not achieved** for the 32-report workload.
Its current median/p95/p99/max completion is 88.490/126.176/128.635/128.635 ms.
The earlier 114.935 ms failed completion sample is retained too; its fixture used
a noncanonical MODIFY spelling, corrected for the final repeat above. No sample
or missing baseline report was dropped to obtain a passing number. Both tests
ran in coordinated agent quiet windows; uncontrolled OS activity was not isolated.
A separate profiling/optimization pass must preserve atomic persistence and chain
integrity. Competitor execution latency, terminal delivery and production capacity
remain unmeasured; no parity claim follows from these local numbers.

The separately paired actual manual-close benchmark also measures position
completion, not only acknowledgement. Fifty alternating rounds per workload
retain all outliers. Sequential position-completion median/p95/p99/max changed
from 5.146/7.730/13.566/13.566 ms to 6.931/8.336/13.150/13.150 ms. Eight identical
retries changed from 10.373/14.186/17.357/17.357 ms to
16.830/21.344/22.727/22.727 ms. Current response p95 is 7.655 ms sequential and
23.982 ms with retries; durable-receipt p95 is 4.947 and 10.441 ms, respectively.
All current runs retained a receipt and exactly one position-application marker.
The old retry workload closed the position in every round but lost its result
receipt in three of fifty rounds. Conditional old receipt timings therefore do
not demonstrate equivalent durability. This manual workload meets its local
100 ms p95 budget; it does not erase the failed 32-distinct-report budget above.
The first manual collector incorrectly assumed every baseline receipt existed;
its aborted run is retained, and the corrected collector explicitly counts missing
receipts instead of dropping failed baseline rounds.

Full median/p95/p99/max receipts and logs live in the task's
`arx-tier1-release/result-evidence-20261026` folder. The result benchmark writes
its receipt before failing a missed budget. The manual-recovery collector records
missing old RESULT receipts as incomplete coverage, separately from position
completion; it never equates an old acknowledgement with durable evidence.

Reproduce with the package scripts `test:result-evidence-postgres` and
`test:self-trade-management-postgres` in a scrubbed environment with
`ARX_TEST_PG_BIN` pointing at local PostgreSQL binaries. Their runners create,
verify and destroy unique Unix-socket-only clusters and do not inherit application
DB credentials. Timing is opt-in via `ARX_RESULT_BENCHMARK_OUTPUT` plus
`ARX_RESULT_BASELINE_ROOT`, or `ARX_MANUAL_RESULT_BENCHMARK_OUTPUT` plus
`ARX_MANUAL_RESULT_BASELINE_ROOT`; baseline source is hash-checked against 8042af50.
The result suite is registered in the existing integration lane, while the actual
route acknowledgement tests are part of `test:execution-epistemology`. Registration
is not evidence that an external CI job executed them.

## Review branch scope and benchmark qualification

This review is stacked on PR #93 at `319b3dfbf29b11955de2f4df7139a0014a4d5d82`. Production and test files are byte-identical to frozen development checkpoint `644182385862398a1f6209b46161b6c952d9f3d1`; only package/CI registration differs to retain this smaller base. Fresh review checks pass 16 concurrent-result PostgreSQL cases, 79 management/recovery PostgreSQL cases, 73 entry PostgreSQL cases and 56 focused route/epistemology/reconciler cases, all four type-check units, 87 guards and the API production build. The first entry test attempt stopped before any assertions because its temporary database did not start. Its log is retained; the runner removed the detailed server log, so the exact startup cause is unknown. The unchanged suite passed when repeated alone.

The original broader 136-case group, 46 guard fixtures, manual and report timing measurements above belong to the development checkpoint and are not claimed as newly executed on this review branch. Original runtime identity supports reuse of those scoped observations, not performance claims for unrelated code. Subsequent profiling found a pool-layout asymmetry in the original old/current report comparison: the old handler used its own ten-slot pool while the current handler shared its pool with the completion witness. The measured current 126.176 ms completion failure remains valid and retained, but old/current deltas are not a controlled pool-equivalent speed comparison. A separate scheduling experiment is preparing a new paired baseline/candidate measurement with explicit database and pool identity checks; it is not part of this review.
