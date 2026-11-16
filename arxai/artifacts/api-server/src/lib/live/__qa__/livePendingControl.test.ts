// Live pending-order cancel / modify — pure pieces (no DB, no broker).
//   node --import tsx --test src/lib/live/__qa__/livePendingControl.test.ts
// Wired into `test:mt5-order-controls-20261104`.
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const C = await import("../livePendingControl.js");
const P = await import("../liveCommandPipeline.js");
const { selectWorkingPendingOrders } = await import("../livePendingOrdersView.js");
const { killSwitchCloseBypassApplies } = await import("../killSwitchBypass.js");
const { actionTypeForCommand } = await import("../../security/commandIntegrity.js");
const { buildLiveIdempotencyKey } = await import("../phaseBConfig.js");

const here = dirname(fileURLToPath(import.meta.url));

const order = (over: Partial<Parameters<typeof C.checkPendingOrderControllable>[0]["row"] & object> = {}) => ({
  commandId: "lvcmd_order", userId: 7, commandType: "PLACE_LIVE_PENDING_ORDER", status: "LIVE_ACKNOWLEDGED",
  brokerTicket: "5001", symbol: "EURUSD", side: "BUY", orderType: "BUY_LIMIT", requestedVolume: 0.1,
  stopLoss: 1.08, takeProfit: 1.12, payload: { price: 1.09 }, ...over,
});
const can = (row: ReturnType<typeof order> | null, extra: Partial<{ userId: number; positionTickets: Set<string>; inFlightControlCount: number; nowMs: number }> = {}) =>
  C.checkPendingOrderControllable({ row, userId: 7, positionTickets: new Set(), inFlightControlCount: 0, ...extra });

// ── ownership / controllability ────────────────────────────────────────────
test("own LIVE_ACKNOWLEDGED pending order with a ticket is controllable", () => {
  assert.deepEqual(can(order()), { ok: true, orderTicket: "5001" });
});
test("refusals: missing, other user, not pending, no ticket, not working, filled, expired, in flight", () => {
  const reason = (r: ReturnType<typeof can>) => (r.ok ? "OK" : r.reason);
  assert.equal(reason(can(null)), "PENDING_ORDER_NOT_FOUND");
  assert.equal(reason(can(order({ userId: 8 }))), "PENDING_ORDER_NOT_OWNED");
  assert.equal(reason(can(order({ commandType: "PLACE_LIVE_MARKET_ORDER" }))), "NOT_A_PENDING_ORDER");
  assert.equal(reason(can(order({ brokerTicket: null }))), "PENDING_ORDER_TICKET_MISSING");
  assert.equal(reason(can(order({ brokerTicket: "0" }))), "PENDING_ORDER_TICKET_MISSING");
  for (const status of ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_CANCELLED", "SENT_TO_MT5_LIVE", "LIVE_UNKNOWN"]) {
    assert.equal(reason(can(order({ status }))), "PENDING_ORDER_NOT_WORKING", status);
  }
  assert.equal(reason(can(order(), { positionTickets: new Set(["5001"]) })), "PENDING_ORDER_FILLED");
  assert.equal(reason(can(order({ payload: { price: 1.09, expirationEpoch: 1000 } }), { nowMs: 2_000_000 })), "PENDING_ORDER_EXPIRED");
  assert.equal(reason(can(order(), { inFlightControlCount: 1 })), "PENDING_ORDER_CONTROL_IN_FLIGHT");
});

