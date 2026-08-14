---
name: Fund Book capital-movement lifecycle enforcement
description: Why capital-movement requests must funnel every status change through a pure state machine, and how settlement phases are represented.
---

Capital-movement requests (deposits/withdrawals) MUST enforce the spec lifecycle
`DRAFT → SUBMITTED → PENDING_REVIEW → APPROVED → PROCESSING → SETTLED → COMPLETED`
(+ terminal `REJECTED`/`FAILED`/`CANCELLED`). The schema enum and the task DoD
both define all states — they are in scope, not optional.

**Rule:** every status mutation routes through the pure `requestLifecycle.ts`
state machine (`assertTransition`/`canTransition`). No handler may hardcode a
target status or do a loose `if status === X` check that lets a terminal row
move (e.g. CANCELLED → REJECTED, or APPROVED → COMPLETED skipping settlement).

**Why:** the first implementation created requests directly at PENDING_REVIEW
(skipping SUBMITTED), jumped APPROVED → COMPLETED in settle (no PROCESSING/
SETTLED), and `rejectRequest` only blocked COMPLETED/SETTLED — which let an
already-CANCELLED/FAILED row be flipped to REJECTED, corrupting the audit trail.
Code review rejected the task for this.

**How to apply:**
- Creation persists SUBMITTED then advances to PENDING_REVIEW via the validated
  transition (`advanceToPendingReview`). Observable created state is still
  PENDING_REVIEW so existing callers/tests are unaffected.
- Settlement is ONE atomic DB transaction but writes status PROCESSING → SETTLED
  → COMPLETED with a distinct audited admin action per phase
  (`*_PROCESSING`, `*_SETTLED`, then the original `*_SETTLE` for COMPLETED). The
  atomic tx is the safer design (no partial unit issuance); the audit log is the
  durable phase-by-phase record. Keep the final COMPLETED audit action name
  unchanged (`FUNDBOOK_CAPITAL_DEPOSIT_SETTLE` / `_WITHDRAWAL_SETTLE`) so the
  "exactly one settle audit row" test assertion stays valid.
- Mid-settlement (PROCESSING) is intentionally non-cancellable / non-rejectable.
