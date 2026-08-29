// fix/demo-ladder — the paper/demo mission lifecycle proven end to end against
// a real database. The quote source is a deterministic stub standing in for the
// market-data router so the test can steer the price WITHOUT market data; the
// simulator itself is the REAL one, and production always reads real quotes.
//
// Proven here:
//   * A PAPER mission FILLS at the REAL quote price (BUY at the ask), tagged
//     `simulated = true`, with the assumptions + quote provenance on the row.
//   * NO FILL WITHOUT A QUOTE. With the feed down the dispatch is REJECTED with
//     NO_FILL_NO_QUOTE, the draft returns to `approved`, and no simulated
//     outcome row is written. Nothing is invented to force a fill.
//   * The position CLOSES on the same exit logic against a real subsequent
//     quote, writing ONLY the `sim_*` family.
//   * NO SIMULATED ROW EVER REACHES BROKER-RECONCILED MONEY: `pnl`,
//     `r_multiple`, `closed_at`, `captured_profit`, `missed_profit` and
//     `broker_ticket` stay NULL, `resolveMissionRealisedStats` stays 0, and no
//     economic posting exists for the simulated command.
//   * The mission PROGRESSES (currentValue moves on the SIMULATED basis) and
//     COMPLETES when the simulated target is reached.
//   * The LADDER IS REACHABLE: simulated closed drafts feed the promotion gate's
//     demo evidence, level 3 is approved, and the decision is labelled SIMULATED.
//   * The INVERSION IS CLOSED: demo → live with the certificate accepted and the
//     live gates on is still REFUSED without the ladder's evidence bar.
//
// Imports @workspace/db, so this lives in the DB-backed integration lane
// (runIntegrationCiTests.ts), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-demo-ladder

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
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
  economicPostingsTable,
} from "@workspace/db";
import {
  dispatchApprovedDraft,
  type MissionExecutor,
} from "../missionExecution.js";
import {
  makeMissionFillSimulator,
  runMissionSimulatedExitPass,
  resolveMissionSimulatedStats,
  readSimulatedClosedDrafts,
  type MissionQuoteReader,
} from "../missionSimulatedFills.js";
import {
  refreshMissionProtection,
  resolveMissionRealisedStats,
} from "../missionExitManager.js";
import { resolveMissionPromotionStatus } from "../missionPromotionService.js";
import { applyMissionExecutionMode } from "../missionExecutionModeService.js";
import type { Phase7Evaluator, Phase7Verdict } from "../missionExecutionQuality.js";
import {
  computeExecutionQuality,
  computeNetProfitVerdict,
  evaluateExposure,
  computeCapitalEfficiency,
  composeExecutionHealthGate,
} from "@workspace/domain/profit-mission";

// A real all-clear Phase 7 verdict (mirrors missionDriverWorker.test.ts): the
// REAL evaluator fails CLOSED without broker/feed signals — correct in
// production, but it would mask the assertions below. Phase 7 blocking itself
// is proven in the dedicated execution-route suite.
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
const passingPhase7: Phase7Evaluator = async () => passingPhase7Verdict();

/** A quote reader whose price the test steers. `null` = the feed is DOWN. */
function stubQuotes(): {
  reader: MissionQuoteReader;
  set: (bid: number | null, ask: number | null) => void;
  down: () => void;
} {
  let bid: number | null = 1.1000;
  let ask: number | null = 1.1002;
  const reader: MissionQuoteReader = async () =>
    bid == null || ask == null
      ? { quote: null, provider: null, quotedAt: null, reason: "QA: feed down" }
      : {
          quote: { bid, ask, last: (bid + ask) / 2 },
          provider: "qa_stub_feed",
          quotedAt: new Date().toISOString(),
          reason: null,
        };
  return {
    reader,
    set: (b, a) => { bid = b; ask = a; },
    down: () => { bid = null; ask = null; },
  };
}

/** The live executor must NEVER be reached by a paper/demo mission. */
function forbiddenLiveExecutor(): { fn: MissionExecutor; calls: () => number } {
  let calls = 0;
  const fn: MissionExecutor = async () => {
    calls += 1;
    return {
      ok: false,
      error: "the live executor must never be called for a paper/demo mission",
      httpStatus: 500,
    };
  };
  return { fn, calls: () => calls };
}

const EMAIL = "qa+mission-demo-ladder@arx.test";
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
    await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

