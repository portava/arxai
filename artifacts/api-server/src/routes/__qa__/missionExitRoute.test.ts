// Profit Mission Phase 8 (Task #667) — prove protective EXIT management on an
// OPEN mission trade routes ONLY through the existing instant-trade seam
// (`executeInstant`, source "mission"), never a parallel order path, and stays
// per-user isolated. Runs end to end against a real database.
//
// The injected `executor` is a SPY that stands in for the real instant-trade
// router so the test can observe exactly what intent the exit manager hands off
// (without placing a real order). Production passes no executor and always uses
// the real `executeInstant`.
//
// Proven here:
//   - A protective CLOSE (invalidation) routes through the seam with
//     intent.source === "mission" and action "CLOSE" (no new execution path).
//   - When the seam REJECTS (a downstream gate block), the manager returns
//     `execution_rejected` and reports nothing as dispatched.
//   - PER-USER ISOLATION — user B cannot manage user A's mission trade
//     (`mission_not_found`); the executor is never called.
//   - No open position → honest `no_open_position`, executor never called.
//
// Imports the manager → pulls in `@workspace/db` (module init throws with no
// DATABASE_URL), so this lives in the DB-backed integration lane
// (`runIntegrationCiTests.ts`), not the offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-exit-route

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
  arxLivePositionsTable,
  oneClickAuditTable,
  authUserSessionsTable,
  tradeIntelligenceSnapshotsTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import {
  manageMissionTradeExit,
  recordMissionTradeCloseByBrokerTicket,
  resolveMissionProtectionPulse,
  type MissionExitSignals,
} from "../../lib/missionExitManager.js";
import type { MissionExecutor } from "../../lib/missionExecution.js";
import type {
  InstantTradeIntent,
  InstantTradeResult,
} from "../../lib/live/instantTrade.js";

const EMAIL_A = "qa+mission-exit-a@arx.test";
const EMAIL_B = "qa+mission-exit-b@arx.test";

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
      await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.id));
      await db
        .delete(tradeIntelligenceSnapshotsTable)
        .where(eq(tradeIntelligenceSnapshotsTable.userId, u.id));
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
  await createUserSession({ userId: id });
  return id;
}

