// Profit Mission Phase 6 (Task #665) — prove the gated execution hook
// (`dispatchApprovedDraft`) connects an APPROVED draft to REAL execution for the
// first time, but ONLY through the existing instant-trade router seam
// (`executeInstant`, source "mission") → live pipeline → 23-gate dispatch, and
// never as a parallel order path. Runs end to end against a real database.
//
// The injected `executor` is a SPY that stands in for the real instant-trade
// router so the test can observe exactly what intent the mission layer hands off
// (without placing a real order). Production passes no executor and always uses
// the real `executeInstant`.
//
// Proven here:
//   (59) DEMO/PAPER never touches the live broker — a non-live mission runs the
//        SAME gate chain and dispatches onto the SIMULATED executor seam
//        (`sim:` command id, journaled + audited); the LIVE executor seam is
//        never called. The simulated fill is modelled from a REAL quote and
//        lands ONLY in the row's `sim_*` family — no broker-reconciled P/L,
//        close, or ticket is ever fabricated. Demo stays demo. (The paper/demo
//        outcome lifecycle itself is proven in missionDemoLadder.test.ts.)
//   (61) Mission cannot bypass the live execution gates — a live dispatch routes
//        through the SAME instant-trade seam with source "mission"; when that
//        seam rejects (a downstream gate block), the draft stays `approved` and
//        nothing is marked executed; when it accepts, the draft flips `executed`
//        exactly once and the command id is journaled. The mission layer adds a
//        stricter-only gate FIRST (missing stop-loss blocks before any executor
//        call) and can never relax a downstream gate.
//   + PER-USER ISOLATION — user B cannot dispatch user A's draft.
//
// Imports the hook → pulls in `@workspace/db` (module init throws with no
// DATABASE_URL), so this lives in the DB-backed integration lane
// (`runIntegrationCiTests.ts`), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-execution-route

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  usersTable,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionProposalsTable,
  missionAgentsTable,
  missionEventsTable,
  oneClickAuditTable,
  authUserSessionsTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import {
  dispatchApprovedDraft,
  type MissionExecutor,
} from "../../lib/missionExecution.js";
import {
  makeMissionFillSimulator,
  type MissionQuoteReader,
} from "../../lib/missionSimulatedFills.js";
import { sendDispatchFailure } from "../profitMissions.js";
import type {
  Phase7Evaluator,
  Phase7Verdict,
} from "../../lib/missionExecutionQuality.js";
import {
  computeExecutionQuality,
  computeNetProfitVerdict,
  evaluateExposure,
  computeCapitalEfficiency,
  composeExecutionHealthGate,
} from "@workspace/domain/profit-mission";
import type {
  InstantTradeIntent,
  InstantTradeResult,
} from "../../lib/live/instantTrade.js";

const EMAIL_A = "qa+mission-exec-a@arx.test";
const EMAIL_B = "qa+mission-exec-b@arx.test";

let userAId: number;
let userBId: number;

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
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
      }
      await db.delete(oneClickAuditTable).where(eq(oneClickAuditTable.userId, u.id));
      await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
      await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(email: string, name: string): Promise<number> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  // A session is minted to keep the user fully realistic (mirrors the route),
  // even though the hook is exercised directly per-user.
  await createUserSession({ userId: id });
  return id;
}

async function seedMission(userId: number, executionMode: "paper" | "demo" | "live"): Promise<number> {
  const start = new Date();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      status: "running",
      executionMode,
      startingAmount: 1000,
      targetAmount: 1300,
      requiredProfit: 300,
      currentValue: 1000,
      riskProfile: "balanced",
      timeframeStart: start,
      timeframeEnd: end,
    })
    .returning();
  return m[0]!.id;
}

