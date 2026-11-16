// Demo pending orders (EA v1.32) + demo command delivery fixes, offline.
//
//   - status vocabulary: PLACED_DEMO / CANCELLED_DEMO transitions;
//   - version gate: pending commands need EA >= 1.32, everything else 1.26;
//   - pending payload contract (MT5 rules, EA keys);
//   - poll: oldest-sent first, per-command TTL, expired rows not served;
//   - expiry sweep selects only rows the EA has not reported on;
//   - result scoping: another bridge's report is NOT_FOUND;
//   - late fill after the sweep is recorded and flagged, not 409-orphaned;
//   - the Guardian never schedules on a placed order ticket;
//   - the trade pipeline emits entry / stopLimitPrice / expirationEpoch for
//     DEMO and LIVE pending orders.
//
// The database is a fake; no row, broker or network is touched.
// Run: pnpm --filter @workspace/api-server run test:demo-pending-orders

import { mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

// Fake db for the reconciler: one row; updates are recorded and applied.
let fakeRow: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];
const chain = (result: () => unknown) => {
  const c: Record<string, unknown> = {};
  for (const k of ["from", "where", "orderBy", "set"]) c[k] = () => c;
  c["limit"] = async () => result();
  c["returning"] = async () => result();
  c["then"] = (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(result()).then(res, rej);
  return c;
};
const fakeDb = {
  select: () => chain(() => (fakeRow ? [fakeRow] : [])),
  update: () => {
    let patch: Record<string, unknown> = {};
    const c = chain(() => {
      updates.push(patch);
      if (!fakeRow) return [];
      fakeRow = { ...fakeRow, ...patch };
      return [fakeRow];
    });
    c["set"] = (p: Record<string, unknown>) => { patch = p; return c; };
    return c;
  },
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
const events: Array<Record<string, unknown>> = [];
mock.module("../../security/events.js", {
  namedExports: { recordSecurityEvent: async (e: Record<string, unknown>) => { events.push(e); return null; } },
});

// Trade pipeline venues: record the drafted payloads.
const drafts: Array<{ venue: string; args: Record<string, unknown> }> = [];
mock.module("../demoCommandQueue.js", {
  namedExports: {
    createDraftCommand: async (args: Record<string, unknown>) => {
      drafts.push({ venue: "DEMO", args });
      return { ok: true, command: { commandId: "dmcmd_qa", status: "USER_CONFIRMATION_REQUIRED" } };
    },
    confirmCommand: async () => ({ ok: true, command: { commandId: "dmcmd_qa", status: "DEMO_APPROVED" } }),
    dispatchApprovedCommand: async () => ({ ok: true, command: { commandId: "dmcmd_qa", status: "SENT_TO_MT5_DEMO" } }),
  },
});
mock.module("../../live/liveCommandPipeline.js", {
  namedExports: {
    createLiveDraft: async (args: Record<string, unknown>) => {
      drafts.push({ venue: "LIVE", args });
      return { ok: true, command: { commandId: "lvcmd_qa" } };
    },
    confirmLiveCommand: async () => ({ ok: true }),
    dispatchLiveCommand: async () => ({ ok: true, command: { status: "SENT_TO_MT5_LIVE" } }),
  },
});

const em = await import("@workspace/domain/safety-contracts/executionMode");
const { normaliseDemoPendingPayload, cancelPendingTicket } = await import("../demoPendingOrder.js");
const contract = await import("../demoBridgeContract.js");
const { reconcileBrokerResult } = await import("../demoCommandReconciler.js");
const { submitTrade } = await import("../../tradeEngine/pipeline.js");
const { fromMt5DemoStatus } = await import("@workspace/domain/execution-state");

// ── status vocabulary ──────────────────────────────────────────────────────
test("PLACED_DEMO / CANCELLED_DEMO transitions", () => {
  const ok = em.isValidDemoCommandTransition;
  assert.ok(ok("SENT_TO_MT5_DEMO", "PLACED_DEMO"));
  assert.ok(ok("SENT_TO_MT5_DEMO", "CANCELLED_DEMO"));
  assert.ok(ok("PLACED_DEMO", "FILLED_DEMO"));
  assert.ok(ok("PLACED_DEMO", "CANCELLED_DEMO"));
  assert.ok(ok("PLACED_DEMO", "FAILED"));
  assert.ok(!ok("DEMO_APPROVED", "PLACED_DEMO"), "never placed without being sent");
  assert.ok(!ok("PLACED_DEMO", "SENT_TO_MT5_DEMO"));
  assert.deepEqual(em.DEMO_COMMAND_TRANSITIONS.CANCELLED_DEMO, []);
  assert.deepEqual(em.DEMO_COMMAND_TRANSITIONS.FAILED, [], "FAILED stays terminal in the table; late results have their own rule");
  assert.ok(em.DEMO_COMMAND_STATUSES.includes("PLACED_DEMO") && em.DEMO_COMMAND_STATUSES.includes("CANCELLED_DEMO"));
  assert.equal(fromMt5DemoStatus("PLACED_DEMO").state, "acknowledged");
  assert.equal(fromMt5DemoStatus("CANCELLED_DEMO").state, "cancelled");
});

test("result status must fit the command type", () => {
  const fits = em.demoResultStatusFitsCommand;
  assert.ok(fits("PLACE_PENDING_ORDER", "PLACED_DEMO"));
  assert.ok(!fits("PLACE_PENDING_ORDER", "FILLED_DEMO"));
  assert.ok(fits("CANCEL_PENDING_ORDER", "CANCELLED_DEMO"));
  assert.ok(!fits("CANCEL_PENDING_ORDER", "FILLED_DEMO"));
  assert.ok(!fits("PLACE_MARKET_ORDER", "PLACED_DEMO"));
  for (const t of ["PLACE_MARKET_ORDER", "CLOSE_POSITION", "MODIFY_SLTP"]) assert.ok(fits(t, "FILLED_DEMO"));
  for (const t of ["PLACE_PENDING_ORDER", "CANCEL_PENDING_ORDER", "PLACE_MARKET_ORDER"]) {
    assert.ok(fits(t, "REJECTED") && fits(t, "FAILED"));
  }
});

// ── version gate ───────────────────────────────────────────────────────────
test("pending commands need EA >= 1.32; others keep the 1.26 minimum", () => {
  const gate = em.demoCommandEaVersionBlocker;
  for (const t of ["PLACE_PENDING_ORDER", "CANCEL_PENDING_ORDER"]) {
    assert.equal(gate(t, "1.31"), `EA_VERSION_TOO_OLD_FOR_COMMAND:${t}:1.31<1.32`);
    assert.equal(gate(t, null), `EA_VERSION_TOO_OLD_FOR_COMMAND:${t}:unknown<1.32`);
    assert.equal(gate(t, "1.32"), null);
    assert.equal(gate(t, "1.40"), null);
    assert.equal(gate(t, "2.0"), null);
  }
  for (const t of ["PLACE_MARKET_ORDER", "CLOSE_POSITION", "MODIFY_SLTP"]) {
    assert.equal(gate(t, "1.26"), null);
    assert.equal(gate(t, "1.31"), null);
    assert.match(gate(t, "1.25")!, /<1\.26$/);
  }
  assert.equal(em.EA_MIN_DEMO_VERSION, "1.26");
  assert.equal(em.minEaVersionForDemoCommand("CANCEL_PENDING_ORDER"), "1.32");
});

// ── pending payload contract ───────────────────────────────────────────────
test("pending payload: canonical type, side, entry mirror, stop-limit and expiry", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const r = normaliseDemoPendingPayload({
    symbol: "EURUSD", side: "BUY", lotSize: 0.02, orderType: "buy stop limit", price: 1.105,
    stopLimitPrice: 1.103, stopLoss: 1.095, takeProfit: 1.12, expiration: "2026-11-04T13:00:00Z",
  }, now);
  assert.ok(r.ok);
  assert.deepEqual(
    { t: r.payload["orderType"], s: r.payload["side"], p: r.payload["price"], e: r.payload["entry"], l: r.payload["stopLimitPrice"], x: r.payload["expirationEpoch"] },
    { t: "BUY_STOP_LIMIT", s: "BUY", p: 1.105, e: 1.105, l: 1.103, x: Date.parse("2026-11-04T13:00:00Z") / 1000 },
  );
  const lim = normaliseDemoPendingPayload({ symbol: "EURUSD", orderType: "SELL_LIMIT", entry: 1.2, stopLimitPrice: 9 }, now);
  assert.ok(lim.ok && lim.payload["side"] === "SELL" && !("stopLimitPrice" in lim.payload) && !("expirationEpoch" in lim.payload),
    "stop-limit price dropped for a plain limit; no expiry = GTC");
  const refuse = (p: Record<string, unknown>) => { const x = normaliseDemoPendingPayload(p, now); return x.ok ? "OK" : x.reason; };
  assert.equal(refuse({ orderType: "MARKET_BUY", price: 1.1 }), "PENDING_ORDER_TYPE_REQUIRED");
  assert.equal(refuse({ orderType: "NOPE", price: 1.1 }), "PENDING_ORDER_TYPE_REQUIRED");
  assert.equal(refuse({ orderType: "BUY_LIMIT", side: "SELL", price: 1.1 }), "ORDER_TYPE_SIDE_MISMATCH");
  assert.equal(refuse({ orderType: "BUY_LIMIT" }), "MISSING_PENDING_PRICE");
  assert.equal(refuse({ orderType: "BUY_STOP_LIMIT", price: 1.1 }), "MISSING_STOP_LIMIT_PRICE");
  assert.equal(refuse({ orderType: "BUY_STOP_LIMIT", price: 1.1, stopLimitPrice: 1.2 }), "STOP_LIMIT_PRICE_WRONG_SIDE");
  assert.equal(refuse({ orderType: "BUY_LIMIT", price: 1.1, stopLoss: 1.2 }), "STOP_LOSS_WRONG_SIDE");
  assert.equal(refuse({ orderType: "SELL_STOP", price: 1.1, takeProfit: 1.2 }), "TAKE_PROFIT_WRONG_SIDE");
  assert.equal(refuse({ orderType: "BUY_LIMIT", price: 1.1, expirationEpoch: now / 1000 - 1 }), "EXPIRATION_IN_PAST");
  assert.equal(refuse({ orderType: "BUY_LIMIT", price: 1.1, expiration: "not a date" }), "INVALID_EXPIRATION");
  assert.equal(cancelPendingTicket({ orderTicket: "5001" }), "5001");
  assert.equal(cancelPendingTicket({ ticket: 5001 }), "5001");
  assert.equal(cancelPendingTicket({ orderTicket: "50.01" }), null);
  assert.equal(cancelPendingTicket({ orderTicket: "-1" }), null);
});

// ── poll ───────────────────────────────────────────────────────────────────
test("poll serves oldest-sent first with a TTL and drops expired rows", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const at = (s: number) => new Date(now.getTime() - s * 1000);
  const row = (commandId: string, sentAgo: number | null) => ({
    commandId, commandType: "PLACE_MARKET_ORDER", payload: { lot: 0.01 },
    sentAt: sentAgo == null ? null : at(sentAgo), eaVersionAtDispatch: "1.32",
  });
  const out = contract.buildDemoPollCommands(
    [row("c-new", 5), row("c-expired", 125), row("c-old", 90), row("c-unsent", null), row("c-edge", 119.5)],
    now, 120_000,
  );
  assert.deepEqual(out.map((c) => c.commandId), ["c-old", "c-new"], "edge (<1 s left), expired and unsent rows are not served");
  assert.equal(out[0]!.secondsUntilExpiry, 30);
  assert.equal(out[1]!.secondsUntilExpiry, 115);
  assert.equal(out[0]!.expiresAtEpoch, Math.floor((at(90).getTime() + 120_000) / 1000));
  assert.deepEqual(out[0]!.payload, { lot: 0.01, volume: 0.01 }, "volume/lot mirror kept");
});