// ── modify validation (pendingOrderRules) ──────────────────────────────────
const cur = { price: 1.09, stopLimitPrice: null, stopLoss: 1.08, takeProfit: 1.12 };
test("modify: Buy Limit price must stay below the Ask; unchanged fields keep the current level", () => {
  const ok = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: 1.095 }, bid: 1.0999, ask: 1.1 });
  assert.deepEqual(ok, { ok: true, effective: { price: 1.095, stopLoss: 1.08, takeProfit: 1.12 }, priceChanged: true });
  const bad = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: 1.101 }, bid: 1.0999, ask: 1.1 });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.code, "PENDING_PRICE_WRONG_SIDE");
});
test("modify: no fresh quote → the side check is left to the broker", () => {
  const r = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: 1.2, takeProfit: 1.3 }, bid: null, ask: null });
  assert.equal(r.ok, true);
});
test("modify: Sell Stop below the Bid; SL/TP sides against the new price", () => {
  const sell = { price: 1.05, stopLimitPrice: null, stopLoss: 1.06, takeProfit: 1.0 };
  assert.equal(C.validatePendingModify({ orderType: "SELL_STOP", side: "SELL", current: sell, next: { price: 1.04 }, bid: 1.06, ask: 1.0601 }).ok, true);
  const slWrong = C.validatePendingModify({ orderType: "SELL_STOP", side: "SELL", current: sell, next: { stopLoss: 1.04 }, bid: 1.06, ask: 1.0601 });
  assert.equal(!slWrong.ok && slWrong.code, "STOP_LOSS_WRONG_SIDE");
  // moving the entry below the stop puts the stop on the wrong side
  const tpWrong = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: 1.0 }, bid: 1.0999, ask: 1.1 });
  assert.equal(!tpWrong.ok && tpWrong.code, "STOP_LOSS_WRONG_SIDE");
});
test("modify: SL-only change does not re-check an unchanged trigger price that drifted near the market", () => {
  const r = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { stopLoss: 1.085 }, bid: 1.0895, ask: 1.0896 });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.priceChanged, false);
});
test("modify: stop-limit SL/TP reference is the limit price", () => {
  const sl = { price: 1.11, stopLimitPrice: 1.105, stopLoss: 1.1, takeProfit: 1.13 };
  const r = C.validatePendingModify({ orderType: "BUY_STOP_LIMIT", side: "BUY", current: sl, next: { stopLoss: 1.107 }, bid: 1.1, ask: 1.1001 });
  assert.equal(!r.ok && r.code, "STOP_LOSS_WRONG_SIDE");
});
test("modify: no change, bad numbers and removal are refused", () => {
  const same = C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: 1.09 }, bid: null, ask: null });
  assert.equal(!same.ok && same.code, "NO_CHANGES");
  assert.equal(C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { stopLoss: 0 }, bid: null, ask: null }).ok, false);
  assert.equal(C.validatePendingModify({ orderType: "BUY_LIMIT", side: "BUY", current: cur, next: { price: Number.NaN }, bid: null, ask: null }).ok, false);
});

// ── tracked levels ─────────────────────────────────────────────────────────
test("current levels: original overlaid by the latest broker-confirmed modify", () => {
  const o = order();
  assert.deepEqual(C.currentPendingLevels(o, null), { price: 1.09, stopLimitPrice: null, stopLoss: 1.08, takeProfit: 1.12 });
  const m = { payload: { pendingModifyV1: { after: { price: 1.095, stopLoss: 1.085, takeProfit: 1.12 } } } };
  assert.deepEqual(C.currentPendingLevels(o, m), { price: 1.095, stopLimitPrice: null, stopLoss: 1.085, takeProfit: 1.12 });
});
test("pending list view: modify overlay, controllable only when acknowledged, in-flight flag", () => {
  const rows = [
    { ...order(), createdAt: new Date(0) },
    { ...order({ commandId: "legacy", brokerTicket: "5002", status: "LIVE_FILLED" }), createdAt: new Date(0) },
  ];
  const v = selectWorkingPendingOrders(rows, new Set(), 1_000, {
    latestModify: new Map([["lvcmd_order", { price: 1.095, stopLoss: 1.085, takeProfit: 1.12 }]]),
    inFlight: new Set(["legacy"]),
  });
  assert.equal(v[0]!.price, 1.095);
  assert.equal(v[0]!.stopLoss, 1.085);
  assert.equal(v[0]!.controllable, true);
  assert.equal(v[0]!.modifiedFromArx, true);
  assert.equal(v[1]!.controllable, false);
  assert.equal(v[1]!.controlInFlight, true);
});