async function seedMission(args: {
  executionMode: "paper" | "demo" | "live";
  automationLevel?: number;
  targetAmount?: number;
  certificateAccepted?: boolean;
}): Promise<number> {
  const now = Date.now();
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      status: "running",
      executionMode: args.executionMode,
      automationLevel: args.automationLevel ?? 2,
      certificateAcceptedAt: args.certificateAccepted ? new Date(now) : null,
      startingAmount: 1000,
      targetAmount: args.targetAmount ?? 1300,
      requiredProfit: (args.targetAmount ?? 1300) - 1000,
      currentValue: 1000,
      riskProfile: "balanced",
      timeframeStart: new Date(now - 3600_000),
      timeframeEnd: new Date(now + 7 * 24 * 3600_000),
    })
    .returning();
  return m[0]!.id;
}

/** An APPROVED draft ready for dispatch. Entry 1.0900, stop 1.0850, target 1.1000. */
async function seedApprovedDraft(missionId: number, draftId: string): Promise<void> {
  await db.insert(missionTradeDraftsTable).values({
    draftId,
    missionId,
    userId,
    proposalId: `${draftId}-prop`,
    agentKey: "SCALPER",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    status: "approved",
    entryPrice: 1.0900,
    stopLoss: 1.0850,
    takeProfit: 1.1000,
    lot: 0.05,
    riskAmount: 50,
    expectedR: 2,
    edgeTier: "A",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
}

async function draftRow(draftId: string) {
  const rows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.draftId, draftId))
    .limit(1);
  return rows[0]!;
}

async function missionRow(id: number) {
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, id))
    .limit(1);
  return rows[0]!;
}

before(async () => {
  await cleanup();
  const inserted = await db
    .insert(usersTable)
    .values({ email: EMAIL, name: "QA Demo Ladder", role: "USER", isSystemUser: true })
    .returning();
  userId = inserted[0]!.id;
});

after(async () => {
  await cleanup();
});

// ── 1. Fill at the real quote, tagged simulated ──────────────────────────────

test("a paper mission FILLS at the real quote price and the row is tagged simulated", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const draftId = `qa-sim-fill-${missionId}`;
  await seedApprovedDraft(missionId, draftId);
  const quotes = stubQuotes();
  quotes.set(1.0898, 1.0901);
  const live = forbiddenLiveExecutor();

  const r = await dispatchApprovedDraft(
    { userId, missionId, draftId },
    {
      executor: live.fn,
      simulatedExecutor: makeMissionFillSimulator({ quoteReader: quotes.reader }),
      phase7Evaluator: passingPhase7,
    },
  );

  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r));
  assert.equal(r.ok === true && r.executionMode, "paper");
  assert.ok(r.ok === true && r.commandId?.startsWith("sim:"), "the command id must be sim:-prefixed");
  assert.equal(live.calls(), 0, "the live executor must never be called for a paper mission");

  const row = await draftRow(draftId);
  assert.equal(row.simulated, true);
  // A BUY crosses the spread: it fills at the REAL ask, not the mid or the plan.
  assert.equal(row.simEntryPrice, 1.0901);
  assert.ok(row.simOpenedAt != null);
  // The assumptions + the exact quote travel with the number.
  const simJson = row.simJson as Record<string, unknown>;
  const entry = simJson.entry as Record<string, unknown>;
  assert.equal((entry.quote as Record<string, unknown>).ask, 1.0901);
  assert.equal((entry.quote as Record<string, unknown>).provider, "qa_stub_feed");
  assert.equal((simJson.assumptions as Record<string, unknown>).slippage, "NONE_MODELLED");
  // Not one broker-reconciled column was touched.
  assert.equal(row.pnl, null);
  assert.equal(row.closedAt, null);
  assert.equal(row.rMultiple, null);
  assert.equal(row.brokerTicket, null);
});

// ── 2. No fill without a quote ───────────────────────────────────────────────

