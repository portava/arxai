// F-build — mission driver worker (the composition loop) proven end to end
// against a real database. The injected executor/simulated-executor/scan seams
// are SPIES standing in for the real router/scanner so the test can observe
// exactly what the driver hands off without placing an order or needing market
// data; production passes no seams and always uses the real services.
//
// Proven here:
//   * Timeframe expiry fires WITHOUT any user press: a running mission past
//     its timeframeEnd is transitioned to `expired` + journaled, and nothing
//     is dispatched.
//   * Level 2 (default) is NEVER auto-advanced into a trade: the driver holds,
//     journals the block honestly, and no executor is ever called.
//   * A level-3 (demo-auto) mission with earned promotion evidence is advanced
//     scan → auto-approve → dispatch through the SAME gated hook, landing on
//     the SIMULATED executor (never the live one), flipping the draft to
//     executed with a `sim:` command id and the auto-approval journaled.
//   * Gate-block handling: a live-auto-level mission missing its explicit
//     live-auto enablement is held with honest reasons; no dispatch happens.
//   * Draft→fill linkage: a LIVE dispatch persists the executor's commandId
//     onto the draft row (the seam the exit manager + close hook match on).
//   * Emergency stop enforcement: a user-emergency signal pauses the mission
//     with no page open.
//
// Imports @workspace/db at module init, so this lives in the DB-backed
// integration lane (runIntegrationCiTests.ts), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-driver-worker

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionProposalsTable,
  missionAgentsTable,
  missionEventsTable,
  missionSnapshotsTable,
  missionTestResultsTable,
  oneClickAuditTable,
  paperTradesTable,
} from "@workspace/db";
import { runMissionDriverPass } from "../missionDriver.js";
import type { MissionExecutor, MissionSimulatedExecutor } from "../missionExecution.js";
import type { InstantTradeIntent, InstantTradeResult } from "../live/instantTrade.js";
import type { Phase7Evaluator, Phase7Verdict } from "../missionExecutionQuality.js";
import {
  computeExecutionQuality,
  computeNetProfitVerdict,
  evaluateExposure,
  computeCapitalEfficiency,
  composeExecutionHealthGate,
} from "@workspace/domain/profit-mission";

// A real all-clear Phase 7 verdict (mirrors missionExecutionRoute.test.ts): the
// REAL evaluator fails CLOSED when broker/feed signals are absent — correct in
// production, but it would mask the driver assertions below. Phase 7 blocking
// itself is proven in the dedicated execution-route suite.
function passingPhase7Verdict(): Phase7Verdict {
  const executionQuality = computeExecutionQuality({
    isScalp: false,
    direction: "BUY",
    quoteFreshness: "fresh",
    spreadPips: 1,
    expectedMovePips: 50,
  });
  const netProfit = computeNetProfitVerdict({
    isScalp: false,
    assetClass: "forex_major",
    targetProfit: 300,
    spreadCost: 2,
    estimatedSlippageCost: 1,
    commission: 1,
  });
  const exposure = evaluateExposure({
    open: [],
    proposed: {
      symbol: "EURUSD",
      assetClass: "forex_major",
      currencies: ["EUR", "USD"],
      direction: "BUY",
      riskAmount: 50,
    },
    budget: { maxSameSymbolExposure: 5, maxCorrelatedExposure: 10 },
  });
  const capitalEfficiency = computeCapitalEfficiency({ expectedR: 2, riskAmount: 50 });
  const health = composeExecutionHealthGate({
    brokerSeverity: "ok",
    brokerConnected: true,
    feedStatus: "live",
    quoteCandleAligned: true,
    spread: "normal",
  });
  return {
    executionBlocked: false,
    blockReasons: [],
    warnings: [],
    executionQuality,
    netProfit,
    exposure,
    capitalEfficiency,
    health,
  };
}
const passingPhase7Evaluator: Phase7Evaluator = async () => passingPhase7Verdict();

const EMAIL = "qa+mission-driver@arx.test";
let userId: number;

