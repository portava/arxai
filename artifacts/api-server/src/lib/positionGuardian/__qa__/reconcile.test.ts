// Position Guardian — post-fill reconciliation on a real database.
//
// Seeds a trader with an ARX-governed live fill (arx_live_commands) and the
// bridge's position snapshot (arx_live_positions), plus a governed demo fill
// (mt5_demo_commands) against the trader's live_positions row, and proves:
//   - the governed stop follows the entry and later approved modifies,
//   - a missing or widened broker stop is restored through the correction
//     path with the governed level, and the run is audited,
//   - a refused correction escalates with the refusal named,
//   - stale broker data escalates after the fill grace; a closed or
//     externally opened position is left alone,
//   - an unchanged healthy state is not re-audited on every snapshot,
//   - the restore the guardian sends is one the Risk Governor allows for an
//     automated origin, and the governor refuses the reverse (widening).
//
// Run: pnpm --filter @workspace/api-server run test:position-guardian-reconcile

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  arxLiveCommandsTable,
  arxLivePositionsTable,
  db,
  livePositionsTable,
  mt5DemoCommandsTable,
  userRiskEventsTable,
  usersTable,
} from "@workspace/db";
import { reconcileOpenPositions, reconcilePosition, type CorrectionSubmitter } from "../reconcile.js";
import { evaluatePreTradeRisk, resolveEffectiveLimits } from "../../riskGovernor/preTrade.js";

const EMAIL = "qa+position-guardian@arx.test";
const TICKET = "880001";
const DEMO_TICKET = "880002";
let userId = 0;

type Call = { venue: string; ticket: string; stopLoss: number; takeProfit: number | null };
let calls: Call[] = [];
const accept: CorrectionSubmitter = async (venue, _u, g, stopLoss, takeProfit) => {
  calls.push({ venue, ticket: g.ticket, stopLoss, takeProfit });
  return { ok: true, commandId: `qa_fix_${calls.length}`, reason: null };
};
const refuse: CorrectionSubmitter = async () => ({ ok: false, commandId: null, reason: "USER_NOT_ARMED_FOR_LIVE" });

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, EMAIL));
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
  await db.delete(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.userId, ids));
  await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
  await db.delete(mt5DemoCommandsTable).where(inArray(mt5DemoCommandsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedLive(opts: { brokerStop: number | null; syncedAgoMs?: number; filledAgoMs?: number } ): Promise<void> {
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, userId));
  await db.delete(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, userId));
  const filledAt = new Date(Date.now() - (opts.filledAgoMs ?? 10 * 60_000));
  await db.insert(arxLiveCommandsTable).values({
    commandId: "qa_open_1", userId, commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_FILLED",
    symbol: "EURUSD", side: "BUY", orderType: "MARKET_BUY", requestedVolume: 0.1, executedVolume: 0.1,
    stopLoss: 1.095, takeProfit: 1.11, brokerTicket: TICKET, filledAt, sourcePage: "LIVE_TRADE_TICKET",
  });
  await db.insert(arxLivePositionsTable).values({
    userId, bridgeConnectionId: 1, brokerTicket: TICKET, symbol: "EURUSD", side: "BUY", volume: 0.1,
    entryPrice: 1.1, currentPrice: 1.1, stopLoss: opts.brokerStop, takeProfit: 1.11, openedAt: filledAt,
    sourceCommandId: "qa_open_1", lastSyncedAt: new Date(Date.now() - (opts.syncedAgoMs ?? 5_000)),
  });
}

async function events() {
  return db.select().from(userRiskEventsTable).where(and(
    eq(userRiskEventsTable.userId, userId), eq(userRiskEventsTable.eventType, "position_guardian"),
  )).orderBy(desc(userRiskEventsTable.id));
}

before(async () => {
  await deleteFixtures();
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA Guardian", role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  userId = u!.id;
});
beforeEach(async () => {
  calls = [];
  await db.delete(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId));
});
after(deleteFixtures);