test("with the feed DOWN there is NO FILL — honest refusal, draft back to approved", async () => {
  const missionId = await seedMission({ executionMode: "demo" });
  const draftId = `qa-sim-noquote-${missionId}`;
  await seedApprovedDraft(missionId, draftId);
  const quotes = stubQuotes();
  quotes.down();
  const live = forbiddenLiveExecutor();

  const r = await dispatchApprovedDraft(
    { userId, missionId, draftId },
    {
      executor: live.fn,
      simulatedExecutor: makeMissionFillSimulator({ quoteReader: quotes.reader }),
      phase7Evaluator: passingPhase7,
    },
  );

  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.kind, "execution_rejected");
  assert.equal(
    r.ok === false && r.kind === "execution_rejected" && r.primaryReason,
    "NO_FILL_NO_QUOTE",
  );
  assert.equal(live.calls(), 0);

  const row = await draftRow(draftId);
  // The single-flight claim was RELEASED — the user can retry when the feed returns.
  assert.equal(row.status, "approved");
  // And nothing was written that could be mistaken for a trade.
  assert.equal(row.simulated, false);
  assert.equal(row.simEntryPrice, null);
  assert.equal(row.pnl, null);

  const events = await db
    .select({ type: missionEventsTable.type })
    .from(missionEventsTable)
    .where(eq(missionEventsTable.missionId, missionId));
  assert.ok(events.some((e) => e.type === "draft_simulated_fill_refused"));
});

// ── 3. Close on the same exit logic against a real subsequent quote ──────────

test("a simulated position closes at the target on a real subsequent quote", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const draftId = `qa-sim-close-${missionId}`;
  await seedApprovedDraft(missionId, draftId);
  const quotes = stubQuotes();
  quotes.set(1.0898, 1.0901);

  await dispatchApprovedDraft(
    { userId, missionId, draftId },
    {
      executor: forbiddenLiveExecutor().fn,
      simulatedExecutor: makeMissionFillSimulator({ quoteReader: quotes.reader }),
      phase7Evaluator: passingPhase7,
    },
  );

  // Price has not reached the target yet — the position must stay OPEN.
  quotes.set(1.0950, 1.0953);
  const held = await runMissionSimulatedExitPass({ userId, missionId }, { quoteReader: quotes.reader });
  assert.equal(held.closed, 0);
  assert.equal((await draftRow(draftId)).simClosedAt, null);

  // The feed goes down: the position stays open rather than closing at a price
  // nobody quoted.
  quotes.down();
  const blind = await runMissionSimulatedExitPass({ userId, missionId }, { quoteReader: quotes.reader });
  assert.equal(blind.closed, 0);
  assert.equal(blind.heldNoQuote, 1);

  // Now a real quote reaches the target (1.1000).
  quotes.set(1.1005, 1.1008);
  const done = await runMissionSimulatedExitPass({ userId, missionId }, { quoteReader: quotes.reader });
  assert.equal(done.closed, 1);

  const row = await draftRow(draftId);
  assert.equal(row.simExitReason, "take_profit");
  assert.equal(row.simExitPrice, 1.1000);
  assert.ok(row.simClosedAt != null);
  // Entry 1.0901, target 1.1000, planned risk distance |1.0900 - 1.0850| = 0.0050.
  // R = 0.0099 / 0.0050 = 1.98 → P/L = 1.98 × 50 = 99.
  assert.ok(row.simRMultiple != null && Math.abs(row.simRMultiple - 1.98) < 0.01);
  assert.ok(row.simPnl != null && Math.abs(row.simPnl - 99) < 0.5);
  // STILL not one broker-reconciled column.
  assert.equal(row.pnl, null);
  assert.equal(row.rMultiple, null);
  assert.equal(row.closedAt, null);
  assert.equal(row.capturedProfit, null);
  assert.equal(row.missedProfit, null);
});

// ── 4. Simulated money never reaches broker-reconciled money ─────────────────