async function seedMission(userId: number): Promise<number> {
  const start = new Date();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const m = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      status: "running",
      executionMode: "live",
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

// Seed an EXECUTED draft linked to its live command (commandId), so the manager
// can resolve the open position via `source_command_id`.
async function seedExecutedDraft(args: {
  userId: number;
  missionId: number;
  draftId: string;
  commandId: string;
  brokerTicket?: string;
  resultJson?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(missionTradeDraftsTable).values({
    draftId: args.draftId,
    missionId: args.missionId,
    userId: args.userId,
    proposalId: `prop-${args.draftId}`,
    agentKey: `SCALP_${args.draftId}`,
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    stopLoss: 1.08,
    takeProfit: 1.095,
    lot: 0.02,
    edgeTier: "A",
    status: "executed",
    commandId: args.commandId,
    brokerTicket: args.brokerTicket ?? null,
    resultJson: args.resultJson ?? null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
}

// Seed an MFE-tracker snapshot keyed by broker ticket (the key the exit manager
// reads), so the missed-profit verdict has an account-currency peak to compare.
async function seedMfeSnapshot(args: {
  userId: number;
  brokerTicket: string;
  peakPnl: number;
}): Promise<void> {
  await db.insert(tradeIntelligenceSnapshotsTable).values({
    userId: args.userId,
    tradeKey: args.brokerTicket,
    routingMode: "USER_OWNED_MT5",
    accountType: "live",
    symbol: "EURUSD",
    side: "BUY",
    peakPnl: args.peakPnl,
  });
}

// Seed an OPEN live position (no closedAt) linked by source_command_id.
async function seedOpenPosition(args: {
  userId: number;
  commandId: string;
  brokerTicket: string;
  currentPrice?: number;
}): Promise<void> {
  await db.insert(arxLivePositionsTable).values({
    userId: args.userId,
    bridgeConnectionId: 1,
    brokerTicket: args.brokerTicket,
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.02,
    entryPrice: 1.085,
    currentPrice: args.currentPrice ?? 1.086,
    stopLoss: 1.08,
    takeProfit: 1.095,
    floatingPl: 2,
    openedAt: new Date(),
    sourceCommandId: args.commandId,
  });
}

interface CapturedCall {
  userId: number;
  intent: InstantTradeIntent;
}

function makeSpy(outcome: InstantTradeResult): { fn: MissionExecutor; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: MissionExecutor = async ({ userId, intent }) => {
    calls.push({ userId, intent });
    return outcome;
  };
  return { fn, calls };
}

const INVALIDATION: MissionExitSignals = { invalidation: true };

before(async () => {
  await cleanup();
  userAId = await seedUser(EMAIL_A, "Mission Exit A");
  userBId = await seedUser(EMAIL_B, "Mission Exit B");
});

after(async () => {
  await cleanup();
});

test("protective CLOSE routes through the instant-trade seam (source mission, no new path)", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-a-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  const brokerTicket = `tkt-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  await seedOpenPosition({ userId: userAId, commandId, brokerTicket });

  const spy = makeSpy({ ok: true, commandId: "exit-cmd-1", action: "CLOSE" });
  const result = await manageMissionTradeExit(
    { userId: userAId, missionId, draftId, signals: INVALIDATION },
    { executor: spy.fn },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.action, "CLOSE");
  assert.equal(result.dispatched, true);
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0]!;
  assert.equal(call.userId, userAId);
  // The ONLY execution path: the existing instant-trade seam, tagged "mission".
  assert.equal(call.intent.source, "mission");
  // #804 — the exit intent carries the originating missionId ownership tag too,
  // so a protective CLOSE is attributed to its mission on the same seam.
  assert.equal(call.intent.missionId, missionId);
  assert.equal(call.intent.action, "CLOSE");
  assert.equal(call.intent.symbol, "EURUSD");
  assert.equal(call.intent.positionId, brokerTicket);
});

test("seam rejection → execution_rejected, nothing reported dispatched", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-rej-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  const brokerTicket = `tkt-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  await seedOpenPosition({ userId: userAId, commandId, brokerTicket });

  const spy = makeSpy({
    ok: false,
    error: "LIVE_BLOCKED:KILL_SWITCH",
    primaryReason: "KILL_SWITCH",
    httpStatus: 403,
  });
  const result = await manageMissionTradeExit(
    { userId: userAId, missionId, draftId, signals: INVALIDATION },
    { executor: spy.fn },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "execution_rejected");
  assert.equal(spy.calls.length, 1); // routed through the seam, which blocked it
});

test("per-user isolation: user B cannot manage user A's mission trade", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-iso-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  const brokerTicket = `tkt-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  await seedOpenPosition({ userId: userAId, commandId, brokerTicket });

  const spy = makeSpy({ ok: true, commandId: "should-not-happen", action: "CLOSE" });
  const result = await manageMissionTradeExit(
    { userId: userBId, missionId, draftId, signals: INVALIDATION },
    { executor: spy.fn },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "mission_not_found");
  assert.equal(spy.calls.length, 0); // never reached the executor
});

test("no open position → honest no_open_position, executor never called", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-noopen-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  // No position seeded.

  const spy = makeSpy({ ok: true, commandId: "should-not-happen", action: "CLOSE" });
  const result = await manageMissionTradeExit(
    { userId: userAId, missionId, draftId, signals: INVALIDATION },
    { executor: spy.fn },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "no_open_position");
  assert.equal(spy.calls.length, 0);
});

test("PARTIAL_CLOSE maps onto the seam as CLOSE with a partial closeVolume", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-partial-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  const brokerTicket = `tkt-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  // Price 60% of the way to TP (entry 1.085 → TP 1.095) triggers a TP1 partial.
  await seedOpenPosition({ userId: userAId, commandId, brokerTicket, currentPrice: 1.091 });

  const spy = makeSpy({ ok: true, commandId: "exit-cmd-partial", action: "CLOSE" });
  const result = await manageMissionTradeExit(
    { userId: userAId, missionId, draftId, signals: {} },
    { executor: spy.fn },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.action, "PARTIAL_CLOSE");
  assert.equal(spy.calls.length, 1);
  const intent = spy.calls[0]!.intent;
  assert.equal(intent.source, "mission");
  assert.equal(intent.missionId, missionId); // #804 ownership tag on the partial-close exit
  // A partial maps onto the EXISTING CLOSE intent with a fractional closeVolume
  // (never a new "partial" execution path).
  assert.equal(intent.action, "CLOSE");
  assert.equal(intent.positionId, brokerTicket);
  assert.ok(typeof intent.closeVolume === "number" && intent.closeVolume > 0);
  assert.ok(intent.closeVolume! < 0.02); // strictly less than the full lot
});

test("MOVE_BREAKEVEN maps onto the seam as MODIFY_SL_TP with the break-even stop", async () => {
  const missionId = await seedMission(userAId);
  const draftId = `exit-be-${Date.now()}`;
  const commandId = `cmd-${draftId}`;
  const brokerTicket = `tkt-${draftId}`;
  await seedExecutedDraft({ userId: userAId, missionId, draftId, commandId });
  // In profit (1.087 > entry 1.085); agent disagreement secures break-even.
  await seedOpenPosition({ userId: userAId, commandId, brokerTicket, currentPrice: 1.087 });

  const spy = makeSpy({ ok: true, commandId: "exit-cmd-be", action: "MODIFY_SL_TP" });
  const result = await manageMissionTradeExit(
    { userId: userAId, missionId, draftId, signals: { agentDisagreement: true } },
    { executor: spy.fn },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.action, "MOVE_BREAKEVEN");
  assert.equal(spy.calls.length, 1);
  const intent = spy.calls[0]!.intent;
  assert.equal(intent.source, "mission");
  assert.equal(intent.missionId, missionId); // #804 ownership tag on the break-even modify exit
  // A stop move maps onto the EXISTING modify intent, not a new path.
  assert.equal(intent.action, "MODIFY_SL_TP");
  assert.equal(intent.positionId, brokerTicket);
  assert.equal(intent.newStopLoss, 1.085); // moved to entry (break-even)
});

test("close lifecycle: protective exit is justified (not penalised); a non-protective exit accrues missed profit", async () => {
  const missionId = await seedMission(userAId);

  // (a) Protective close (invalidation) — captured little of the MFE but JUSTIFIED.
  const protDraft = `close-prot-${Date.now()}`;
  const protTicket = `tkt-${protDraft}`;
  await seedExecutedDraft({
    userId: userAId,
    missionId,
    draftId: protDraft,
    commandId: `cmd-${protDraft}`,
    brokerTicket: protTicket,
    resultJson: { lastExitTrigger: "invalidation" },
  });
  await seedMfeSnapshot({ userId: userAId, brokerTicket: protTicket, peakPnl: 100 });

  const prot = await recordMissionTradeCloseByBrokerTicket({
    userId: userAId,
    brokerTicket: protTicket,
    realisedPnl: 20,
  });
  assert.equal(prot.ok, true);
  if (!prot.ok) return;
  assert.equal(prot.verdict.justified, true);
  assert.equal(prot.verdict.quality, "justified_early_exit");

  // (b) Non-protective close (target-style) capturing only 20% of a 100 MFE.
  const greedDraft = `close-greed-${Date.now()}`;
  const greedTicket = `tkt-${greedDraft}`;
  await seedExecutedDraft({
    userId: userAId,
    missionId,
    draftId: greedDraft,
    commandId: `cmd-${greedDraft}`,
    brokerTicket: greedTicket,
    resultJson: { lastExitTrigger: "trail_advance" },
  });
  await seedMfeSnapshot({ userId: userAId, brokerTicket: greedTicket, peakPnl: 100 });

  const greed = await recordMissionTradeCloseByBrokerTicket({
    userId: userAId,
    brokerTicket: greedTicket,
    realisedPnl: 20,
  });
  assert.equal(greed.ok, true);
  if (!greed.ok) return;
  assert.equal(greed.verdict.justified, false);
  const greedMissed = greed.verdict.missedProfit ?? 0;
  assert.ok(greedMissed > 0); // genuinely left money on the table

  // (c) Aggregate capture stats: ONLY the non-justified miss counts as money left.
  const pulse = await resolveMissionProtectionPulse({ userId: userAId, missionId });
  assert.equal(pulse.ok, true);
  if (!pulse.ok) return;
  assert.equal(pulse.pulse.capture.totalMissedProfit, greedMissed);

  // (d) Non-mission ticket → honest no-op (never fabricates a record).
  const noop = await recordMissionTradeCloseByBrokerTicket({
    userId: userAId,
    brokerTicket: "tkt-not-a-mission",
    realisedPnl: 5,
  });
  assert.equal(noop.ok, false);
  if (noop.ok) return;
  assert.equal(noop.kind, "not_mission_trade");
});