test("live: a broker position with no stop gets the governed stop restored, and the run is audited", async () => {
  await seedLive({ brokerStop: null });
  const r = await reconcilePosition("LIVE", userId, TICKET, { trigger: "fill", submit: accept });
  assert.ok(r);
  assert.deepEqual(r.assessment.findings, ["STOP_MISSING"]);
  assert.deepEqual(calls, [{ venue: "LIVE", ticket: TICKET, stopLoss: 1.095, takeProfit: 1.11 }]);
  assert.deepEqual(r.correction, { attempted: true, ok: true, commandId: "qa_fix_1", reason: null });
  const [ev] = await events();
  assert.equal(ev!.id, r.auditEventId);
  assert.equal(ev!.decision, "warning");
  const d = ev!.details as Record<string, unknown>;
  assert.equal(d["action"], "RESTORE_STOP");
  assert.equal(d["trigger"], "fill");
  assert.equal((d["governed"] as { stopLoss: number }).stopLoss, 1.095);
  assert.equal((d["broker"] as { stopLoss: number | null }).stopLoss, null);
});

test("live: the governed stop follows approved modifies; a broker stop wider than that is restored", async () => {
  await seedLive({ brokerStop: 1.096 });
  await db.insert(arxLiveCommandsTable).values({
    commandId: "qa_mod_1", userId, commandType: "MODIFY_LIVE_SLTP", status: "LIVE_FILLED",
    symbol: "EURUSD", side: "BUY", orderType: "MODIFY", requestedVolume: 0.1, stopLoss: 1.098,
    payload: { brokerTicket: TICKET, newStopLoss: 1.098 }, filledAt: new Date(Date.now() - 5 * 60_000),
  });
  const r = await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot", submit: accept });
  assert.deepEqual(r!.assessment.findings, ["STOP_WIDENED"]);
  assert.equal(calls[0]!.stopLoss, 1.098, "restores the latest approved stop, not the entry stop");
});

test("live: a refused correction escalates with the refusal named", async () => {
  await seedLive({ brokerStop: 1.08 });
  const r = await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot", submit: refuse });
  assert.equal(r!.correction.ok, false);
  assert.match(r!.assessment.reason, /refused \(USER_NOT_ARMED_FOR_LIVE\); please set the stop yourself/);
  const [ev] = await events();
  assert.equal(ev!.severity, "critical");
  assert.equal((ev!.details as Record<string, unknown>)["escalated"], true);
});

test("live: stale broker data escalates after the fill grace and waits inside it", async () => {
  await seedLive({ brokerStop: 1.095, syncedAgoMs: 10 * 60_000 });
  const late = await reconcilePosition("LIVE", userId, TICKET, { trigger: "sweep", submit: accept });
  assert.equal(late!.assessment.action, "ESCALATE");
  assert.deepEqual(late!.assessment.findings, ["SNAPSHOT_STALE"]);
  await seedLive({ brokerStop: 1.095, syncedAgoMs: 10 * 60_000, filledAgoMs: 20_000 });
  const early = await reconcilePosition("LIVE", userId, TICKET, { trigger: "fill", submit: accept });
  assert.equal(early!.assessment.action, "WAIT");
  assert.equal(calls.length, 0, "nothing is sent while the broker cannot be read");
});

test("live: a healthy position is audited once, not on every snapshot", async () => {
  await seedLive({ brokerStop: 1.097 });
  const first = await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot", submit: accept });
  assert.deepEqual(first!.assessment.findings, ["PROTECTED_TIGHTER"]);
  assert.ok(first!.auditEventId);
  const again = await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot", submit: accept });
  assert.equal(again!.auditEventId, null);
  assert.equal((await events()).length, 1);
  assert.equal(calls.length, 0);
});

