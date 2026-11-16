# Safety-mode and audit continuation — 28 October 2026

Base: PR #100, `6b77a93fe83735bbeca667d3970a69c9a6810628`, on PR #99.
Development only. This document is not release approval or a completion claim.

## Owner decision

The owner approved the safety-mode and audit fixes and explicitly required:

> Keep AI-generated entries blocked until I provide an approved confidence policy. Don’t invent a score scale, threshold, calibration standard, or expiry. Keep the separate gates for manual entries and protective exits unchanged.

`AI_ENTRY_POLICY_PENDING` is an unconditional hold for known Ruby, automation
and strategy OPEN intents in the runtime Risk Governor. There is no numeric
threshold, expiry, calibration claim or environment-variable bypass. A known
paper AI decision cannot be relabelled manual/api/system. A persisted live
self-trade decision remains automation at final dispatch regardless of its
surface label. Existing AI actor labels are preserved in the audit.

Manual OPEN intents retain their existing geometry, ownership, authorization
and risk checks. CLOSE, PARTIAL_CLOSE and MODIFY do not acquire an AI-confidence
gate. This does not classify every manually re-entered idea as AI-generated,
and the pure shadow simulator preview is not execution permission.

## Paper entries and evidence

- An entry requires exactly one readable Safety Core row, a released Safety
  Core kill switch, an executable mode (PAPER_TRADING or LIVE_TRADING), and
  a trading state accepted by the existing Safety Core tradeGate policy.
  OBSERVE_ONLY, SUGGEST_ONLY, shutdown, recovery, degraded, missing and
  ambiguous states hold new entries. Existing risk governors still apply.
- The runtime Risk Governor applies that policy even when a caller supplies
  quote/account facts. The final paper booking rechecks inside its transaction.
  A shared table lock excludes a concurrent mode change, deletion or extra
  Safety Core row until the booking commits. Lock wait is bounded to 3 seconds,
  individual statements to 5 seconds; this is not an end-to-end latency bound.
- A governed decision's risk event, vault event and chained audit event commit
  together. Caller audit context cannot replace the authoritative source,
  intent or rule results. Audit failure denies an otherwise allowed trade.
- Global `/audit/*` and `/system/vault` readers/integrity tools are operator-only;
  they contain records from multiple traders. Regular users keep their own
  `/me/risk/events` view. A two-user HTTP regression proves denial of global
  reads/replay/debug mutations while operator queries and own-risk queries work.
- A paper order, its placement event (when requested), vault record and audit
  record commit together. Both stores carry owner, order and decision links.
  Existing `(user, clientRequestKey)` uniqueness resolves concurrent booking
  retries; a replay returns the existing order without another placement trail.
- Paper modifications, closes, settlements and cancellations also record their
  outcome in the same transaction. A failed outcome audit rolls back that
  mutation and returns an error; the paper order does not falsely appear closed.
  There is no new AI/mode gate on these protective operations. Cancellation
  now has an explicit paper event and cannot overwrite a concurrently closed
  order. Broker-side stops and manual broker controls are unaffected.

Mandatory writes and best-effort shadow diagnostics share a PostgreSQL
transaction-level advisory lock before sealing the next audit event. This
prevents concurrent writers using this path from forking the chain. Legacy raw
inserts in `routes/auth.ts` and `routes/adminBetaControl.ts` do not yet use this
lock or previous-event linkage; whole-table integrity is therefore still an
open gap. This change does not repair historical chain forks.
Privacy/quality processing runs once per write; the
existing failure stub and compression/redaction metadata are retained.

The atomicity and lock choices follow PostgreSQL's
[transaction](https://www.postgresql.org/docs/current/tutorial-transactions.html)
and [locking](https://www.postgresql.org/docs/current/explicit-locking.html)
semantics. Serialized audit writes and the short paper booking lock may add
contention; no scanner or trade latency improvement is claimed here.

## Verification contract

`tests/paper-entry-policy.test.mjs` runs only in the disposable isolated API lane.
It covers mode/state holds, ambiguous state, final-check races (including a
concurrent singleton insert), linked evidence, injected write failures,
protective outcomes, AI provenance, keyed retries and concurrent audit chains.
The initial 11 regressions all failed against unchanged base `6b77a93`.
Later additions have separate passing receipts; they are not claimed as part
of that original red run.

Existing paper-book/simulated-open fixtures now explicitly select executable
Safety Core state. Successful book mechanics use manual entries; automation
has a separate refusal test that retains sizing and daily-loss assertions.
The legacy RG-1b test asserts the approved pending-policy refusal, not an
invented numerical confidence floor. The retired endpoint still returns 410.

Final checks must name the exact commit. Working-tree receipts, prior
`6f9e364` checks and this branch's checks are not interchangeable. Retain
failures and skipped checks. The full root CI, wider integration/frontend
matrix, quiet browser performance and independent review of the combined
PR #99/#100/#101 source are required before any release-green claim.

## Open items

- Owner-approved confidence policy remains undefined; AI entries stay disabled.
- Approved LIVE execution outcomes and broker evidence remain untested. The
  audit of a governor allowance is not proof that a broker filled an order.
- Governed protective decisions also require their new vault/audit mirrors to
  persist. Their policy eligibility is unchanged, but a storage failure can
  refuse the action; this is a durability dependency, not an AI-confidence gate.
- MT5 MetaEditor compile remains a separate check. EAs/includes are unchanged
  from `6f9e364` and `cd44c73`. The Mac compile preflight on this continuation
  stopped because terminal64.exe was running; no compile result was produced.
- The handoff's scanner latency, Smart Chart browser acceptance, Truth round-3
  integration, Profit Mission validation and TradingView/MT5 comparison gaps
  remain. Held performance experiments are excluded.
- No main merge, deployment, existing database migration, worker/trading enable,
  email or broker operation was performed by this continuation.
