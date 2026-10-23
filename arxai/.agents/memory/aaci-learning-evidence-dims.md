---
name: AACI learning evidence dimensions
description: Which entity dims AACI trust may learn/consume, and why strategy is ingested but not consumed.
---

# AACI per-entity trust — evidence dimensions

AACI Bayesian trust may only learn a dimension that has REAL per-trade evidence.
Source of truth is a CLOSED `self_trade_agent_executions` row (real `realizedPnl`)
joined to its `self_trade_decisions` row.

**Ingestable dims (have per-trade evidence):**
- `agent`, `symbol` — direct columns on the execution.
- `strategy` — the decision's `setupType` (nullable; push only when non-blank).
- `timeframe` — the decision's `timeframe` (NOT NULL).

**Never ingested (NO per-trade evidence column):** `module`, `signal`, `session`.
They stay at the neutral 0.50 prior. **Why:** writing trust for a dim with no
real evidence would fabricate — forbidden. Don't "complete the set" by adding them.

## Decision consumption (`decisionService`)
Consumes `symbol` + `timeframe` + `agent` (only when actor is `self_trade_agent`)
via most-cautious reduce: `min` trust, `min` drift, `OR` excluded. Caution can
only go UP, never relax.

**Strategy trust is ingested but deliberately NOT consumed at decision time.**
**Why:** the stored strategy key is the `setupType` classifier vocabulary, but the
decision input strategy is `AaciStrategyKind` (e.g. `m5_pullback`). They are
different vocabularies, so reading strategy trust here would be dead/misaligned
wiring (silent false misses). Keep it excluded until a canonical
`setupType ↔ AaciStrategyKind` mapping is formally defined + tested.

**How to apply:** if asked to "also learn/consume module/signal/session" or to
"wire strategy into decisions," push back unless real per-trade evidence (or a
formal vocabulary mapping) exists first.
