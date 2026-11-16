// Phase 3 — persisted governance trace table test. Proves that the durable
// `agent_governance_traces` proof rows actually persist via the fail-soft
// `persistGovernanceTrace` helper, that derived columns (allowed / blocked /
// stepped-back / risk-veto) are computed from the review, that
// `listPersistedGovernanceTraces` paginates newest-first, and the inviolable
// safety default `liveExecutionBlockedByAi = false` holds.
//
// DB-backed: writes a small batch of uniquely-tagged rows, asserts, then deletes
// only its own tagged rows (evidence rows are never bulk-deleted).
//
// Run: pnpm --filter @workspace/scripts run test:agent-governance-trace-persist
import { randomUUID } from "node:crypto";
import {
  persistGovernanceTrace,
  listPersistedGovernanceTraces,
} from "../../artifacts/api-server/src/lib/agentEcosystem/governance.js";
import { db, agentGovernanceTracesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { GovernanceReview } from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

// A representative review: RISK rejects (veto), one agent abstains (steps back).
function makeReview(): GovernanceReview {
  return {
    surface: "SCANNER",
    direction: "BUY",
    importance: "MEDIUM",
    outcome: "rejected",
    finalDecision: "Rejected (ranking only)",
    baseScore: 80,
    advisoryScore: 70,
    governanceScore: 40,
    scoreImpact: -40,
    confidenceScore: 55,
    positions: [
      { agentKey: "RISK", name: "Risk", department: "Risk", position: "rejection", weight: 0.9, reason: "risk too high" },
      { agentKey: "TREND", name: "Trend", department: "Signals", position: "support", weight: 0.6, reason: "clean trend" },
      { agentKey: "NEWS", name: "News", department: "Macro", position: "abstain", weight: 0, reason: "no standing" },
    ],
    challenges: [
      { byAgentKey: "RISK", byName: "Risk", byDepartment: "Risk", challengeType: "rejection", target: "entry", reason: "risk too high", weight: 0.9 },
    ],
    participatingAgentCount: 2,
    winningReasoning: "Risk veto prevailed",
    lifecycleRecommendations: [],
    traffic: { limited: true, consideredCount: 4, participatedCount: 2, reason: "medium_importance" },
    hasUntrustedResponsibleAgent: false,
    governanceApplied: true,
  };
}

async function main() {
  console.log("Agent governance trace persist test");

  // Unique tag so this run only ever sees and cleans up its own rows.
  const tag = `TEST_PERSIST_${randomUUID().slice(0, 8)}`;
  const review = makeReview();
  const considered = ["RISK", "TREND", "NEWS", "VOL"]; // VOL considered but not allowed
  const allowed = [{ agentKey: "RISK" }, { agentKey: "TREND" }, { agentKey: "NEWS" }];

  try {
    // 1. Persist a batch (more than one page-worth boundary is not needed; use 3).
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await persistGovernanceTrace({
        actionType: tag,
        surface: "SCANNER",
        symbol: `EURUSD${i}`,
        timeframe: "M15",
        review,
        participants: allowed,
        consideredKeys: considered,
      });
      check(`persist #${i} ok`, r.ok && typeof r.id === "number", JSON.stringify(r));
      if (r.id) ids.push(r.id);
    }
    check("all three persisted with ids", ids.length === 3);

    // 2. List by actionType — should return exactly our 3, newest-first.
    const rows = await listPersistedGovernanceTraces({ actionType: tag, limit: 50 });
    check("list returns the 3 tagged rows", rows.length === 3, `got ${rows.length}`);
    const createdDesc = rows.every((r, i) =>
      i === 0 || (rows[i - 1].createdAt ?? "") >= (r.createdAt ?? ""));
    check("rows are newest-first", createdDesc);

    // 3. Derived columns computed from the review.
    const sample = rows[0];
    check("activeMode defaulted from surface (SCANNER)", sample.activeMode === "SCANNER", sample.activeMode);
    check("riskVetoUsed derived true (RISK rejection)", sample.riskVetoUsed === true);
    check("finalGovernanceDecision persisted", sample.finalGovernanceDecision === "Rejected (ranking only)");
    const blocked = JSON.parse(sample.agentsBlocked) as string[];
    check("blocked set = considered − allowed (VOL)", blocked.length === 1 && blocked[0] === "VOL", JSON.stringify(blocked));
    const allowedCol = JSON.parse(sample.agentsAllowedToRun) as string[];
    check("allowed set is the 3 participants", allowedCol.length === 3);
    const stepped = JSON.parse(sample.agentsThatSteppedBack) as string[];
    check("stepped-back includes the abstaining NEWS agent", stepped.includes("NEWS"), JSON.stringify(stepped));
    check("INVIOLABLE: liveExecutionBlockedByAi default false", sample.liveExecutionBlockedByAi === false);

    // 4. Pagination: limit 2 then offset 2 should split the 3 rows 2 + 1.
    const page1 = await listPersistedGovernanceTraces({ actionType: tag, limit: 2, offset: 0 });
    const page2 = await listPersistedGovernanceTraces({ actionType: tag, limit: 2, offset: 2 });
    check("page1 has 2 rows", page1.length === 2, `got ${page1.length}`);
    check("page2 has the remaining 1 row", page2.length === 1, `got ${page2.length}`);
    const overlap = page1.some((a) => page2.some((b) => a.id === b.id));
    check("pages do not overlap", !overlap);
  } finally {
    // Clean up ONLY our own tagged rows.
    await db.delete(agentGovernanceTracesTable).where(eq(agentGovernanceTracesTable.actionType, tag));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll governance trace persist checks passed.");
  process.exit(0);
}

void main();