// Seed an APPROVED draft directly so dispatch is deterministic. `hasStopLoss`
// controls whether the stricter-only mission gate (#16) lets the draft through.
async function seedApprovedDraft(args: {
  userId: number;
  missionId: number;
  draftId: string;
  proposalId: string;
  hasStopLoss?: boolean;
}): Promise<void> {
  await db.insert(missionTradeDraftsTable).values({
    draftId: args.draftId,
    missionId: args.missionId,
    userId: args.userId,
    proposalId: args.proposalId,
    agentKey: `SCALP_${args.proposalId}`,
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    stopLoss: args.hasStopLoss === false ? null : 1.08,
    takeProfit: 1.095,
    lot: 0.01,
    edgeTier: "A",
    status: "approved",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
}

// A real all-clear Phase 7 verdict so the Phase 6 tests that must reach the
// executor seam isolate Phase 6 behavior. (The REAL Phase 7 evaluator fails
// CLOSED when broker/feed signals are absent, which is correct — but it would
// otherwise mask the Phase 6 assertions below.) Phase 7 itself is proven by the
// dedicated `phase7:` block test that injects a blocking verdict.
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

interface CapturedCall {
  userId: number;
  intent: InstantTradeIntent;
}

// A spy executor. `outcome` drives whether the stand-in router accepts or
// rejects, so we can prove both the success flip and the gate-rejection path
// without placing a real order.
function makeSpy(outcome: InstantTradeResult): { fn: MissionExecutor; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: MissionExecutor = async ({ userId, intent }) => {
    calls.push({ userId, intent });
    return outcome;
  };
  return { fn, calls };
}

async function draftStatus(draftId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: missionTradeDraftsTable.status })
    .from(missionTradeDraftsTable)
    .where(eq(missionTradeDraftsTable.draftId, draftId))
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
  userAId = await seedUser(EMAIL_A, "QA Mission Exec A");
  userBId = await seedUser(EMAIL_B, "QA Mission Exec B");
});

after(async () => {
  await cleanup();
});

// (59) DEMO / PAPER missions never touch the live broker: the MISSION-LAYER
//      gates run, then the dispatch lands on the SIMULATED recorder — never the
//      live executor seam, so the 23 Phase B gates are not evaluated at all —
//      and no fill/price/P&L is fabricated.
test("59: demo/paper dispatch runs the mission-layer gates only and never touches the live broker", async () => {
  for (const mode of ["paper", "demo"] as const) {
    const missionId = await seedMission(userAId, mode);
    const draftId = `exec-nonlive-${mode}`;
    const proposalId = `prop-nonlive-${mode}`;
    await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });

    const spy = makeSpy({ ok: true, commandId: "should-never-be-used", action: "BUY" });
    // fix/demo-ladder: the default simulated executor now models a fill from the
    // market-data ROUTER's real quote — and refuses (NO_FILL_NO_QUOTE) when
    // there is no feed, which is correct but not deterministic in CI. The
    // simulator under test is the REAL one; only its quote source is stubbed.
    const stubQuote: MissionQuoteReader = async () => ({
      quote: { bid: 1.0898, ask: 1.0901, last: 1.08995 },
      provider: "qa_stub_feed",
      quotedAt: new Date().toISOString(),
      reason: null,
    });
    const result = await dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      {
        executor: spy.fn,
        simulatedExecutor: makeMissionFillSimulator({ quoteReader: stubQuote }),
        phase7Evaluator: passingPhase7Evaluator,
      },
    );

    // The dispatch SUCCEEDS through the gated path in its own mode…
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.executionMode, mode);
    assert.match(
      (result.ok === true && result.commandId) || "",
      new RegExp(`^sim:${mode}:`),
      "a simulated dispatch carries a sim: command id, never a broker command id",
    );
    // …but the LIVE executor seam is NEVER reached for a non-live mission.
    assert.equal(spy.calls.length, 0, `${mode} must not call the live executor`);
    // The draft flips executed exactly like a live one, with the sim commandId
    // persisted on the row (draft→fill seam) — and NO pnl/close is fabricated.
    assert.equal(await draftStatus(draftId), "executed");
    const rows = await db
      .select({
        commandId: missionTradeDraftsTable.commandId,
        pnl: missionTradeDraftsTable.pnl,
        closedAt: missionTradeDraftsTable.closedAt,
        brokerTicket: missionTradeDraftsTable.brokerTicket,
      })
      .from(missionTradeDraftsTable)
      .where(eq(missionTradeDraftsTable.draftId, draftId));
    assert.match(rows[0]!.commandId ?? "", new RegExp(`^sim:${mode}:`));
    assert.equal(rows[0]!.pnl, null, "no fabricated P/L");
    assert.equal(rows[0]!.closedAt, null, "no fabricated close");
    assert.equal(rows[0]!.brokerTicket, null, "no fabricated broker ticket");
    // The simulated dispatch is journaled honestly.
    const types = await eventTypes(missionId);
    assert.ok(types.includes("draft_dispatch_simulated"));
    assert.ok(types.includes("draft_executed"));
    // And an audit row records it.
    const audits = await db
      .select({ action: oneClickAuditTable.action })
      .from(oneClickAuditTable)
      .where(eq(oneClickAuditTable.userId, userAId));
    assert.ok(audits.some((a) => a.action === "mission_draft_dispatch_simulated"));
  }
});