test("no simulated row enters a live realised sum or an economic posting", async () => {
  const missionId = await seedMission({ executionMode: "paper" });
  const draftId = `qa-sim-isolation-${missionId}`;
  await seedApprovedDraft(missionId, draftId);
  const quotes = stubQuotes();
  quotes.set(1.0898, 1.0901);
  const r = await dispatchApprovedDraft(
    { userId, missionId, draftId },
    {
      executor: forbiddenLiveExecutor().fn,
      simulatedExecutor: makeMissionFillSimulator({ quoteReader: quotes.reader }),
      phase7Evaluator: passingPhase7,
    },
  );
  const commandId = r.ok === true ? (r.commandId ?? "") : "";
  quotes.set(1.1005, 1.1008);
  await runMissionSimulatedExitPass({ userId, missionId }, { quoteReader: quotes.reader });

  // The simulated books have a figure...
  const sim = await resolveMissionSimulatedStats({ userId, missionId });
  assert.equal(sim.simulatedTradeCount, 1);
  assert.ok(sim.simulatedProfit > 0);
  assert.equal(sim.simulated, true);

  // ...and the BROKER-RECONCILED books are still empty. This is the whole
  // separation: a simulated outcome can never be summed into realised money.
  const realised = await resolveMissionRealisedStats({ userId, missionId });
  assert.equal(realised.realisedProfit, 0);
  assert.equal(realised.realisedTradeCount, 0);

  // And no economic posting exists for the simulated command.
  const postings = await db
    .select({ journalId: economicPostingsTable.journalId })
    .from(economicPostingsTable)
    .where(eq(economicPostingsTable.userId, userId));
  assert.equal(postings.length, 0, "a simulated outcome must never reach the economic ledger");
  if (commandId) {
    const byCommand = await db
      .select({ journalId: economicPostingsTable.journalId })
      .from(economicPostingsTable)
      .where(like(economicPostingsTable.journalId, `%${commandId}%`));
    assert.equal(byCommand.length, 0);
  }
});

// ── 5. The mission progresses and completes on simulated outcomes ────────────

test("a paper mission PROGRESSES and COMPLETES on simulated outcomes, labelled SIMULATED", async () => {
  // Target is only +100, so one ~+99 simulated win plus a second gets there.
  const missionId = await seedMission({ executionMode: "paper", targetAmount: 1100 });
  const quotes = stubQuotes();

  for (const i of [0, 1]) {
    const draftId = `qa-sim-progress-${missionId}-${i}`;
    await seedApprovedDraft(missionId, draftId);
    quotes.set(1.0898, 1.0901);
    const d = await dispatchApprovedDraft(
      { userId, missionId, draftId },
      {
        executor: forbiddenLiveExecutor().fn,
        simulatedExecutor: makeMissionFillSimulator({ quoteReader: quotes.reader }),
        phase7Evaluator: passingPhase7,
      },
    );
    assert.equal(d.ok, true, d.ok ? "" : JSON.stringify(d));
    quotes.set(1.1005, 1.1008);
    await runMissionSimulatedExitPass({ userId, missionId }, { quoteReader: quotes.reader });
  }

  const p = await refreshMissionProtection({ userId, missionId });
  assert.equal(p.ok, true);
  assert.equal(p.ok === true && p.snapshot.accountingBasis, "SIMULATED");

  const mission = await missionRow(missionId);
  // currentValue moved on the SIMULATED series (~1000 + 2 × 99).
  assert.ok(mission.currentValue > 1100, `currentValue was ${mission.currentValue}`);
  // The mission reached its (simulated) target and completed — the thing a
  // paper/demo mission could NEVER do before this fix.
  assert.equal(mission.status, "completed");
  assert.ok(mission.completedAt != null);

  // The progress blob says, in as many words, what these numbers are.
  const progress = mission.progressJson as Record<string, unknown>;
  const accounting = progress.accounting as Record<string, unknown>;
  assert.equal(accounting.basis, "SIMULATED");
  assert.equal(accounting.simulated, true);
  assert.match(String(accounting.label), /SIMULATED/);
  // Both series are published side by side; only the simulated one is non-zero.
  assert.equal(accounting.brokerReconciledProfit, 0);
  assert.ok(Number(accounting.simulatedProfit) > 0);
});

// ── 6. The ladder is reachable via simulated demo evidence ──────────────────

/** 20 CLOSED SIMULATED winning drafts + eligible backtest/forward results. */
async function seedSimulatedEvidence(missionId: number): Promise<void> {
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
      label: kind === "BACKTEST" ? "Historical / simulated" : "Forward (paper / demo / live)",
      sampleSize: 40,
      metricsJson: { metrics, headline: "qa", notes: [], promotionEligible: true, evidenceBasis: "SIMULATED" },
      isVerified: true,
    });
  }
  const closedAt = new Date(Date.now() - 3600_000);
  for (let i = 0; i < 20; i++) {
    await db.insert(missionTradeDraftsTable).values({
      draftId: `qa-sim-evidence-${missionId}-${i}`,
      missionId,
      userId,
      proposalId: `qa-sim-evidence-prop-${missionId}-${i}`,
      agentKey: "SCALPER",
      symbol: "EURUSD",
      timeframe: "H1",
      direction: "BUY",
      status: "executed",
      // SIMULATED family only — the broker-reconciled columns stay NULL.
      simulated: true,
      simEntryPrice: 1.09,
      simExitPrice: 1.10,
      simPnl: 10,
      simRMultiple: 1.2,
      simClosedAt: closedAt,
      simExitReason: "take_profit",
    });
  }
}

