// Position Guardian — the management exit door: registry checks, the
// no-widening rule, the instant-router hand-off (pure) and the simulated-trade
// book (needs DATABASE_URL).
//
// Run: pnpm --filter @workspace/api-server run test:position-guardian-manage

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeManagement, guardianInstantManage, instantIntentAction } from "../manage.js";
import { GUARDIAN_RULES } from "../rules.js";
import type { InstantTradeIntent } from "../../live/instantTrade.js";

const refusal = (r: ReturnType<typeof authorizeManagement>) => (r.ok ? null : r.code);

test("registry: no rule can open a position or add size", () => {
  for (const rule of GUARDIAN_RULES) {
    for (const a of rule.actions) assert.ok(["RESTORE_STOP", "MOVE_STOP", "MOVE_TARGET", "PARTIAL_CLOSE", "CLOSE"].includes(a));
    if (rule.kind === "ADVISORY") assert.equal(rule.actions.length, 0, rule.id);
  }
  const ids = GUARDIAN_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("unknown and advisory rules cannot act", () => {
  assert.equal(refusal(authorizeManagement("rogue-engine", "CLOSE", "INSTANT_ROUTER")), "RULE_NOT_REGISTERED");
  assert.equal(refusal(authorizeManagement("trade-health", "CLOSE", "INSTANT_ROUTER")), "RULE_IS_ADVISORY");
  assert.equal(refusal(authorizeManagement("scalp-manage", "PARTIAL_CLOSE", "INSTANT_ROUTER")), "RULE_IS_ADVISORY");
  assert.equal(refusal(authorizeManagement("trade-monitor", "CLOSE", "TRADE_ACTION_CENTER")), "RULE_IS_ADVISORY");
});

test("a rule acts only with its registered actions on its registered route", () => {
  assert.equal(refusal(authorizeManagement("protective-close", "MOVE_STOP", "TRADE_ACTION_CENTER")), "ACTION_NOT_REGISTERED");
  assert.equal(refusal(authorizeManagement("position-protection", "CLOSE", "GOVERNED_OPS")), "ACTION_NOT_REGISTERED");
  assert.equal(refusal(authorizeManagement("self-trade-manage", "PARTIAL_CLOSE", "INSTANT_ROUTER")), "ACTION_NOT_REGISTERED");
  assert.equal(refusal(authorizeManagement("mission-exit", "CLOSE", "GOVERNED_OPS")), "ROUTE_NOT_REGISTERED");
  assert.equal(refusal(authorizeManagement("protective-close", "CLOSE", "TRADE_ACTION_CENTER")), null);
  assert.equal(refusal(authorizeManagement("position-protection", "RESTORE_STOP", "GOVERNED_OPS")), null);
});

test("a stop move only tightens", () => {
  const move = (side: "BUY" | "SELL", currentStop: number | null, nextStop: number | null) =>
    refusal(authorizeManagement("mission-exit", "MOVE_STOP", "INSTANT_ROUTER", { side, currentStop, nextStop }));
  assert.equal(move("BUY", 1.1, 1.105), null);          // BUY: up tightens
  assert.equal(move("BUY", 1.1, 1.095), "STOP_WOULD_WIDEN");
  assert.equal(move("SELL", 1.2, 1.195), null);         // SELL: down tightens
  assert.equal(move("SELL", 1.2, 1.205), "STOP_WOULD_WIDEN");
  assert.equal(move("BUY", null, 1.09), null);          // any stop beats none
  assert.equal(move("BUY", 1.1, null), "STOP_WOULD_WIDEN"); // removing a stop
  assert.equal(refusal(authorizeManagement("mission-exit", "MOVE_STOP", "INSTANT_ROUTER")), "STOP_WOULD_WIDEN");
});

const base: InstantTradeIntent = { source: "mission", action: "CLOSE", accountMode: "live", positionId: "77", symbol: "EURUSD" };
const pos = { side: "BUY" as const, stopLoss: 1.1, takeProfit: 1.2 };

test("instant intents map onto registry actions", () => {
  assert.equal(instantIntentAction(base, pos), "CLOSE");
  assert.equal(instantIntentAction({ ...base, closeVolume: 0.5 }, pos), "PARTIAL_CLOSE");
  assert.equal(instantIntentAction({ ...base, action: "MODIFY_SL_TP", newStopLoss: 1.105, newTakeProfit: 1.2 }, pos), "MOVE_STOP");
  assert.equal(instantIntentAction({ ...base, action: "MODIFY_SL_TP", newStopLoss: 1.1, newTakeProfit: 1.25 }, pos), "MOVE_TARGET");
  assert.equal(instantIntentAction({ ...base, action: "BUY", volume: 1 }, pos), null);
});

test("guardianInstantManage hands an authorized intent to the router and refuses the rest", async () => {
  const seen: InstantTradeIntent[] = [];
  const executor = async (a: { intent: InstantTradeIntent }) => {
    seen.push(a.intent);
    return { ok: true as const, commandId: "cmd-1", action: a.intent.action };
  };
  const ok = await guardianInstantManage({ ruleId: "mission-exit", userId: 1, intent: { ...base, action: "MODIFY_SL_TP", newStopLoss: 1.105 }, position: pos, executor });
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);

  const widen = await guardianInstantManage({ ruleId: "mission-exit", userId: 1, intent: { ...base, action: "MODIFY_SL_TP", newStopLoss: 1.09 }, position: pos, executor });
  assert.equal(widen.ok, false);
  assert.equal(!widen.ok && widen.error, "STOP_WOULD_WIDEN");

  const open = await guardianInstantManage({ ruleId: "mission-exit", userId: 1, intent: { ...base, action: "BUY", volume: 1 }, position: pos, executor });
  assert.equal(!open.ok && open.error, "UNSUPPORTED_ACTION");

  const partial = await guardianInstantManage({ ruleId: "self-trade-manage", userId: 1, intent: { ...base, closeVolume: 0.1 }, position: pos, executor });
  assert.equal(!partial.ok && partial.error, "ACTION_NOT_REGISTERED");
  assert.equal(seen.length, 1, "refused intents never reach the router");
});

// ── Simulated trades (needs DATABASE_URL; the integration lane provides it) ──

test("guardianPaperManage tightens, reduces and closes a simulated trade, and refuses a widening", async (t) => {
  const { db, tradesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { guardianPaperManage } = await import("../manage.js");
  const [trade] = await db.insert(tradesTable).values({
    symbol: "EURUSD", direction: "BUY", lot: 1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    strategy: "guardian-qa", confidence: 50,
  }).returning();
  t.after(async () => { await db.delete(tradesTable).where(eq(tradesTable.id, trade!.id)); });

  const widen = await guardianPaperManage({ ruleId: "trade-management", trade: trade!, op: { kind: "MOVE_STOP", newStop: 1.08 } });
  assert.equal(!widen.ok && widen.code, "STOP_WOULD_WIDEN");
  const [unchanged] = await db.select().from(tradesTable).where(eq(tradesTable.id, trade!.id));
  assert.equal(unchanged!.stopLoss, 1.09, "a refused step writes nothing");

  const be = await guardianPaperManage({ ruleId: "trade-management", trade: trade!, op: { kind: "MOVE_STOP", newStop: 1.1 } });
  assert.ok(be.ok && be.trade.stopLoss === 1.1);

  const grow = await guardianPaperManage({ ruleId: "trade-management", trade: trade!, op: { kind: "PARTIAL_CLOSE", newLot: 2 } });
  assert.equal(!grow.ok && grow.code, "UNSUPPORTED_ACTION", "a partial close never adds size");
  const half = await guardianPaperManage({ ruleId: "trade-management", trade: trade!, op: { kind: "PARTIAL_CLOSE", newLot: 0.5 } });
  assert.ok(half.ok && half.trade.lot === 0.5);

  const advisory = await guardianPaperManage({ ruleId: "trade-health" as "trade-management", trade: trade!, op: { kind: "CLOSE", status: "CLOSED_WIN", pnl: 1, closedAt: new Date() } });
  assert.equal(!advisory.ok && advisory.code, "RULE_IS_ADVISORY");

  const closed = await guardianPaperManage({ ruleId: "trade-management", trade: trade!, op: { kind: "CLOSE", status: "CLOSED_WIN", pnl: 12.5, closedAt: new Date() } });
  assert.ok(closed.ok && closed.trade.status === "CLOSED_WIN" && closed.trade.pnl === 12.5);
});
