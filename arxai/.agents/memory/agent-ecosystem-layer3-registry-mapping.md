---
name: Agent Ecosystem Layer 3 registry→engine mapping gap
description: The agents registry lacks several ecosystem-health signals the Layer 3 engines expect; derive what you can, default the rest honestly.
---

The Layer 3 orchestration/health engines (immune, family, speed, factory
population) consume richer per-agent snapshots than the `agents` registry table
persists. When wiring them at the api-server service boundary:

- **Derive** from existing links/columns where possible:
  - `childCount` = count of rows whose `parentAgentId` == this agent's `id`.
  - `parentAgentKey` = resolve `parentAgentId` → `agentKey` via an id→key map.
  - `speedCostScore` proxy = `100 - speedScore` (high speedScore ⇒ low cost).
- **Default honestly** for signals the registry does not store yet:
  `duplicateAnalysisRate`, `falseApprovalRate`, `falseBlockRate` → 0 / omitted.
  The engines treat an absent signal as "no anomaly", so defaulting to 0 is
  fail-open for *detection* (it under-flags, never over-flags) — acceptable
  because Layer 3 is advisory/shadow only and never gates execution.

**Why:** a downstream task adding real persisted health columns should replace
these proxies/defaults, not assume they were already exact. Don't trust
`speedCostScore`/`duplicateAnalysisRate` from a Layer 3 read as ground truth.

**Immune anomaly nuance:** `DUPLICATE_AGENT` fires only on ≥2 agents sharing a
normalized name; a single agent with a high `duplicateAnalysisRate` is
`GENERIC_REPETITION`, not `DUPLICATE_AGENT`. Test/expect them separately.
