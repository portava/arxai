---
name: Governed Factory request dedupe + at-most-once approval
description: How agent-creation requests are de-duplicated before write and how approval mints a shadow agent at most once under concurrency.
---

# Factory creation-request dedupe + CAS approval

The pure validator (`validateAgentCreationRequest`) only dedupes a proposed name
against EXISTING agents — it cannot see other PROPOSED requests. So request-level
dedupe and approval atomicity must live in the persistence service, not the engine.

**Rule:** duplicate-pending prevention needs BOTH layers — a service-level
precheck (read PROPOSED rows, normalize name, reject `duplicate_pending_request`
before insert) AND a DB partial-unique index on `lower(proposed_name) WHERE
status='PROPOSED'`. The precheck gives a clean UX; the index is the race backstop.
Map a Postgres `23505` on insert back to the same `duplicate_pending_request`
response so the race window stays deterministic.

**Rule:** approval must mint at most once. Wrap the decision in a transaction and
claim the row with a CAS update (`UPDATE ... SET status WHERE id=? AND
status='PROPOSED' RETURNING`); rowcount 0 ⇒ `REQUEST_NOT_PROPOSED`. Mint the
shadow agent only after winning the claim, inside the same transaction, so a
corrupt/failed mint rolls back the claim. (Same exactly-once CAS family as the
live-command terminal-write guard.)

**Why:** two concurrent approves both read PROPOSED and both mint without the CAS;
two concurrent proposals both pass the read and both insert without the index.

**How to apply:** any future "request → admin-approves → creates a thing" table in
this repo (Factory-style) should reuse both patterns. A re-proposable name is
fine once the prior request is APPROVED/REJECTED (the partial index is scoped to
PROPOSED only), and an approved name is then blocked by the validator's
existing-agent dedupe.