// (61) A LIVE mission routes through the existing instant-trade seam (source
//      "mission") and cannot bypass its gates.
test("61: live dispatch routes through the gated instant-trade seam", async () => {
  // (a) Stricter-only mission gate runs FIRST: a missing stop-loss blocks the
  //     dispatch before the executor is ever called.
  {
    const missionId = await seedMission(userAId, "live");
    const draftId = "exec-live-nosl";
    const proposalId = "prop-live-nosl";
    await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId, hasStopLoss: false });
    const spy = makeSpy({ ok: true, commandId: "unused", action: "BUY" });
    const blocked = await dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.kind, "mission_blocked");
    assert.ok(
      blocked.ok === false &&
        blocked.kind === "mission_blocked" &&
        blocked.gate.blockReasons.includes("MISSION_STOP_LOSS_REQUIRED"),
    );
    assert.equal(spy.calls.length, 0, "the stricter mission gate blocks before any executor call");
    assert.equal(await draftStatus(draftId), "approved", "a blocked draft stays approved");
  }

  // (b) A downstream gate rejection (the seam returns !ok) leaves the draft
  //     approved — the mission layer never forces an order through.
  {
    const missionId = await seedMission(userAId, "live");
    const draftId = "exec-live-reject";
    const proposalId = "prop-live-reject";
    await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });
    const spy = makeSpy({
      ok: false,
      httpStatus: 409,
      error: "LIVE_BLOCKED:USER_NOT_ARMED_FOR_LIVE",
      primaryReason: "USER_NOT_ARMED_FOR_LIVE",
    });
    const rejected = await dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn, phase7Evaluator: passingPhase7Evaluator },
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok === false && rejected.kind, "execution_rejected");
    // Proof it routed through the ONE seam with the mission source + live mode.
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.intent.source, "mission");
    // #804 — the dispatched OPEN intent carries the originating missionId
    // ownership tag so the live pipeline can attribute the fill to its mission
    // (never a second execution path, never an untagged order).
    assert.equal(spy.calls[0]!.intent.missionId, missionId);
    assert.equal(spy.calls[0]!.intent.accountMode, "live");
    assert.equal(spy.calls[0]!.intent.action, "BUY");
    assert.equal(spy.calls[0]!.userId, userAId);
    // A rejected dispatch never marks the draft executed.
    assert.equal(await draftStatus(draftId), "approved");
    assert.ok((await eventTypes(missionId)).includes("draft_execution_rejected"));
  }

  // (c) Acceptance flips the draft to executed exactly once + journals it.
  {
    const missionId = await seedMission(userAId, "live");
    const draftId = "exec-live-ok";
    const proposalId = "prop-live-ok";
    await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });
    const spy = makeSpy({ ok: true, commandId: "cmd-live-123", action: "BUY" });
    const ok = await dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn, phase7Evaluator: passingPhase7Evaluator },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.ok === true && ok.commandId, "cmd-live-123");
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.intent.source, "mission");
    assert.equal(spy.calls[0]!.intent.missionId, missionId); // #804 ownership tag on the accepted OPEN
    assert.equal(await draftStatus(draftId), "executed");
    assert.ok((await eventTypes(missionId)).includes("draft_executed"));

    // Re-dispatching an already-executed draft is refused (no double order).
    const again = await dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn, phase7Evaluator: passingPhase7Evaluator },
    );
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.kind, "not_approved");
    assert.equal(spy.calls.length, 1, "an executed draft never re-enters the executor");
  }
});