test("simulated closed drafts UNLOCK the promotion ladder, labelled as simulated", async () => {
  const missionId = await seedMission({ executionMode: "demo" });

  // Before any evidence, level 3 is refused on demo_performance.
  const before = await resolveMissionPromotionStatus({
    userId, missionId, targetLevel: 3, ctx: { role: "USER", isNewUser: false },
  });
  assert.equal(before.ok, true);
  assert.equal(before.ok === true && before.status.decision.approved, false);
  assert.ok(before.ok === true && before.status.decision.failedGates.includes("demo_performance"));

  await seedSimulatedEvidence(missionId);

  // The evidence is real and readable...
  const closed = await readSimulatedClosedDrafts(userId, missionId);
  assert.equal(closed.length, 20);
  assert.ok(closed.every((c) => c.simulated === true));

  // ...and it unlocks level 3, WITHOUT one dollar of real money.
  const after = await resolveMissionPromotionStatus({
    userId, missionId, targetLevel: 3, ctx: { role: "USER", isNewUser: false },
  });
  assert.equal(after.ok, true);
  const decision = after.ok === true ? after.status.decision : null;
  assert.ok(decision);
  assert.equal(decision.approved, true, decision.blockers.join("; "));
  // And the promotion decision SAYS the evidence is simulated.
  assert.equal(decision.demoEvidenceBasis, "SIMULATED");
  const gate = decision.gates.find((g) => g.name === "demo_performance");
  assert.match(gate!.detail, /SIMULATED/);
});

// ── 7. The demo→live inversion is closed ────────────────────────────────────

test("demo → live is REFUSED without the ladder's evidence bar, even with the certificate", async () => {
  const missionId = await seedMission({
    executionMode: "demo",
    automationLevel: 2,
    certificateAccepted: true,
  });

  const r = await applyMissionExecutionMode({
    userId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: { role: "USER", isNewUser: false },
  });

  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.kind, "blocked");
  const reasons = r.ok === false && r.kind === "blocked" ? r.blockReasons : [];
  assert.ok(
    reasons.some((x) => x.startsWith("PROMOTION_EVIDENCE_REQUIRED_FOR_LIVE")),
    `expected the evidence bar to refuse; got ${JSON.stringify(reasons)}`,
  );
  // The mode did NOT change.
  assert.equal((await missionRow(missionId)).executionMode, "demo");
});

test("with the ladder's evidence earned, demo → live is refused only by the LIVE gates", async () => {
  const missionId = await seedMission({
    executionMode: "demo",
    automationLevel: 2,
    certificateAccepted: true,
  });
  await seedSimulatedEvidence(missionId);

  const r = await applyMissionExecutionMode({
    userId,
    missionId,
    targetMode: "live",
    confirm: true,
    ctx: { role: "USER", isNewUser: false },
  });

  // The evidence bar no longer refuses. Whether the step succeeds now depends
  // ONLY on the pre-existing live gates (the platform master switch is OFF in
  // CI), which is exactly the intended layering: evidence AND live gates, never
  // evidence OR live gates.
  const reasons = r.ok === false && r.kind === "blocked" ? r.blockReasons : [];
  assert.ok(
    !reasons.some((x) => x.startsWith("PROMOTION_EVIDENCE_REQUIRED_FOR_LIVE")),
    `the evidence bar must be satisfied; got ${JSON.stringify(reasons)}`,
  );
  if (r.ok === false) {
    assert.ok(
      reasons.every((x) => x === "LIVE_GATES_DISABLED" || x === "CERTIFICATE_NOT_ACCEPTED"),
      `only live gates may remain; got ${JSON.stringify(reasons)}`,
    );
  }
});