test("expiry sweep selects only SENT rows with no EA report, past the cutoff", () => {
  const cutoff = new Date("2026-11-04T12:00:00Z");
  const before = new Date(cutoff.getTime() - 1000);
  const base = { status: "SENT_TO_MT5_DEMO", sentAt: before, terminalAt: null, filledAt: null, brokerTicket: null };
  const rows = [
    { id: "stale", ...base },
    { id: "fresh", ...base, sentAt: new Date(cutoff.getTime() + 1000) },
    { id: "reported-ticket", ...base, brokerTicket: "42" },
    { id: "reported-terminal", ...base, terminalAt: before },
    { id: "reported-filled", ...base, filledAt: before },
    { id: "placed", ...base, status: "PLACED_DEMO" },
    { id: "unsent", ...base, sentAt: null },
  ];
  assert.deepEqual(contract.selectExpirableSentRows(rows, cutoff).map((r) => r.id), ["stale"]);
});

// ── reconcile decisions ────────────────────────────────────────────────────
test("result scoping: only the bridge the command was sent to may report", () => {
  const row = { status: "SENT_TO_MT5_DEMO", reason: null, commandType: "PLACE_MARKET_ORDER", bridgeConnectionId: 7 };
  assert.deepEqual(contract.decideDemoReconcile(row, "FILLED_DEMO", 8), { kind: "NOT_FOUND" });
  assert.equal(contract.decideDemoReconcile(row, "FILLED_DEMO", 7).kind, "APPLY");
  assert.deepEqual(contract.decideDemoReconcile(null, "FILLED_DEMO", 7), { kind: "NOT_FOUND" });
});

