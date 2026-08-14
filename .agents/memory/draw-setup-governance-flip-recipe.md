---
name: Draw-setup governance-flip test recipe
description: How to make POST /api/me/assistant/draw-setup flip verdict in an e2e test by tuning the live scanner signal, without seeding synthetic agents.
---

# Flipping the draw-setup verdict from a live scanner signal (test recipe)

To prove a live scanner signal CHANGES Ruby's drawn setup over real HTTP
`POST /api/me/assistant/draw-setup`, inject ONLY the assistant market-provider
seam (`_setMarketProviderForTests`) — do NOT seed a synthetic governance agent.

**Why:** the 14 core agents are auto-seeded on boot (`seedCoreAgents`, upsert).
The real ACTIVE core RISK agent (dept RISK) is what drives the verdict: it reads
`safety = 1 - riskScore/100` and, via the advisory → Traffic → Court flow,
requests an outcome based on the live scanner's `riskScore`:
- `riskScore` in **[70, 85)** → Court outcome `"downgraded"` → verdict **caution**
- `riskScore` **≥ 85** → outcome `"rejected"` → verdict **avoid**

Seeding a synthetic high-authority agent (the original draft approach) is both
unnecessary and produced rejection/avoid because the real RISK agent already
escalates at riskScore=100. No-seed is cleaner and more honest.

**How to apply:**
- Control = provider with EMPTY candles → no scanner candidate → scannerScore /
  riskScore / governanceOutcome all honestly null → clean chart draws tradeable.
- Treatment = SAME provider with a deterministic choppy window + a moderate
  spread. `liveScanner.scoreCandles` computes `riskScore = clamp(20 +
  spreadPenalty + choppy30)`. A 0.0003 spread (bid 1.10045 / ask 1.10075) →
  spreadPenalty ~27 → riskScore ~77 (downgrade band); scannerScore ~36.
- Keep scannerScore in (34, 60) so non-RISK specialists stay NEUTRAL (abstain,
  weight 0) and don't trigger conflict→escalated. Only RISK participates.
- Verify rows added: assert no DELTA on arx_live_commands / mt5_commands
  (baseline-delta, never ==0 — they're persistent audit tables).

Test: `scripts/src/rubyDrawSetupRouteTest.ts` (block 3).