async function cleanup(): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, EMAIL));
  for (const u of rows) {
    const owned = await db
      .select({ id: profitMissionsTable.id })
      .from(profitMissionsTable)
      .where(eq(profitMissionsTable.userId, u.id));
    const ids = owned.map((m) => m.id);
    if (ids.length > 0) {
      await db.delete(missionTradeDraftsTable).where(inArray(missionTradeDraftsTable.missionId, ids));
      await db.delete(missionProposalsTable).where(inArray(missionProposalsTable.missionId, ids));
      await db.delete(missionAgentsTable).where(inArray(missionAgentsTable.missionId, ids));
      await db.delete(missionEventsTable).where(inArray(missionEventsTable.missionId, ids));
      await db.delete(missionSnapshotsTable).where(inArray(missionSnapshotsTable.missionId, ids));
      await db.delete(missionTestResultsTable).where(inArray(missionTestResultsTable.missionId, ids));
    }
    await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, u.id));
    await db.delete(paperTradesTable).where(eq(paperTradesTable.userId, u.id));
    await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

async function seedMission(args: {
  executionMode: "paper" | "demo" | "live";
  automationLevel: number;
  status?: string;
  timeframeEndMs?: number;
  liveAutoEnabled?: boolean;
  certificateAccepted?: boolean;
}): Promise<number> {
  const now = Date.now();
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      status: args.status ?? "running",
      executionMode: args.executionMode,
      automationLevel: args.automationLevel,
      liveAutoEnabled: args.liveAutoEnabled === true,
      certificateAcceptedAt: args.certificateAccepted ? new Date(now) : null,
      startingAmount: 1000,
      targetAmount: 1300,
      requiredProfit: 300,
      currentValue: 1000,
      riskProfile: "balanced",
      timeframeStart: new Date(now - 60 * 60 * 1000),
      timeframeEnd: new Date(args.timeframeEndMs ?? now + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();
  return m[0]!.id;
}

/** Seed the honest promotion evidence a level-3 mission must EARN: eligible
 * backtest + forward results and >= 20 closed winning demo trades. */
async function seedPromotionEvidence(missionId: number): Promise<void> {
  const metrics = {
    totalTrades: 40, winningTrades: 26, losingTrades: 14, winRate: 0.65,
    netProfitLoss: 420, maxDrawdownPct: 6.5, averageRr: 1.6, expectancyR: 0.42,
    profitFactor: 1.9,
  };
  for (const kind of ["BACKTEST", "FORWARD"] as const) {
    await db.insert(missionTestResultsTable).values({
      missionId,
      userId,
      kind,
      strategyKey: "qa-strategy",
      symbol: "EURUSD",
      timeframe: "H1",
      label: kind === "BACKTEST" ? "Historical / simulated" : "Forward (demo)",
      sampleSize: 40,
      metricsJson: { metrics, headline: "qa", notes: [], promotionEligible: true },
      isVerified: true,
    });
  }
  // 20 closed, winning executed drafts (realised evidence for demo performance
  // + agent reliability). These are CLOSED history rows, not open trades.
  const closedAt = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < 20; i++) {
    await db.insert(missionTradeDraftsTable).values({
      draftId: `qa-driver-hist-${missionId}-${i}`,
      missionId,
      userId,
      proposalId: `qa-driver-hist-prop-${missionId}-${i}`,
      agentKey: "SCALPER",
      symbol: "EURUSD",
      timeframe: "H1",
      direction: "BUY",
      status: "executed",
      pnl: 10,
      rMultiple: 1.2,
      closedAt,
    });
  }
}

/** Seed a fresh actionable proposal the driver's (injected) scan will select. */
async function seedActionableProposal(missionId: number, proposalId: string): Promise<void> {
  const agent = await db
    .insert(missionAgentsTable)
    .values({ missionId, userId, agentKey: "SCALPER", name: "QA Scalper", role: "proposer" })
    .onConflictDoNothing()
    .returning();
  let agentId = agent[0]?.id;
  if (agentId == null) {
    const existing = await db
      .select({ id: missionAgentsTable.id })
      .from(missionAgentsTable)
      .where(eq(missionAgentsTable.missionId, missionId))
      .limit(1);
    agentId = existing[0]!.id;
  }
  await db.insert(missionProposalsTable).values({
    proposalId,
    missionId,
    userId,
    missionAgentId: agentId,
    agentKey: "SCALPER",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    confidence: 72,
    urgency: "medium",
    status: "selected",
    expectedR: 2,
    entryPlanJson: { entryPrice: 1.09 },
    riskPlanJson: { stopLoss: 1.085, takeProfit: 1.1, expectedR: 2 },
    edgeJson: {
      finalEdgeScore: 78,
      tier: "A",
      actionable: true,
      blocked: false,
      contextOnly: false,
    },
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
}

interface SpyCall {
  userId: number;
  intent: InstantTradeIntent;
}

function makeLiveSpy(outcome: InstantTradeResult): { fn: MissionExecutor; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const fn: MissionExecutor = async ({ userId: u, intent }) => {
    calls.push({ userId: u, intent });
    return outcome;
  };
  return { fn, calls };
}

function makeSimSpy(): {
  fn: MissionSimulatedExecutor;
  calls: Array<{ executionMode: string; intent: unknown }>;
} {
  const calls: Array<{ executionMode: string; intent: unknown }> = [];
  const fn: MissionSimulatedExecutor = async (args) => {
    calls.push({ executionMode: args.executionMode, intent: args.intent });
    return { ok: true, commandId: `sim:${args.executionMode}:${args.draft.draftId}:qa`, action: args.intent.action };
  };
  return { fn, calls };
}

async function missionStatus(id: number): Promise<string | undefined> {
  const rows = await db
    .select({ status: profitMissionsTable.status })
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, id))
    .limit(1);
  return rows[0]?.status;
}