test("reconcile decisions: idempotent, type fit, late success after the sweep only", () => {
  const d = contract.decideDemoReconcile;
  const sent = (commandType: string) => ({ status: "SENT_TO_MT5_DEMO", reason: null, commandType, bridgeConnectionId: 1 });
  assert.deepEqual(d(sent("PLACE_PENDING_ORDER"), "PLACED_DEMO", 1), { kind: "APPLY", expectedStatus: "SENT_TO_MT5_DEMO", lateAfterExpiry: false });
  assert.equal(d(sent("PLACE_PENDING_ORDER"), "FILLED_DEMO", 1).kind, "REFUSE");
  assert.equal(d(sent("CANCEL_PENDING_ORDER"), "CANCELLED_DEMO", 1).kind, "APPLY");
  assert.equal(d(sent("PLACE_MARKET_ORDER"), "PLACED_DEMO", 1).kind, "REFUSE");
  assert.deepEqual(d({ ...sent("PLACE_MARKET_ORDER"), status: "FILLED_DEMO" }, "FILLED_DEMO", 1), { kind: "IDEMPOTENT" });
  const swept = { status: "FAILED", reason: "EXPIRED_DEMO_NO_EA_RESULT", commandType: "PLACE_MARKET_ORDER", bridgeConnectionId: 1 };
  assert.deepEqual(d(swept, "FILLED_DEMO", 1), { kind: "APPLY", expectedStatus: "FAILED", lateAfterExpiry: true });
  assert.deepEqual(d({ ...swept, reason: "EXPIRED_DEMO_NO_EA_PICKUP_2MIN" }, "FILLED_DEMO", 1).kind, "APPLY", "older sweep reason also qualifies");
  assert.deepEqual(d({ ...swept, commandType: "PLACE_PENDING_ORDER" }, "PLACED_DEMO", 1).kind, "APPLY");
  assert.equal(d(swept, "REJECTED", 1).kind, "REFUSE", "a late refusal changes nothing");
  assert.equal(d({ ...swept, reason: "BROKER_OUTCOME_UNCONFIRMED_DO_NOT_RETRY" }, "FILLED_DEMO", 1).kind, "REFUSE", "an EA FAILED stays final");
  assert.equal(d({ ...swept, status: "REJECTED" }, "FILLED_DEMO", 1).kind, "REFUSE");
  assert.equal(d({ ...swept, status: "PLACED_DEMO", commandType: "PLACE_PENDING_ORDER" }, "CANCELLED_DEMO", 1).kind, "REFUSE",
    "a PLACE row is cancelled only through its CANCEL command");
});