// ── EA mailbox ─────────────────────────────────────────────────────────────
test("EA actions: CANCEL_PENDING / MODIFY_PENDING", () => {
  assert.equal(P.eaActionForLiveCommandType("CANCEL_LIVE_PENDING_ORDER"), "CANCEL_PENDING");
  assert.equal(P.eaActionForLiveCommandType("MODIFY_LIVE_PENDING_ORDER"), "MODIFY_PENDING");
  assert.equal(P.eaActionForLiveCommandType("CLOSE_LIVE_POSITION"), "CLOSE_POSITION");
});
test("mirror payload: orderTicket for a cancel, entry only when the price changes, no positionTicket", () => {
  const cancel = P.buildBridgedMt5CommandPayload({ commandId: "c", userId: 7, commandType: "CANCEL_LIVE_PENDING_ORDER",
    brokerTicket: null, payload: { orderTicket: "5001", targetCommandId: "lvcmd_order" } });
  assert.equal(cancel.orderTicket, "5001");
  assert.equal(cancel.positionTicket, undefined);
  assert.equal(cancel.entry, undefined);
  assert.equal(cancel.confirmedByUser, true);
  const mod = P.buildBridgedMt5CommandPayload({ commandId: "m", userId: 7, commandType: "MODIFY_LIVE_PENDING_ORDER", brokerTicket: null,
    payload: { orderTicket: "5001", pendingModifyV1: { after: { price: 1.095, stopLoss: 1.08, takeProfit: 1.12 }, priceChanged: true } } });
  assert.equal(mod.entry, 1.095);
  assert.equal(mod.expirationEpoch, undefined, "the EA keeps the order's own expiry");
  const slOnly = C.pendingControlMirrorPayload("MODIFY_LIVE_PENDING_ORDER",
    { orderTicket: "5001", pendingModifyV1: { after: { price: 1.09, stopLoss: 1.085 }, priceChanged: false } });
  assert.equal(slOnly.entry, undefined, "unchanged price: the EA keeps the order's price");
});
test("mirror payload: a missing / zero order ticket is never sent", () => {
  for (const t of [undefined, "", "0", "abc"]) {
    assert.throws(() => C.pendingControlMirrorPayload("CANCEL_LIVE_PENDING_ORDER", { orderTicket: t }), /LIVE_BRIDGE_ORDER_TICKET_MISSING/);
  }
});

// ── result mapping + status transitions ────────────────────────────────────
const map = (commandType: string, status: string, hasBrokerTicket = true) =>
  P.mapBridgedLiveOutcome({ status, hasBrokerTicket, commandType, requestedVolume: 0.1, executedVolume: 0 });
test("result: CANCELLED + ticket → LIVE_CANCELLED; MODIFIED + ticket → LIVE_FILLED; refusals and doubt stay honest", () => {
  assert.equal(map("CANCEL_LIVE_PENDING_ORDER", "CANCELLED"), "LIVE_CANCELLED");
  assert.equal(map("MODIFY_LIVE_PENDING_ORDER", "MODIFIED"), "LIVE_FILLED");
  assert.equal(map("CANCEL_LIVE_PENDING_ORDER", "REJECTED"), "LIVE_REJECTED");
  assert.equal(map("MODIFY_LIVE_PENDING_ORDER", "FAILED"), "LIVE_FAILED");
  assert.equal(map("CANCEL_LIVE_PENDING_ORDER", "EXPIRED"), "STALE_COMMAND_REJECTED");
  assert.equal(map("CANCEL_LIVE_PENDING_ORDER", "CANCELLED", false), "LIVE_UNKNOWN");
  assert.equal(map("CANCEL_LIVE_PENDING_ORDER", "MODIFIED"), "LIVE_UNKNOWN");
  assert.equal(map("MODIFY_LIVE_PENDING_ORDER", "CANCELLED"), "LIVE_UNKNOWN");
  assert.notEqual(map("CLOSE_LIVE_POSITION", "CANCELLED"), "LIVE_CANCELLED", "only a cancel control maps to LIVE_CANCELLED");
});
test("transitions: SENT → LIVE_CANCELLED only on the cancel result path; the shared table is unchanged", () => {
  assert.equal(C.isAllowedPendingControlResultTransition("CANCEL_LIVE_PENDING_ORDER", "SENT_TO_MT5_LIVE", "LIVE_CANCELLED"), true);
  assert.equal(C.isAllowedPendingControlResultTransition("CLOSE_LIVE_POSITION", "SENT_TO_MT5_LIVE", "LIVE_CANCELLED"), false);
  assert.equal(C.isAllowedPendingControlResultTransition("CANCEL_LIVE_PENDING_ORDER", "LIVE_UNKNOWN", "LIVE_CANCELLED"), false);
  assert.equal(P.isAllowedLiveTransition("SENT_TO_MT5_LIVE", "LIVE_CANCELLED"), false);
  assert.equal(P.isAllowedLiveTransition("LIVE_ACKNOWLEDGED", "LIVE_CANCELLED"), false, "no generic path may cancel a working order row");
});
test("original order: LIVE_ACKNOWLEDGED → LIVE_CANCELLED only after a confirmed cancel; reservation RELEASE", () => {
  assert.equal(C.originalStatusAfterControl("CANCEL_LIVE_PENDING_ORDER", "LIVE_CANCELLED", "LIVE_ACKNOWLEDGED"), "LIVE_CANCELLED");
  assert.equal(C.originalStatusAfterControl("CANCEL_LIVE_PENDING_ORDER", "LIVE_UNKNOWN", "LIVE_ACKNOWLEDGED"), null);
  assert.equal(C.originalStatusAfterControl("CANCEL_LIVE_PENDING_ORDER", "LIVE_CANCELLED", "LIVE_FILLED"), null);
  assert.equal(C.originalStatusAfterControl("MODIFY_LIVE_PENDING_ORDER", "LIVE_FILLED", "LIVE_ACKNOWLEDGED"), null);
  assert.equal(P.settleReservationForStatus("LIVE_CANCELLED"), "RELEASE");
  assert.equal(P.settleReservationForStatus("LIVE_ACKNOWLEDGED"), "HOLD");
});