async function eventTypes(missionId: number): Promise<string[]> {
  const rows = await db
    .select({ type: missionEventsTable.type })
    .from(missionEventsTable)
    .where(eq(missionEventsTable.missionId, missionId));
  return rows.map((r) => r.type);
}

before(async () => {
  await cleanup();
  const inserted = await db
    .insert(usersTable)
    .values({ email: EMAIL, name: "QA Mission Driver", role: "USER", isSystemUser: true })
    .returning();
  userId = inserted[0]!.id;
});

after(async () => {
  await cleanup();
});

test("expiry: a running mission past timeframeEnd is expired with no page open and nothing dispatched", async () => {
  const missionId = await seedMission({
    executionMode: "paper",
    automationLevel: 2,
    timeframeEndMs: Date.now() - 60 * 1000,
  });
  const live = makeLiveSpy({ ok: true, commandId: "never", action: "BUY" });
  const sim = makeSimSpy();

  const r = await runMissionDriverPass({
    onlyMissionId: missionId,
    executor: live.fn,
    simulatedExecutor: sim.fn,
    scan: async () => ({ selectedProposalId: null }),
  });

  assert.equal(r.scanned, 1);
  assert.equal(await missionStatus(missionId), "expired");
  assert.ok((await eventTypes(missionId)).includes("expired"));
  assert.equal(live.calls.length, 0);
  assert.equal(sim.calls.length, 0);
});

test("level 2 (default): the driver NEVER auto-approves — it holds and journals the block", async () => {
  const missionId = await seedMission({ executionMode: "paper", automationLevel: 2 });
  await seedActionableProposal(missionId, `qa-driver-l2-${missionId}`);
  const live = makeLiveSpy({ ok: true, commandId: "never", action: "BUY" });
  const sim = makeSimSpy();

  const r = await runMissionDriverPass({
    onlyMissionId: missionId,
    executor: live.fn,
    simulatedExecutor: sim.fn,
    scan: async () => ({ selectedProposalId: `qa-driver-l2-${missionId}` }),
  });

  const outcome = r.outcomes.find((o) => o.missionId === missionId)!;
  assert.equal(outcome.autoApproved, false);
  assert.equal(outcome.dispatched, false);
  assert.ok(outcome.blockReasons.includes("LEVEL_REQUIRES_USER_APPROVAL"));
  assert.equal(live.calls.length, 0);
  assert.equal(sim.calls.length, 0);
  // The draft was never even created — the proposal sits untouched.
  const drafts = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.proposalId, `qa-driver-l2-${missionId}`));
  assert.equal(drafts.length, 0);
  // The hold is journaled honestly (change-only).
  assert.ok((await eventTypes(missionId)).includes("driver_auto_blocked"));
});