// Build a real, fully-blocking Phase 7 verdict (stale quote / dead feed / thin
// net profit / correlated overexposure) so the injected evaluator is honest
// rather than a hand-waved stub.
function blockingPhase7Verdict(): Phase7Verdict {
  const executionQuality = computeExecutionQuality({
    isScalp: true,
    direction: "BUY",
    quoteFreshness: "stale",
    spreadPips: 3,
    expectedMovePips: 10,
  });
  const netProfit = computeNetProfitVerdict({
    isScalp: true,
    assetClass: "forex_major",
    targetProfit: 12,
    spreadCost: 5,
    estimatedSlippageCost: 3,
    commission: 2,
  });
  const exposure = evaluateExposure({
    open: [
      {
        symbol: "EURUSD",
        assetClass: "forex_major",
        currencies: ["EUR", "USD"],
        direction: "BUY",
        riskAmount: 50,
      },
    ],
    proposed: {
      symbol: "EURUSD",
      assetClass: "forex_major",
      currencies: ["EUR", "USD"],
      direction: "BUY",
      riskAmount: 50,
    },
    budget: { maxSameSymbolExposure: 1, maxCorrelatedExposure: 5 },
  });
  const capitalEfficiency = computeCapitalEfficiency({ expectedR: 1, riskAmount: 50 });
  const health = composeExecutionHealthGate({
    brokerSeverity: "danger",
    brokerConnected: true,
    feedStatus: "stale",
    quoteCandleAligned: true,
    spread: "normal",
  });
  const blockReasons = [
    ...executionQuality.blockers,
    ...netProfit.blockers,
    ...exposure.blockers,
    ...health.blockers,
  ];
  return {
    executionBlocked: true,
    blockReasons,
    warnings: [],
    executionQuality,
    netProfit,
    exposure,
    capitalEfficiency,
    health,
  };
}

// PHASE 7 (Task #666) — the additive execution-quality / net-profit / exposure /
// broker-feed-health pre-checks run BEFORE the single-flight claim. A Phase 7
// block leaves the draft approved, never reaches the executor seam, and is
// journaled + audited. These pre-checks are stricter-only: they can refuse a
// dispatch but can never relax the downstream gates.
test("phase7: a Phase 7 pre-check block refuses dispatch before the executor", async () => {
  const missionId = await seedMission(userAId, "live");
  const draftId = "exec-live-phase7";
  const proposalId = "prop-live-phase7";
  await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });

  const spy = makeSpy({ ok: true, commandId: "phase7-unused", action: "BUY" });
  const blockingEvaluator: Phase7Evaluator = async () => blockingPhase7Verdict();

  const result = await dispatchApprovedDraft(
    { userId: userAId, missionId, proposalId },
    { executor: spy.fn, phase7Evaluator: blockingEvaluator },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "phase7_blocked");
  assert.ok(
    result.ok === false &&
      result.kind === "phase7_blocked" &&
      result.phase7.executionBlocked === true &&
      result.phase7.blockReasons.length > 0,
  );
  // The live broker seam is NEVER reached when Phase 7 refuses.
  assert.equal(spy.calls.length, 0, "Phase 7 blocks before any executor call");
  // The draft stays approved — a Phase 7 block never marks it executed.
  assert.equal(await draftStatus(draftId), "approved");
  // The block is journaled + audited honestly.
  assert.ok((await eventTypes(missionId)).includes("draft_execution_blocked_phase7"));
  const audits = await db
    .select({ action: oneClickAuditTable.action })
    .from(oneClickAuditTable)
    .where(eq(oneClickAuditTable.userId, userAId));
  assert.ok(audits.some((a) => a.action === "mission_draft_execution_blocked_phase7"));
});