// ── gates / classification ─────────────────────────────────────────────────
test("kill switch: the admin emergency bypass stays CLOSE-only; modify is posture-restricted, cancel is not", () => {
  assert.equal(killSwitchCloseBypassApplies({ commandType: "CANCEL_LIVE_PENDING_ORDER", hasBypassMarker: true }), false);
  assert.equal(C.pendingControlRestrictedByEntryPosture("MODIFY_LIVE_PENDING_ORDER"), true);
  assert.equal(C.pendingControlRestrictedByEntryPosture("CANCEL_LIVE_PENDING_ORDER"), false);
  // The safety-core stop refuses entries; the dispatch maps a modify onto an entry type for it.
  assert.equal(P.emergencyKillSwitchBlocksDispatch({ emergencyKillSwitch: false, safetyCoreKillSwitch: true,
    commandType: "PLACE_LIVE_PENDING_ORDER", hasKillSwitchCloseBypassMarker: false }), true);
  assert.equal(P.emergencyKillSwitchBlocksDispatch({ emergencyKillSwitch: false, safetyCoreKillSwitch: true,
    commandType: "CANCEL_LIVE_PENDING_ORDER", hasKillSwitchCloseBypassMarker: false }), false);
});
test("integrity action types", () => {
  assert.equal(actionTypeForCommand("CANCEL_LIVE_PENDING_ORDER"), "CANCEL_PENDING_ORDER");
  assert.equal(actionTypeForCommand("MODIFY_LIVE_PENDING_ORDER"), "MODIFY_PENDING_ORDER");
});
test("risk governor intent: cancel is a CLOSE; modify keeps the old risk distance as the baseline stop", () => {
  const before = { price: 1.09, stopLimitPrice: null, stopLoss: 1.08, takeProfit: 1.12 };
  assert.equal(C.pendingControlRiskIntent({ commandType: "CANCEL_LIVE_PENDING_ORDER", side: "BUY", before, after: before }).action, "CLOSE");
  const moved = C.pendingControlRiskIntent({ commandType: "MODIFY_LIVE_PENDING_ORDER", side: "BUY", before,
    after: { price: 1.095, stopLoss: 1.08, takeProfit: 1.12 } });
  assert.equal(moved.action, "MODIFY");
  assert.equal(moved.entryPrice, 1.095);
  // baseline = new entry − old distance (0.01) = 1.085; the kept 1.08 is wider → judged as a widen
  assert.ok(Math.abs(moved.position!.stopLoss! - 1.085) < 1e-9);
  assert.ok(moved.stopLoss! < moved.position!.stopLoss!);
  const sell = C.pendingControlRiskIntent({ commandType: "MODIFY_LIVE_PENDING_ORDER", side: "SELL",
    before: { price: 1.05, stopLimitPrice: null, stopLoss: 1.06, takeProfit: 1.0 }, after: { price: 1.04, stopLoss: 1.06, takeProfit: 1.0 } });
  assert.ok(Math.abs(sell.position!.stopLoss! - 1.05) < 1e-9);
});
test("idempotency: a discriminator separates two controls; without one the key is unchanged", () => {
  const base = { userId: 7, symbol: "EURUSD", side: "BUY" as const, volume: 0.1, stopLoss: null, takeProfit: null, minuteBucket: 1 };
  assert.equal(buildLiveIdempotencyKey(base), buildLiveIdempotencyKey({ ...base, discriminator: undefined }));
  assert.notEqual(buildLiveIdempotencyKey({ ...base, discriminator: "CANCEL_LIVE_PENDING_ORDER:1" }),
    buildLiveIdempotencyKey({ ...base, discriminator: "CANCEL_LIVE_PENDING_ORDER:2" }));
});

