# Replit command — R2: execution epistemology (UNKNOWN state, ack/fill, reconciliation gate)

**Prerequisite:** R1 merged. **Risk class:** live-execution architecture — owner reviews the plan, Claude Code implements on a branch, owner presses the merge.

Give Claude Code in the Replit shell this instruction, together with `audit-reports/audit-execution.md` from this delivery (the binding slice plan lives there — 8 dependency-ordered slices S0–S7 with 21 red-fail tests, file:line-grounded):

---

Implement the execution-epistemology series from `audit-execution.md` on branch `feat/execution-epistemology`, one slice per commit, in order:

- **S0** Canonical status enum: introduce the spec's `execution_order_state` vocabulary as a mapping layer over the three existing free-text status columns (`arx_live_commands`, `mt5_demo_commands`, `mt5_commands`) — no data migration, mapping functions + tests first.
- **S1** UNKNOWN semantics (the core fix): a picked-up live command whose result never arrives must become `UNKNOWN`, not terminal `LIVE_EXPIRED`. The TTL sweep may only terminalize rows the EA never picked up (`pickedByEaAt` null). Ambiguous success-without-ticket becomes `UNKNOWN`, never `LIVE_FAILED`, and must NOT release the master exposure reservation.
- **S2** Append-only `execution_events` table with `unique(command_id, sequence_no)`; every transition writes an event; late/out-of-order broker results are RETAINED as events instead of dropped.
- **S3** Urgent reconciler: an `UNKNOWN` command triggers a position-snapshot comparison against broker truth (heartbeat/positions sync already exists) and only reconciliation resolves `UNKNOWN → FILLED/FAILED`.
- **S4** Persisted `reconciliation_runs` + a reconciliation-freshness pre-gate in `dispatchLiveCommand` (mismatch ⇒ block new entries; close/reduce still allowed).
- **S5** Acknowledged-vs-filled separation and partial-fill exposure updates (stop mapping partial→completed in `executionReconciler.ts`).
- **S6** Durable idempotency: intent-level idempotency key (not minute-bucketed) whose partial unique index INCLUDES `UNKNOWN` so unknown outcomes block duplicate submission.
- **S7** Adapter seam: extract the EA mailbox mirror behind an interface so future broker adapters reuse the same state machine.

Binding rules: the pure 18-gate evaluator (`livePhaseBDispatchGate.ts`) is untouched except where the audit plan explicitly adds inputs; every slice lands with its red-fail test proven red before the fix and green after; `pnpm run ci` green between slices; no schema drops; append-only tables get no UPDATE/DELETE paths.

---

**Hold point:** after S4, stop and report to the owner before S5–S7 (S1–S4 close the dangerous holes; S5–S7 are correctness/debt).