test("level 3 (demo auto) with EARNED evidence: scan → auto-approve → dispatch lands on the simulated executor only", async () => {
  const missionId = await seedMission({ executionMode: "demo", automationLevel: 3 });
  await seedPromotionEvidence(missionId);
  const proposalId = `qa-driver-l3-${missionId}`;
  await seedActionableProposal(missionId, proposalId);
  const live = makeLiveSpy({ ok: true, commandId: "never-live", action: "BUY" });
  const sim = makeSimSpy();

  const r = await runMissionDriverPass({
    onlyMissionId: missionId,
    executor: live.fn,
    simulatedExecutor: sim.fn,
    phase7Evaluator: passingPhase7Evaluator,
    scan: async () => ({ selectedProposalId: proposalId }),
  });

  const outcome = r.outcomes.find((o) => o.missionId === missionId)!;
  assert.equal(outcome.autoApproved, true, `blocked: ${outcome.blockReasons.join(",")}`);
  assert.equal(outcome.dispatched, true);
  // The LIVE executor is NEVER touched by a demo mission; the simulated
  // recorder receives the identical mission-tagged intent.
  assert.equal(live.calls.length, 0);
  assert.equal(sim.calls.length, 1);
  assert.equal(sim.calls[0]!.executionMode, "demo");
  const intent = sim.calls[0]!.intent as { source: string; missionId: number; action: string };
  assert.equal(intent.source, "mission");
  assert.equal(intent.missionId, missionId);
  // The draft is executed with the sim command id persisted (draft→fill seam).
  const drafts = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.proposalId, proposalId));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.status, "executed");
  assert.match(drafts[0]!.commandId ?? "", /^sim:demo:/);
  // Auto-approval + dispatch are journaled.
  const types = await eventTypes(missionId);
  assert.ok(types.includes("draft_approved"));
  assert.ok(types.includes("draft_executed"));
});

test("gate block: a live-auto level without explicit enablement is held with honest reasons", async () => {
  const missionId = await seedMission({
    executionMode: "live",
    automationLevel: 5,
    liveAutoEnabled: false,
    certificateAccepted: true,
  });
  await seedPromotionEvidence(missionId);
  const proposalId = `qa-driver-l5-${missionId}`;
  await seedActionableProposal(missionId, proposalId);
  const live = makeLiveSpy({ ok: true, commandId: "never", action: "BUY" });
  const sim = makeSimSpy();

  const r = await runMissionDriverPass({
    onlyMissionId: missionId,
    executor: live.fn,
    simulatedExecutor: sim.fn,
    scan: async () => ({ selectedProposalId: proposalId }),
  });

  const outcome = r.outcomes.find((o) => o.missionId === missionId)!;
  assert.equal(outcome.autoApproved, false);
  assert.equal(outcome.dispatched, false);
  assert.ok(outcome.blockReasons.includes("LIVE_AUTO_NOT_ENABLED"));
  assert.equal(live.calls.length, 0);
  assert.equal(sim.calls.length, 0);
  assert.equal(await missionStatus(missionId), "running", "the mission waits — it is not killed by a block");
});

test("draft→fill linkage: a LIVE dispatch persists the executor's commandId onto the draft row", async () => {
  const missionId = await seedMission({
    executionMode: "live",
    automationLevel: 2,
  });
  const draftId = `qa-driver-link-${missionId}`;
  const proposalId = `qa-driver-link-prop-${missionId}`;
  await db.insert(missionTradeDraftsTable).values({
    draftId,
    missionId,
    userId,
    proposalId,
    agentKey: "SCALPER",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    stopLoss: 1.085,
    takeProfit: 1.1,
    lot: 0.01,
    edgeTier: "A",
    status: "approved",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  // Exercise the user-press hook directly (the same hook the driver calls) so
  // this proof does not depend on scan/promotion evidence.
  const { dispatchApprovedDraft } = await import("../missionExecution.js");
  const live = makeLiveSpy({ ok: true, commandId: "cmd-link-123", action: "BUY" });
  const result = await dispatchApprovedDraft(
    { userId, missionId, proposalId },
    { executor: live.fn, phase7Evaluator: passingPhase7Evaluator },
  );
  assert.equal(result.ok, true);
  const rows = await db
    .select({ commandId: missionTradeDraftsTable.commandId, status: missionTradeDraftsTable.status })
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.draftId, draftId));
  assert.equal(rows[0]!.status, "executed");
  assert.equal(rows[0]!.commandId, "cmd-link-123", "the commandId is persisted ON THE ROW at dispatch");
});

test("emergency stop enforcement: a user-emergency signal pauses the mission with no page open", async () => {
  const missionId = await seedMission({ executionMode: "paper", automationLevel: 2 });
  const r = await runMissionDriverPass({
    onlyMissionId: missionId,
    scan: async () => ({ selectedProposalId: null }),
    signals: {
      killSwitchActive: false,
      brokerConnected: true,
      feedStatus: "live",
      quoteFresh: true,
      userEmergencyStop: true,
    },
  });
  const outcome = r.outcomes.find((o) => o.missionId === missionId)!;
  assert.equal(outcome.transitioned, "paused");
  assert.equal(await missionStatus(missionId), "paused");
  assert.ok((await eventTypes(missionId)).includes("risk_stop"));
});