test("live: closed and externally opened positions are left alone", async () => {
  await seedLive({ brokerStop: null });
  await db.update(arxLivePositionsTable).set({ closedAt: new Date() }).where(eq(arxLivePositionsTable.userId, userId));
  assert.equal(await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot", submit: accept }), null);
  assert.equal(await reconcilePosition("LIVE", userId, "999999", { trigger: "snapshot", submit: accept }), null);
  assert.equal(calls.length, 0);
});

test("demo: the sweep checks the trader's open demo positions against their governed fills", async () => {
  await db.delete(livePositionsTable).where(eq(livePositionsTable.userId, userId));
  await db.delete(mt5DemoCommandsTable).where(eq(mt5DemoCommandsTable.userId, userId));
  await db.insert(mt5DemoCommandsTable).values({
    commandId: "qa_demo_open_1", userId, bridgeConnectionId: 1, commandType: "PLACE_MARKET_ORDER",
    payload: { symbol: "GBPUSD", side: "SELL", lotSize: 0.2, stopLoss: 1.31, takeProfit: 1.28 },
    status: "FILLED_DEMO", safetyGateSnapshot: {}, brokerTicket: DEMO_TICKET, fillVolume: 0.2,
    filledAt: new Date(Date.now() - 10 * 60_000),
  });
  await db.insert(livePositionsTable).values({
    userId, brokerPositionId: DEMO_TICKET, symbol: "GBPUSD", direction: "SELL", lotSize: 0.2, entryPrice: 1.3,
    currentPrice: 1.3, stopLoss: 1.32, takeProfit: 1.28, status: "OPEN", lastSyncedAt: new Date(),
  });
  const runs = await reconcileOpenPositions("DEMO", userId, { trigger: "sweep", submit: accept });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]!.assessment.findings, ["STOP_WIDENED"]);
  assert.deepEqual(calls, [{ venue: "DEMO", ticket: DEMO_TICKET, stopLoss: 1.31, takeProfit: 1.28 }]);
});

test("the restore is one the Risk Governor allows for automation; it refuses the reverse", () => {
  const ctx = {
    now: new Date(), limits: resolveEffectiveLimits({}),
    account: { equity: 10_000, freeMargin: 9_000, leverage: 100, currency: "USD", source: "qa" },
    instruments: { EURUSD: { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "qa" } },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(), source: "qa" },
    positions: [], inFlight: [], broker: { status: "CONNECTED" as const, lastSeenAt: new Date(), detail: "qa" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    halt: { engaged: true, sources: ["trader_kill_switch"], reason: "qa" },
  };
  const base = { userId: 1, venue: "LIVE" as const, origin: "automation" as const, action: "MODIFY" as const,
    symbol: "EURUSD", side: "BUY" as const, lots: 0.1, takeProfit: null };
  const restore = evaluatePreTradeRisk({ ...base, stopLoss: 1.095, position: { entryPrice: 1.1, stopLoss: 1.08 } }, ctx);
  assert.equal(restore.decision, "ALLOW", "restoring a tighter stop passes, even under a halt");
  const widen = evaluatePreTradeRisk({ ...base, stopLoss: 1.08, position: { entryPrice: 1.1, stopLoss: 1.095 } }, ctx);
  assert.equal(widen.decision, "BLOCK");
});

test("the real correction path is the venue's governed queue: it refuses a trader who is not armed", async () => {
  await seedLive({ brokerStop: null });
  const live = await reconcilePosition("LIVE", userId, TICKET, { trigger: "snapshot" });
  assert.equal(live!.correction.attempted, true);
  assert.equal(live!.correction.reason, "USER_NOT_ARMED_FOR_LIVE");
  assert.equal(live!.assessment.action, "RESTORE_STOP");
  const demo = await reconcilePosition("DEMO", userId, DEMO_TICKET, { trigger: "snapshot" });
  assert.equal(demo!.correction.reason, "NOT_ARMED_FOR_DEMO_EXECUTION");
  const rows = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId), eq(arxLiveCommandsTable.commandType, "MODIFY_LIVE_SLTP")));
  assert.equal(rows.length, 0, "nothing reaches the broker without the venue's own gates");
});