test("Guardian never schedules on a placed order ticket", () => {
  const g = contract.guardianTicketForResult;
  assert.equal(g({ status: "PLACED_DEMO", commandType: "PLACE_PENDING_ORDER", brokerTicket: "5001", payload: {} }), null);
  assert.equal(g({ status: "FILLED_DEMO", commandType: "PLACE_PENDING_ORDER", brokerTicket: "5001", payload: {} }), null);
  assert.equal(g({ status: "CANCELLED_DEMO", commandType: "CANCEL_PENDING_ORDER", brokerTicket: "5001", payload: { ticket: "5001" } }), null);
  assert.equal(g({ status: "FILLED_DEMO", commandType: "PLACE_MARKET_ORDER", brokerTicket: "42", payload: {} }), "42");
  assert.equal(g({ status: "FILLED_DEMO", commandType: "CLOSE_POSITION", brokerTicket: null, payload: { ticket: "42" } }), "42");
});

// ── reconciler with a fake row ─────────────────────────────────────────────
const baseRow = (patch: Record<string, unknown>) => ({
  id: 1, commandId: "dmcmd_1", userId: 9, bridgeConnectionId: 7, commandType: "PLACE_MARKET_ORDER",
  status: "SENT_TO_MT5_DEMO", reason: null, payload: {}, safetyGateSnapshot: {}, brokerTicket: null, ...patch,
});

