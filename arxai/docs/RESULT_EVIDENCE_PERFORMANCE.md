# Bounded concurrent result processing

Base: `64418238`. The prior durability/recovery checkpoint remains frozen.
This follow-up is server-only; no terminal, broker or strategy performance claim.

## Evidence and acceptance

The prior corrected-fixture 32-report completion p95 was **126.176 ms**, exceeding
the fixed 100 ms local target. That sample and its earlier 114.935 ms failure are
retained. The previous baseline ran in its own pool while the witness used the
current pool; that asymmetry affects relative comparisons, but does not erase the
current standalone failure. New paired comparisons explicitly use the same real
PostgreSQL pool/DB/schema for both versions and the same receipt witness.

A diagnostic run uses the same 32 distinct reports, three warmups and thirty rounds,
with per-request query/pool instrumentation and an extra `pg_stat_activity`
observer. The original pooled receipt witness remains. Query timings include
client/driver/network/execution and lock waits; instrumentation is not the
acceptance benchmark. Baseline median/p95 pool acquisition was 25.104/68.764 ms,
and command-lock query time was 24.711/34.330 ms. Tuple and transaction-ID waits
dominated sampled waits. The security-chain advisory-lock query was 0.042/0.078 ms.
All 960 reports remained durable. Instrumented completion p95/max 143.233/274.052 ms
are retained, not presented as uninstrumented performance.

The node-postgres pool queues acquisition when its configured clients are occupied;
waiting requests should not needlessly occupy all those clients on the same row.
PostgreSQL's row/advisory locks still serialize authoritative state across processes.
Statistics sampling has overhead and reports current wait state, not a complete
causal trace. [node-postgres pool](https://node-postgres.com/apis/pool),
[PostgreSQL statistics](https://www.postgresql.org/docs/current/monitoring-stats.html),
[PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Acceptance remains: every recognized admitted report has its own locked transaction,
unchanged hash-chain algorithm and durable receipt; exact retries are idempotent;
contradictions are retained. Rollback and cross-process concurrency retain those
properties. No database result/outcome/evidence is cached in memory. All original
five workloads, round counts and 100 ms p95 criterion remain. A sixth mixed-key
workload measures independent commands alongside 32 reports for a hot command.
Manual-close completion stays separately measured after post-commit settlement.

## Scheduling and compatibility

An in-process queue keyed by owner plus command delays pool acquisition for a
command already processing a result. Each admitted report still executes the
unchanged transaction, rechecks owner/bridge/state under the command lock, and
performs its own event/audit/hash-chain writes. The queue releases only when that
transaction resolves or rejects, before post-commit position/accounting work.
It never groups reports into a shared success, drops a contradiction, skips a DB
lock, or treats memory admission as a durable receipt.

Limits include active and pending reports: 64 per owner/command, 512 total,
512 KiB of serialized recognized evidence per key, 8 MiB total. Command identity
is included in the weight; map keys are fixed-size SHA-256 values. These are input
byte/count limits, not an assertion of exact JavaScript heap size. Limits are per
server process. Finally blocks release counts/bytes/map entries on success or
failure; a failed request does not poison followers. There is no time expiry that
could release an unknown active database transaction early.

A full queue refuses the new request before its transaction with
`receiptPersisted:false` and `LIVE_RESULT_RECEIPT_CAPACITY`. Both result routes
return 503 for this refusal. No admitted receipt or broker execution is claimed.
EA154 still has no persistent result outbox: an overload 503 can therefore require
reconciliation rather than automatic terminal retry. This bounded scheduling layer
is not a durable job queue, cluster-wide load controller, terminal delivery fix or
replacement for the existing accounting holds.

Independent owners/commands proceed while one key is held. Separate server processes
have separate local queues and still meet at the same PostgreSQL locks. Unit cases
cover limits, failure cleanup and independence; actual PostgreSQL cases cover
64 admitted+one refused report, blocked-key fairness, cancellation with a queued
follower, and two independent server subprocesses retaining 24 distinct reports.
Existing manual-close/accounting/authority regressions remain required.

## Paired local result

The frozen and candidate handlers share the same actual ten-client pool and DB
object (identity assertions saved in both receipts); no query, lock, transaction,
commit or security-chain writer is mocked. Three warmups and alternating execution
order are retained. The original five workloads remain unchanged; the mixed-key
workload is additional. All outliers are included.

| Measured work | Frozen p95 | Candidate p95 | Meaning |
| --- | ---: | ---: | --- |
| 32 distinct reports, all receipts observed | 78.104 ms | 82.475 ms | Both pass 100 ms; no same-key p95 speedup demonstrated |
| Independent command responses during 32 hot-key reports | 64.132 ms | 10.760 ms | Pool isolation improves fairness |
| Mixed 32+4 reports, all receipts observed | 77.143 ms | 84.767 ms | Completion p95 passes; candidate maximum 103.977 ms retained |
| Manual full close, position completion | 9.705 ms | 10.570 ms | Small sequential regression retained |
| Eight identical manual-close retries, position completion | 19.888 ms | 8.743 ms | Post-commit settlement finishes earlier |
| Eight manual-close retry handler responses | 23.451 ms | 19.629 ms | Full handler timing, not early receipt acknowledgement |

Candidate 32-report completion median/p95/p99/max is
68.657/82.475/83.944/83.944 ms; frozen is 70.627/78.104/78.173/78.173 ms.
Mixed-key independent-response median/p95/p99/max changes from
58.143/64.132/66.924/68.594 to 6.363/10.760/12.857/13.493 ms.
Manual retry position-completion median/p95/p99/max changes from
13.878/19.888/31.491/31.491 to 7.192/8.743/10.360/10.360 ms.
All reports in both new versions remain durable, all chain links verify, and every
manual round retains exactly one position application. Report and manual benchmark
receipts meet the fixed 100 ms p95 criterion in this run. The earlier 126.176 ms
failure remains valid evidence; because the frozen version also passes the new
paired run, no causal claim that scheduling alone removed that earlier miss is made.
These are controlled local samples, not a sustained production latency guarantee.

Receipts: `arx-tier1-release/result-evidence-20261026/profile-before.json`,
`scheduler-paired-benchmark.json` and `scheduler-manual-paired-benchmark.json`.
The phase profiler is opt-in via `ARX_RESULT_PROFILE_OUTPUT`; the same disposable
runner enforces its isolated Unix-socket database before executing it. The paired
benchmark accepts only source hashes pinned to 8042af50 or 64418238; this comparison
uses 64418238. No obsolete baseline receipt is overwritten.

Final checks: 20 actual PostgreSQL result/scheduling cases, 79 management/recovery
cases, 73 entry/accounting-authority cases, 144 focused lifecycle/integrity/route
cases, 87 architecture guards, API typechecking and the production API build pass.
Independent source review found no blocking issue in limits/cleanup, receipt commit
boundaries or transport refusals; it did not claim additional stress testing.

The candidate phase-profiler hook was also executed successfully. Its diagnostic
shows local scheduling wait while pooled acquisition and the command-lock query
are short; no tuple/transaction-ID wait was sampled in that run. It began while
two short unrelated correctness/type checks were finishing, so the receipt explicitly
records possible CPU overlap. That diagnostic is not a quiet before/after timing
comparison and is not used for the 100 ms acceptance result.