// PHASE 7 ROUTE MAPPING — the HTTP layer must surface a `phase7_blocked` hook
// result as a 409 with the honest structured payload (block reasons + warnings +
// health/net-profit summaries), distinct from the Phase 6 `mission_blocked` shape.
test("phase7 route mapping: a phase7_blocked result maps to 409 with structured payload", () => {
  const phase7 = blockingPhase7Verdict();
  const captured: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  } as unknown as import("express").Response;

  sendDispatchFailure(res, { ok: false, kind: "phase7_blocked", phase7 });

  assert.equal(captured.statusCode, 409);
  const body = captured.body as {
    error: string;
    blockReasons: string[];
    warnings: string[];
    health: string;
    netProfit: string;
  };
  assert.match(body.error, /pre-checks blocked/i);
  assert.deepEqual(body.blockReasons, phase7.blockReasons);
  assert.ok(body.blockReasons.length > 0, "the 409 carries the honest block reasons");
  assert.deepEqual(body.warnings, phase7.warnings);
  assert.equal(body.health, phase7.health.reason);
  assert.equal(body.netProfit, phase7.netProfit.reason);
});

// SINGLE-FLIGHT — two concurrent dispatches of the SAME approved draft must
// never both reach the live broker. The atomic claim (approved → executed,
// performed BEFORE the executor) guarantees exactly one caller wins; the other
// is refused without ever calling the executor. This locks the anti-double-
// dispatch safety property for the first real execution path.
test("concurrency: parallel dispatch of one approved draft fires the executor exactly once", async () => {
  const missionId = await seedMission(userAId, "live");
  const draftId = "exec-live-race";
  const proposalId = "prop-live-race";
  await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });

  // A SHARED spy so both racers increment the same call counter.
  const spy = makeSpy({ ok: true, commandId: "cmd-race", action: "BUY" });
  const [r1, r2] = await Promise.all([
    dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn, phase7Evaluator: passingPhase7Evaluator },
    ),
    dispatchApprovedDraft(
      { userId: userAId, missionId, proposalId },
      { executor: spy.fn, phase7Evaluator: passingPhase7Evaluator },
    ),
  ]);

  const winners = [r1, r2].filter((r) => r.ok === true);
  const refused = [r1, r2].filter((r) => r.ok === false);
  assert.equal(winners.length, 1, "exactly one dispatch wins the claim");
  assert.equal(refused.length, 1, "the other dispatch is refused");
  assert.equal(
    refused[0]!.ok === false && refused[0]!.kind,
    "not_approved",
    "the loser bails on the already-claimed draft",
  );
  // The live broker seam is contacted exactly once — never a double order.
  assert.equal(spy.calls.length, 1, "single-flight: the executor fires exactly once");
  // The draft is executed once and journaled exactly once.
  assert.equal(await draftStatus(draftId), "executed");
  const executedEvents = (await eventTypes(missionId)).filter((t) => t === "draft_executed");
  assert.equal(executedEvents.length, 1, "exactly one draft_executed event");
});

// PER-USER ISOLATION — user B cannot dispatch user A's draft.
test("isolation: a user cannot dispatch another user's draft", async () => {
  const missionId = await seedMission(userAId, "live");
  const draftId = "exec-iso";
  const proposalId = "prop-iso";
  await seedApprovedDraft({ userId: userAId, missionId, draftId, proposalId });

  const spy = makeSpy({ ok: true, commandId: "iso-cmd", action: "BUY" });
  const cross = await dispatchApprovedDraft(
    { userId: userBId, missionId, proposalId },
    { executor: spy.fn },
  );
  assert.equal(cross.ok, false);
  // Mission is scoped by (id, userId) so user B sees it as not found.
  assert.equal(cross.ok === false && cross.kind, "mission_not_found");
  assert.equal(spy.calls.length, 0);
  // User A's draft is untouched.
  assert.equal(await draftStatus(draftId), "approved");
});