// ── route helpers ──────────────────────────────────────────────────────────
test("one-click: ON dispatches on the press; OFF needs confirmedByUser true", () => {
  assert.equal(C.pendingControlNeedsConfirmation({ oneClickOn: true, confirmedByUser: undefined }), false);
  assert.equal(C.pendingControlNeedsConfirmation({ oneClickOn: false, confirmedByUser: undefined }), true);
  assert.equal(C.pendingControlNeedsConfirmation({ oneClickOn: false, confirmedByUser: "true" }), true);
  assert.equal(C.pendingControlNeedsConfirmation({ oneClickOn: false, confirmedByUser: true }), false);
});
test("modify body: aliases, empties, bad numbers", () => {
  assert.deepEqual(C.parsePendingModifyBody({ price: "1.1", tp: 1.2 }), { ok: true, price: 1.1, stopLoss: null, takeProfit: 1.2 });
  assert.deepEqual(C.parsePendingModifyBody({ stopLoss: 1.05 }), { ok: true, price: null, stopLoss: 1.05, takeProfit: null });
  assert.equal((C.parsePendingModifyBody({}) as { code: string }).code, "NO_CHANGES");
  assert.equal((C.parsePendingModifyBody({ sl: -1 }) as { code: string }).code, "INVALID_STOP_LOSS");
  assert.equal((C.parsePendingModifyBody({ price: "x" }) as { code: string }).code, "INVALID_PRICE");
});
test("refusal status: not-owned answers like not-found; validation 400; state 409", () => {
  assert.equal(C.pendingControlRefusalStatus("PENDING_ORDER_NOT_OWNED"), 404);
  assert.equal(C.pendingControlRefusalStatus("PENDING_PRICE_WRONG_SIDE"), 400);
  assert.equal(C.pendingControlRefusalStatus("PENDING_ORDER_CONTROL_IN_FLIGHT"), 409);
  assert.equal(C.pendingControlRefusalStatus("KILL_SWITCH_ENGAGED"), 409);
});
test("routes: investors refused, confirm+dispatch under the per-user submit lock, through the staged contract", () => {
  const src = readFileSync(join(here, "../../../routes/meLive.ts"), "utf8");
  assert.match(src, /router\.post\("\/me\/live\/pending-orders\/:commandId\/cancel", denyInvestorExecution, requireUser/);
  assert.match(src, /router\.post\("\/me\/live\/pending-orders\/:commandId\/modify", denyInvestorExecution, requireUser/);
  const body = src.slice(src.indexOf("async function runPendingControl"), src.indexOf('router.post("/me/live/pending-orders/:commandId/cancel"'));
  assert.match(body, /draftTrade\(\{ mode: "LIVE", kind: "OPS" \}/);
  assert.match(body, /withUserSubmitLock\(userId, res, async \(\) => \{\s*const conf = await confirmTrade/);
  assert.match(body, /loadAndEvaluateUserMasterLiveAccessGate/);
  assert.match(body, /enforceSensitiveAction/);
  assert.doesNotMatch(body, /createLiveOpsDraft|dispatchLiveCommand/, "never calls the queue directly");
});