test("no path reaches an auto level without evidence: level 4 still needs the live gates", async () => {
  const missionId = await seedMission({ executionMode: "demo" });
  await seedSimulatedEvidence(missionId);
  const status = await resolveMissionPromotionStatus({
    userId, missionId, targetLevel: 4, ctx: { role: "USER", isNewUser: false },
  });
  assert.equal(status.ok, true);
  const decision = status.ok === true ? status.status.decision : null;
  assert.ok(decision);
  // Simulated evidence satisfies the EVIDENCE gates and nothing more — the
  // live-only gates are untouched by this change.
  assert.equal(decision.approved, false);
  assert.ok(decision.failedGates.includes("explicit_user_enablement"));
  assert.ok(!decision.failedGates.includes("demo_performance"));
});

// ── 8. A live mission's books are untouched by the simulated series ─────────

test("a LIVE mission's realised books ignore simulated rows entirely", async () => {
  const missionId = await seedMission({ executionMode: "live" });
  await seedSimulatedEvidence(missionId); // 20 winning SIMULATED closes
  // One real broker-reconciled close.
  await db.insert(missionTradeDraftsTable).values({
    draftId: `qa-live-real-${missionId}`,
    missionId,
    userId,
    proposalId: `qa-live-real-prop-${missionId}`,
    agentKey: "SCALPER",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    status: "executed",
    pnl: 25,
    rMultiple: 0.5,
    closedAt: new Date(Date.now() - 3600_000),
  });

  const realised = await resolveMissionRealisedStats({ userId, missionId });
  // 25, NOT 25 + 200. The simulated wins are invisible to money.
  assert.equal(realised.realisedProfit, 25);
  assert.equal(realised.realisedTradeCount, 1);

  const p = await refreshMissionProtection({ userId, missionId });
  assert.equal(p.ok === true && p.snapshot.accountingBasis, "BROKER_RECONCILED");
  const mission = await missionRow(missionId);
  assert.equal(mission.currentValue, 1025);
});

// ── 8. No money figure survives a change of accounting basis ────────────────
//
// `currentValue` is written by refreshMissionProtection as
// `startingAmount + the realised total OF THE CURRENT BASIS`, and it is what
// missionDrafts sizes real positions from (`const accountBalance =
// mission.currentValue`) and what the risk service derives peak/drawdown from.
// A mode change that crosses the basis must therefore rebase it, or a simulated
// figure becomes a real-money account balance on the very next draft.
//
// The crossing is exercised here in the live → demo direction because CI keeps
// the platform live master switch OFF, so demo → live cannot complete in this
// lane — but it is the SAME rebase branch in applyMissionExecutionMode, keyed
// off accountingBasisForMode(current) !== accountingBasisForMode(target).

test("a mode change that crosses the accounting basis rebases currentValue onto the target series", async () => {
  const missionId = await seedMission({ executionMode: "live" });
  await seedSimulatedEvidence(missionId); // 20 SIMULATED closes @ +10 each
  // One real broker-reconciled close, so the two series are unmistakably apart.
  await db.insert(missionTradeDraftsTable).values({
    draftId: `qa-rebase-real-${missionId}`,
    missionId,
    userId,
    proposalId: `qa-rebase-real-prop-${missionId}`,
    agentKey: "SCALPER",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    status: "executed",
    pnl: 25,
    rMultiple: 0.5,
    closedAt: new Date(Date.now() - 3600_000),
  });

  // The live mission's value is on the BROKER_RECONCILED series: 1000 + 25.
  await refreshMissionProtection({ userId, missionId });
  assert.equal((await missionRow(missionId)).currentValue, 1025);

  // Downgrade to demo — always permitted (risk reduction), and it crosses the
  // accounting basis.
  const r = await applyMissionExecutionMode({
    userId,
    missionId,
    targetMode: "demo",
    confirm: true,
    ctx: { role: "USER", isNewUser: false },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.applied, true);

  const sim = await resolveMissionSimulatedStats({ userId, missionId });
  const after = await missionRow(missionId);
  // Rebased onto the SIMULATED series — and NOT the broker figure it replaced,
  // and NOT the two summed.
  assert.equal(after.currentValue, 1000 + sim.simulatedProfit);
  assert.notEqual(after.currentValue, 1025);
  assert.notEqual(after.currentValue, 1000 + sim.simulatedProfit + 25);

  // The honesty label travels with the figure, immediately — not a tick later.
  const accounting = (after.progressJson as Record<string, unknown> | null)?.accounting as
    | Record<string, unknown>
    | undefined;
  assert.equal(accounting?.basis, "SIMULATED");
  assert.equal(accounting?.simulated, true);
  assert.equal(accounting?.rebasedFromBasis, "BROKER_RECONCILED");
});
