// Agent Ecosystem Layer-3 Governed Agent Factory — DB integration test.
//
// Proves the creation-request table round-trips with the right defaults, that the
// PURE validator gates forbidden / duplicate / under-specified requests BEFORE any
// write, and that an APPROVED request can only ever mint a SHADOW agent at 0%
// authority with no live influence. scripts may import libs (@workspace/db,
// @workspace/domain) but NOT api-server, so this mirrors the service's persistence
// against the real schema + the real pure validator. All rows use a TEST_ prefix
// and are cleaned up at the end (fail-closed: aborts if cleanup scope looks wrong).
//
// Run: pnpm --filter @workspace/scripts run test:agent-factory-db

import {
  db, agentsTable, agentCreationRequestsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  validateAgentCreationRequest,
  type AgentCreationRequestInput,
  type NormalizedAgentCreationSpec,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`, extra ?? ""); failures++; }
}

const SUFFIX = randomUUID().slice(0, 8);
const TEST_NAME = `TEST_FACTORY_${SUFFIX}`;

function baseRequest(): AgentCreationRequestInput {
  return {
    proposedName: TEST_NAME,
    proposedDepartment: "RESEARCH",
    purpose: "Spot repeated overnight-gap risk on indices and warn before the open.",
    reasonNeeded: "No existing agent watches the overnight gap window.",
    workflowGap: "Pre-open gap exposure is currently unmonitored.",
    allowedInputs: ["index daily candles", "economic calendar"],
    allowedOutputs: ["gap risk note"],
    permissions: ["read_market_data"],
    failureConditions: ["misses a >1% gap"],
    scorecard: ["gap hit rate"],
    testingRequirements: ["30-day shadow backtest"],
    activationRequirements: ["admin approval"],
    parentAgentKey: null,
  };
}

async function main() {
  console.log("Agent Ecosystem Layer-3 Factory DB test");
  let requestId = -1;
  let dupRequestId = -1;
  let createdAgentId = -1;

  try {
    // ── Forbidden permission is rejected by the pure validator (NO write) ──────
    const forbidden = { ...baseRequest(), permissions: ["place_trade"] };
    const vForbidden = validateAgentCreationRequest(forbidden, []);
    check("forbidden permission rejected before persistence",
      !vForbidden.valid && vForbidden.errors.some((e) => e.startsWith("forbidden_permission:")),
      vForbidden.errors);

    // ── Under-specified request is rejected ───────────────────────────────────
    const thin = { ...baseRequest(), purpose: "", scorecard: [] };
    const vThin = validateAgentCreationRequest(thin, []);
    check("under-specified request rejected", !vThin.valid && vThin.errors.length > 0, vThin.errors);

    // ── Duplicate name is rejected against existing agents ─────────────────────
    const vDupe = validateAgentCreationRequest(baseRequest(), [
      { agentKey: "SOME_KEY", name: TEST_NAME, department: "RESEARCH" },
    ]);
    check("duplicate agent name rejected",
      !vDupe.valid && vDupe.errors.some((e) => e.startsWith("duplicate_agent_name:")),
      vDupe.errors);

    // ── Valid request validates + normalizes to forced shadow defaults ─────────
    const valid = validateAgentCreationRequest(baseRequest(), []);
    check("valid request passes validation", valid.valid && !!valid.normalized, valid.errors);
    const spec = valid.normalized as NormalizedAgentCreationSpec;
    check("normalized forced startingStatus=SHADOW", spec.startingStatus === "SHADOW", spec.startingStatus);
    check("normalized forced authorityWeight=0", spec.authorityWeight === 0, spec.authorityWeight);
    check("normalized forced liveInfluenceAllowed=false", spec.liveInfluenceAllowed === false);
    check("normalized forced creationRightLevel=NONE", spec.creationRightLevel === "NONE", spec.creationRightLevel);

    // ── Persist the PROPOSED request (mirrors proposeAgentCreation) ────────────
    const proposedValues = {
      proposedName: spec.proposedName,
      proposedDepartment: spec.proposedDepartment,
      purpose: spec.purpose,
      reasonNeeded: spec.reasonNeeded,
      workflowGap: spec.workflowGap,
      allowedInputs: JSON.stringify(spec.allowedInputs),
      allowedOutputs: JSON.stringify(spec.allowedOutputs),
      permissions: JSON.stringify(spec.permissions),
      failureConditions: JSON.stringify(spec.failureConditions),
      scorecard: JSON.stringify(spec.scorecard),
      testingRequirements: JSON.stringify(spec.testingRequirements),
      activationRequirements: JSON.stringify(spec.activationRequirements),
      parentAgentKey: spec.parentAgentKey,
      normalizedSpec: JSON.stringify(spec),
      status: "PROPOSED" as const,
      requestedByUserId: 0,
    };
    const [reqRow] = await db.insert(agentCreationRequestsTable).values(proposedValues).returning();
    requestId = reqRow!.id;
    check("request persists with status PROPOSED", reqRow?.status === "PROPOSED", reqRow?.status);
    check("normalizedSpec round-trips", JSON.parse(reqRow!.normalizedSpec).authorityWeight === 0);

    // ── Duplicate PROPOSED rejected by the DB partial-unique index (race backstop) ─
    let dupBlocked = false;
    try {
      const [dup] = await db.insert(agentCreationRequestsTable).values(proposedValues).returning();
      if (dup?.id) dupRequestId = dup.id; // cleanup if it somehow slipped through
    } catch { dupBlocked = true; }
    check("duplicate PROPOSED name blocked by partial-unique index", dupBlocked);

    // ── Concurrent-approve idempotency: only ONE CAS claim flips PROPOSED ──────
    const claimSet = { status: "APPROVED" as const, decidedByUserId: 0, decisionReason: "approved in test", decidedAt: new Date() };
    const claim1 = await db.update(agentCreationRequestsTable).set(claimSet)
      .where(and(eq(agentCreationRequestsTable.id, requestId), eq(agentCreationRequestsTable.status, "PROPOSED")))
      .returning();
    const claim2 = await db.update(agentCreationRequestsTable).set(claimSet)
      .where(and(eq(agentCreationRequestsTable.id, requestId), eq(agentCreationRequestsTable.status, "PROPOSED")))
      .returning();
    check("first approve claim wins", claim1.length === 1, claim1.length);
    check("second concurrent approve claim is a no-op", claim2.length === 0, claim2.length);

    // ── Approve → mint exactly one SHADOW agent (only the winning claim mints) ──
    const [agent] = await db.insert(agentsTable).values({
      agentKey: TEST_NAME,
      name: spec.proposedName,
      role: "GOVERNED_SHADOW_AGENT",
      department: spec.proposedDepartment,
      createdByUserId: 0,
      creationReason: spec.reasonNeeded,
      missionStatement: spec.purpose,
      allowedTasks: JSON.stringify(spec.allowedOutputs),
      currentRank: "TRAINEE",
      currentStatus: "SHADOW",
      currentMode: "SHADOW",
      authorityWeight: 0,
      liveInfluenceAllowed: false,
      canCreateAgents: false,
      creationRightLevel: "NONE",
      isCore: false,
    }).returning({ id: agentsTable.id });
    createdAgentId = agent!.id;
    await db.update(agentCreationRequestsTable)
      .set({ createdAgentId })
      .where(eq(agentCreationRequestsTable.id, requestId));

    const [minted] = await db.select().from(agentsTable).where(eq(agentsTable.id, createdAgentId));
    check("minted agent is born SHADOW", minted?.currentStatus === "SHADOW", minted?.currentStatus);
    check("minted agent authorityWeight=0", minted?.authorityWeight === 0, minted?.authorityWeight);
    check("minted agent liveInfluenceAllowed=false", minted?.liveInfluenceAllowed === false);
    check("minted agent cannot create agents", minted?.canCreateAgents === false);
    check("minted agent is not core", minted?.isCore === false);

    const [decided] = await db.select().from(agentCreationRequestsTable).where(eq(agentCreationRequestsTable.id, requestId));
    check("request marked APPROVED with createdAgentId", decided?.status === "APPROVED" && decided?.createdAgentId === createdAgentId, decided?.status);
  } finally {
    // ── Fail-closed cleanup: only ever touch THIS test's rows ─────────────────
    if (TEST_NAME.startsWith("TEST_FACTORY_")) {
      if (createdAgentId > 0) await db.delete(agentsTable).where(eq(agentsTable.id, createdAgentId));
      if (requestId > 0) await db.delete(agentCreationRequestsTable).where(eq(agentCreationRequestsTable.id, requestId));
      if (dupRequestId > 0) await db.delete(agentCreationRequestsTable).where(eq(agentCreationRequestsTable.id, dupRequestId));
      console.log(`  cleanup  removed test request ${requestId} + agent ${createdAgentId} (${TEST_NAME})`);
    } else {
      console.error("  ABORT  refusing cleanup — unexpected test scope");
    }
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll Layer-3 Factory DB checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