test("reconciler: another bridge's report is NOT_FOUND and writes nothing", async () => {
  fakeRow = baseRow({}); updates.length = 0; events.length = 0;
  const r = await reconcileBrokerResult({ userId: 9, bridgeConnectionId: 8, commandId: "dmcmd_1", brokerResult: { status: "FILLED_DEMO", brokerTicket: "42" } });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "COMMAND_NOT_FOUND" });
  assert.equal(updates.length, 0);
  assert.equal(events[0]?.["eventType"], "DEMO_RECONCILE_REFUSED");
});

test("reconciler: a fill arriving after the sweep is recorded and flagged", async () => {
  fakeRow = baseRow({ status: "FAILED", reason: "EXPIRED_DEMO_NO_EA_RESULT" }); updates.length = 0; events.length = 0;
  const r = await reconcileBrokerResult({
    userId: 9, bridgeConnectionId: 7, commandId: "dmcmd_1",
    brokerResult: { status: "FILLED_DEMO", brokerTicket: "42", filledPrice: 1.1, filledVolume: 0.02, reason: "OK" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "LATE_FILLED_DEMO");
  assert.equal(r.command?.status, "FILLED_DEMO");
  assert.equal(r.command?.brokerTicket, "42");
  assert.equal(r.command?.fillVolume, 0.02);
  assert.match(String(r.command?.reason), /^LATE_RESULT_AFTER_EXPIRY:/);
  assert.equal((r.command?.brokerRawResult as Record<string, unknown>)["lateAfterExpiry"], true);
  assert.equal(events[0]?.["eventType"], "DEMO_COMMAND_LATE_RESULT_AFTER_EXPIRY");
});

test("reconciler: PLACED_DEMO is an order, not a fill", async () => {
  fakeRow = baseRow({ commandType: "PLACE_PENDING_ORDER" }); updates.length = 0;
  const r = await reconcileBrokerResult({
    userId: 9, bridgeConnectionId: 7, commandId: "dmcmd_1",
    brokerResult: { status: "PLACED_DEMO", brokerTicket: "5001", filledPrice: 1.1, filledVolume: 0.02 },
  });
  assert.equal(r.command?.status, "PLACED_DEMO");
  assert.equal(r.command?.brokerTicket, "5001");
  assert.equal(r.command?.brokerOrderId, "5001");
  assert.equal(r.command?.fillPrice, null);
  assert.equal(r.command?.fillVolume, null);
  assert.equal(r.command?.terminalAt, null);
  assert.ok(!("filledAt" in updates[0]!));
  assert.deepEqual((r.command?.brokerRawResult as Record<string, unknown>)["orderPrice"], 1.1);
});

test("reconciler: a cancel also retires the PLACE row for that order ticket", async () => {
  fakeRow = baseRow({ commandType: "CANCEL_PENDING_ORDER", payload: { orderTicket: "5001" } }); updates.length = 0;
  const r = await reconcileBrokerResult({
    userId: 9, bridgeConnectionId: 7, commandId: "dmcmd_1", brokerResult: { status: "CANCELLED_DEMO", brokerTicket: "5001" },
  });
  assert.equal(r.ok, true);
  assert.equal(updates.length, 2, "cancel row + PLACE row");
  assert.equal(updates[1]!["status"], "CANCELLED_DEMO");
  assert.equal(updates[1]!["reason"], "CANCELLED_BY:dmcmd_1");
});

// ── trade pipeline payloads ────────────────────────────────────────────────
test("DEMO and LIVE pending opens carry entry / stopLimitPrice / expirationEpoch", async () => {
  drafts.length = 0;
  const pending = { orderType: "BUY_STOP_LIMIT", price: 1.105, stopLimitPrice: 1.103, expirationEpoch: 1_800_000_000 };
  const demo = await submitTrade({ mode: "DEMO", intent: "OPEN", userId: 9, symbol: "EURUSD", side: "BUY", lots: 0.02, pending, stopLoss: 1.09, takeProfit: 1.12, sourcePage: "QA" });
  assert.equal(demo.ok, true);
  const live = await submitTrade({ mode: "LIVE", intent: "OPEN", userId: 9, symbol: "EURUSD", side: "BUY", lots: 0.02, pending, stopLoss: 1.09, takeProfit: 1.12, sourcePage: "QA" });
  assert.equal(live.ok, true);
  const d = drafts.find((x) => x.venue === "DEMO")!.args;
  assert.equal(d["commandType"], "PLACE_PENDING_ORDER");
  assert.deepEqual(
    (({ orderType, price, entry, stopLimitPrice, expirationEpoch }) => ({ orderType, price, entry, stopLimitPrice, expirationEpoch }))(d["payload"] as Record<string, unknown>),
    { orderType: "BUY_STOP_LIMIT", price: 1.105, entry: 1.105, stopLimitPrice: 1.103, expirationEpoch: 1_800_000_000 },
  );
  const l = drafts.find((x) => x.venue === "LIVE")!.args;
  assert.equal(l["commandType"], "PLACE_LIVE_PENDING_ORDER");
  assert.deepEqual(
    (({ price, entry, stopLimitPrice, expirationEpoch }) => ({ price, entry, stopLimitPrice, expirationEpoch }))(l["payload"] as Record<string, unknown>),
    { price: 1.105, entry: 1.105, stopLimitPrice: 1.103, expirationEpoch: 1_800_000_000 },
  );
  drafts.length = 0;
  await submitTrade({ mode: "DEMO", intent: "OPEN", userId: 9, symbol: "EURUSD", side: "SELL", lots: 0.02, pending: { orderType: "SELL_LIMIT", price: 1.2 }, stopLoss: null, takeProfit: null, sourcePage: "QA" });
  const p = drafts[0]!.args["payload"] as Record<string, unknown>;
  assert.ok(!("stopLimitPrice" in p) && !("expirationEpoch" in p), "GTC limit carries no stop-limit or expiry");
});
