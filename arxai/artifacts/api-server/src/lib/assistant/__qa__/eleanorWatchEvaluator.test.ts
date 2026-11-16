// Behavioural tests for the Eleanor watch evaluator (sweep 2026-11-04). The DB is
// an in-memory fake that understands the drizzle conditions the evaluator
// builds (eq / and / isNull, mocked below), so compare-and-set writes behave
// like the real UPDATE … WHERE; positions, quotes, candles, intelligence,
// notifications and the ledger/dispatch wrapper are stubbed.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown> & { id: number };
type Cond = { op: "eq"; col: string; v: unknown } | { op: "isNull"; col: string } | { op: "and"; c: Cond[] };

const tables: Record<string, Row[]> = { watches: [], settings: [], audit: [] };
const col = (table: string) => new Proxy({ __table: table } as Record<string, unknown>, {
  get: (t, p) => (p === "__table" ? t.__table : { table, col: String(p) }),
});
const matches = (r: Row, c: Cond | undefined): boolean => {
  if (!c) return true;
  if (c.op === "and") return c.c.every((x) => matches(r, x));
  if (c.op === "isNull") return r[c.col] == null;
  return r[c.col] === c.v;
};
/** Hook run before each UPDATE is applied (simulates a concurrent writer). */
let beforeUpdate: (() => void) | null = null;
const fakeDb = {
  select: () => ({
    from: (t: { __table: string }) => ({
      where: (c: Cond) => {
        const rows = () => tables[t.__table]!.filter((r) => matches(r, c)).map((r) => ({ ...r }));
        const p = Promise.resolve().then(rows) as Promise<Row[]> & { limit: (n: number) => Promise<Row[]> };
        p.limit = async (n: number) => rows().slice(0, n);
        return p;
      },
    }),
  }),
  update: (t: { __table: string }) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (c: Cond) => {
        const hook = beforeUpdate; beforeUpdate = null; hook?.();
        const hit = tables[t.__table]!.filter((r) => matches(r, c));
        for (const r of hit) Object.assign(r, vals);
        const p = Promise.resolve(hit.map((r) => ({ id: r.id }))) as Promise<Array<{ id: number }>> & { returning: () => Promise<Array<{ id: number }>> };
        p.returning = async () => hit.map((r) => ({ id: r.id }));
        return p;
      },
    }),
  }),
  insert: (t: { __table: string }) => ({ values: async (v: Record<string, unknown>) => { tables[t.__table]!.push({ id: tables[t.__table]!.length + 1, ...v }); } }),
};

mock.module("@workspace/db", {
  namedExports: {
    db: fakeDb,
    eleanorWatchInstructionsTable: col("watches"),
    userOneClickSettingsTable: col("settings"),
    oneClickAuditTable: col("audit"),
  },
});
mock.module("drizzle-orm", {
  namedExports: {
    eq: (c: { col: string }, v: unknown) => ({ op: "eq", col: c.col, v }),
    isNull: (c: { col: string }) => ({ op: "isNull", col: c.col }),
    and: (...c: Cond[]) => ({ op: "and", c }),
  },
});

// ── stubs ────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const BRIDGE = 42;
let positions: Array<{ observedAt: Date | null; row: Record<string, unknown> }> = [];
const positionReads: Array<{ basis?: string }> = [];
let price: number | null = 101;
const priceCalls: Array<{ symbol: string; bridge: number | null }> = [];
let candleSeries: unknown = { ok: false, candles: [] };
const candleCalls: Array<{ bridgeConnectionId?: number | null }> = [];
let reversal = 20;
const intelCalls: Array<{ candlesM15: unknown }> = [];
let notifyStatus: "CREATED" | "UPDATED" | "SKIPPED" = "CREATED";
const notifications: Array<Record<string, unknown>> = [];
let dispatch: (args: { intent: { action: string } }) => Promise<unknown> = async () => ({ duplicate: false, commandRowId: 1, handshakeStatus: "OK", result: { ok: true, commandId: "cmd-1", action: "CLOSE" } });
const dispatches: Array<{ intent: Record<string, unknown> }> = [];
/** Runs during the evaluation, after the watch row was read. */
let duringEval: (() => void) | null = null;

mock.module("../../positions/openPositions.js", {
  namedExports: {
    readOpenPositions: async (o: { basis?: string; symbol?: string }) => {
      positionReads.push({ basis: o.basis });
      const hook = duringEval; duringEval = null; hook?.();
      return positions.filter((p) => p.row["symbol"] === o.symbol);
    },
  },
});
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    routeCandles: async (_s: string, _tf: string, _n: number, o?: { bridgeConnectionId?: number | null }) => { candleCalls.push({ ...o }); return candleSeries; },
    // This line's evaluator reads the pinned decision series.
    routeCandlesForDecision: async (_s: string, _tf: string, o?: { limit?: number; bridgeConnectionId?: number | null }) => { candleCalls.push({ bridgeConnectionId: o?.bridgeConnectionId }); return candleSeries; },
  },
});
mock.module("../../data/feedScope.js", {
  namedExports: {
    runWithFeedScope: (_s: unknown, fn: () => unknown) => fn(),
    feedScopeForUser: () => ({}),
    currentFeedScopeBridge: async () => BRIDGE,
  },
});
mock.module("../../brokerHub/connections.js", { namedExports: { getUserActiveConnection: async () => ({ id: BRIDGE }) } });
mock.module("../../intelligence/scoring.js", {
  namedExports: {
    computeTradeIntelligence: (i: { candlesM15: unknown }) => {
      intelCalls.push({ candlesM15: i.candlesM15 });
      return { scores: { reversalRiskScore: reversal, fakeoutRiskScore: 0 }, recommendedAction: "HOLD" };
    },
  },
});
mock.module("../../data/chart/symbolProfile.js", { namedExports: { getSymbolProfile: () => ({ pricePrecision: 5 }) } });
mock.module("../../notifications/service.js", {
  namedExports: { notify: async (n: Record<string, unknown>) => { notifications.push(n); return { status: notifyStatus, notification: null }; } },
});
mock.module("../assistantName.js", { namedExports: { getAssistantDisplayName: async () => "Eleanor" } });
mock.module("../eleanorExecution.js", {
  namedExports: {
    LATE_ENTRY_TOLERANCE: 0.003,
    ownBridgePriceOf: async (symbol: string, bridge: number | null) => { priceCalls.push({ symbol, bridge }); return price; },
    recordAndExecuteEleanor: async (a: { intent: Record<string, unknown> }) => { dispatches.push({ intent: a.intent }); return dispatch(a as never); },
  },
});

const { evaluateEleanorWatchesForUser, acknowledgeEleanorWatch } = await import("../eleanorWatchEvaluator.js");
const { parseMonitorState, serializeMonitorState, emptyMonitorState, recordAlert, MONITOR_ALERT_COOLDOWN_MS } = await import("../eleanorMonitorPolicy.js");

const USER = 7;
const allOn = { id: 1, userId: USER, eleanorExecutionAuthority: "AI_ASSISTED", allowEleanorMonitor: true, allowEleanorWatchEnter: true, allowEleanorWatchClose: true, allowEleanorOpenCommands: true, allowEleanorCloseCommands: true, allowEleanorModifyCommands: true };
const freshPosition = () => ({
  observedAt: new Date(NOW - 10_000),
  row: { symbol: "EURUSD", brokerTicket: "T1", side: "BUY", volume: 0.1, entryPrice: 100, stopLoss: 90, takeProfit: 120, floatingPl: 5, openedAt: new Date(NOW - 3_600_000) },
});
const monitor = (over: Partial<Row> = {}): Row => ({
  id: 11, userId: USER, kind: "MONITOR_TRADE", accountMode: "live", source: "eleanor_text", symbol: "EURUSD", side: null, lot: null,
  positionTicket: "T1", triggerCondition: null, riskParams: null, rawUserCommand: "monitor my EURUSD", status: "ACTIVE",
  firedAt: null, firedCommandId: null, skipReason: null, expiresAt: null, createdAt: new Date(NOW - 3_600_000), updatedAt: new Date(NOW - 3_600_000),
  ...over,
});
const watchRow = () => tables["watches"]![0]!;
const stateOf = () => parseMonitorState(watchRow()["riskParams"] as string | null);
const run = () => evaluateEleanorWatchesForUser(USER, { trigger: "sweeper", nowMs: NOW });
/** Three alerts already sent, the last one older than the cooldown. */
const threeAlertsRaw = () => {
  let s = emptyMonitorState();
  for (const ago of [3, 2, 1]) {
    s = recordAlert(s, { at: new Date(NOW - ago * MONITOR_ALERT_COOLDOWN_MS - 1000).toISOString(), price: 100, reversalRiskScore: 80, health: "weakening", reason: "r" });
  }
  return serializeMonitorState(s);
};

beforeEach(() => {
  tables["watches"] = []; tables["settings"] = [{ ...allOn }]; tables["audit"] = [];
  positions = [freshPosition()]; positionReads.length = 0;
  price = 101; priceCalls.length = 0;
  candleSeries = { ok: false, candles: [] }; candleCalls.length = 0;
  reversal = 20; intelCalls.length = 0;
  notifyStatus = "CREATED"; notifications.length = 0;
  dispatch = async () => ({ duplicate: false, commandRowId: 1, handshakeStatus: "OK", result: { ok: true, commandId: "cmd-1", action: "CLOSE" } });
  dispatches.length = 0; duringEval = null; beforeUpdate = null;
});

test("reversal evidence → a delivered alert counts; positions on the confirmed-open basis, price from the own bridge", async () => {
  tables["watches"]!.push(monitor());
  reversal = 80;
  const r = await run();
  assert.deepEqual(r.alerted.map((a) => a.alertNumber), [1]);
  assert.equal(stateOf().alertsSinceAck, 1);
  assert.equal(positionReads[0]!.basis, "CONFIRMED_OPEN");
  assert.deepEqual(priceCalls[0], { symbol: "EURUSD", bridge: BRIDGE });
  assert.equal(notifications[0]!["actionUrl"], "/?eleanor=watches");
  assert.equal(dispatches.length, 0);
});

test("a muted (SKIPPED) alert is not counted toward the executive close", async () => {
  tables["watches"]!.push(monitor());
  reversal = 80; notifyStatus = "SKIPPED";
  const r = await run();
  assert.equal(r.alerted.length, 0);
  assert.ok(r.skipped.some((s) => s.reason === "ALERT_NOT_DELIVERED"));
  assert.equal(stateOf().alertsSinceAck, 0);
});

test("no own-bridge price → nothing happens this cycle", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80; price = null;
  const r = await run();
  assert.deepEqual(r.skipped.map((s) => s.reason), ["NO_PRICE"]);
  assert.equal(dispatches.length, 0);
  assert.equal(watchRow()["status"], "ACTIVE");
});

test("candles from another writer are ignored; the candle read is pinned to the own bridge", async () => {
  tables["watches"]!.push(monitor());
  const bars = [{ time: "2026-11-04T11:30:00Z", open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: "2026-11-04T11:45:00Z", open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  candleSeries = { ok: true, candles: bars, provenance: { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 99 } };
  await run();
  assert.equal(candleCalls[0]!.bridgeConnectionId, BRIDGE);
  assert.equal(intelCalls.at(-1)!.candlesM15, null, "a foreign series never reaches the decision");
  intelCalls.length = 0;
  candleSeries = { ok: true, candles: bars, provenance: { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: BRIDGE } };
  await run();
  assert.ok(Array.isArray(intelCalls.at(-1)!.candlesM15));
});

test("a position whose last broker sync is stale is not acted on", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  positions = [{ ...freshPosition(), observedAt: new Date(NOW - 5 * 60_000) }];
  const r = await run();
  assert.deepEqual(r.skipped.map((s) => s.reason), ["POSITION_STALE"]);
  assert.equal(dispatches.length, 0);
});

test("the monitor ends (EXPIRED) when its position is no longer open", async () => {
  tables["watches"]!.push(monitor());
  positions = [];
  const r = await run();
  assert.deepEqual(r.skipped.map((s) => s.reason), ["POSITION_CLOSED"]);
  assert.equal(watchRow()["status"], "EXPIRED");
});

test("a 'keep it' that lands during the evaluation wins: the alert is not counted over it", async () => {
  let s = emptyMonitorState();
  s = recordAlert(s, { at: new Date(NOW - 2 * MONITOR_ALERT_COOLDOWN_MS).toISOString(), price: 100, reversalRiskScore: 80, health: "weakening", reason: "r" });
  tables["watches"]!.push(monitor({ riskParams: serializeMonitorState(s) }));
  reversal = 80;
  duringEval = () => {
    // The trader answers while the evaluator is mid-way.
    watchRow()["riskParams"] = serializeMonitorState({ ...s, alertsSinceAck: 0, keepCount: 1, acknowledgedAt: new Date(NOW).toISOString() });
  };
  const r = await run();
  assert.equal(r.alerted.length, 0);
  assert.ok(r.skipped.some((x) => x.reason === "STATE_CHANGED"));
  assert.equal(stateOf().keepCount, 1);
  assert.equal(stateOf().alertsSinceAck, 0, "the ack survives");
});

test("executive close after three unanswered alerts: claimed, dispatched once, command recorded", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  const r = await run();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0]!.executive, true);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]!.intent["action"], "CLOSE");
  assert.equal(dispatches[0]!.intent["accountMode"], "live");
  assert.equal(watchRow()["status"], "FIRED");
  assert.equal(watchRow()["firedCommandId"], "cmd-1");
});

test("an ack between the decision and the claim makes the close claim miss: nothing is sent", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  beforeUpdate = () => { watchRow()["riskParams"] = serializeMonitorState({ ...parseMonitorState(threeAlertsRaw()), alertsSinceAck: 0, keepCount: 1 }); };
  const r = await run();
  assert.equal(dispatches.length, 0);
  assert.ok(r.skipped.some((x) => x.reason === "STATE_CHANGED"));
  assert.equal(watchRow()["status"], "ACTIVE");
});

test("a refused close returns the monitor to ACTIVE with backoff, notifies, and gives up after three attempts", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  dispatch = async () => ({ duplicate: false, commandRowId: 1, handshakeStatus: "OK", result: { ok: false, httpStatus: 409, error: "MARKET_CLOSED", primaryReason: "MARKET_CLOSED" } });
  let r = await run();
  assert.equal(r.fired[0]!.blocked, "MARKET_CLOSED");
  assert.equal(watchRow()["status"], "ACTIVE", "never left FIRED after a refusal");
  assert.equal(stateOf().closeAttempts, 1);
  assert.ok(notifications.some((n) => n["severity"] === "CRITICAL" && /did not go through: MARKET_CLOSED/.test(String(n["message"]))));
  // Inside the backoff: no new dispatch.
  r = await run();
  assert.deepEqual(r.skipped.map((s) => s.reason), ["CLOSE_BACKOFF"]);
  assert.equal(dispatches.length, 1);
  // After the backoff, two more refusals → the monitor stops (SKIPPED).
  for (const later of [NOW + 61_000, NOW + 61_000 + 121_000]) {
    positions = [{ ...freshPosition(), observedAt: new Date(later - 5_000) }];
    await evaluateEleanorWatchesForUser(USER, { trigger: "sweeper", nowMs: later });
  }
  assert.equal(dispatches.length, 3);
  assert.equal(watchRow()["status"], "SKIPPED");
  assert.match(String(watchRow()["skipReason"]), /CLOSE_REFUSED: MARKET_CLOSED/);
});

test("a dispatch that throws does not leave the monitor FIRED", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  dispatch = async () => { throw new Error("db down"); };
  const r = await run();
  assert.match(r.fired[0]!.blocked!, /DISPATCH_ERROR/);
  assert.equal(watchRow()["status"], "ACTIVE");
});

test("without the pipeline's close permission the monitor never dispatches", async () => {
  tables["settings"] = [{ ...allOn, allowEleanorCloseCommands: false }];
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  reversal = 80;
  const r = await run();
  assert.equal(dispatches.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["ELEANOR_CLOSE_COMMANDS_NOT_ENABLED"]);
  assert.equal(watchRow()["status"], "SKIPPED");
});

test("a demo watch is retired honestly instead of firing into a live-only pipeline", async () => {
  tables["watches"]!.push(monitor({ accountMode: "demo", riskParams: threeAlertsRaw() }));
  reversal = 80;
  const r = await run();
  assert.equal(dispatches.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["LIVE_ACCOUNT_ONLY"]);
  assert.equal(watchRow()["status"], "SKIPPED");
  assert.equal(notifications.length, 1);
});

test("three quiet evaluations end an unanswered run", async () => {
  let s = emptyMonitorState();
  s = recordAlert(s, { at: new Date(NOW - 60_000).toISOString(), price: 100, reversalRiskScore: 80, health: "weakening", reason: "r" });
  tables["watches"]!.push(monitor({ riskParams: serializeMonitorState(s) }));
  reversal = 20;
  for (let i = 0; i < 3; i++) await run();
  assert.equal(stateOf().alertsSinceAck, 0);
  assert.equal(dispatches.length, 0);
});

test("watch-and-enter: a refused entry ends SKIPPED (not FIRED) and the trader is told", async () => {
  tables["watches"]!.push(monitor({ id: 12, kind: "WATCH_AND_ENTER", side: "BUY", lot: 0.01, positionTicket: null, triggerCondition: JSON.stringify({ op: ">=", price: 101 }) }));
  dispatch = async () => ({ duplicate: false, commandRowId: 1, handshakeStatus: "OK", result: { ok: false, httpStatus: 403, error: "ELEANOR_LOT_CAP_EXCEEDED" } });
  const r = await run();
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]!.intent["action"], "BUY");
  assert.equal(r.fired[0]!.blocked, "ELEANOR_LOT_CAP_EXCEEDED");
  assert.equal(watchRow()["status"], "SKIPPED");
  assert.match(String(watchRow()["skipReason"]), /DISPATCH_BLOCKED/);
  assert.ok(notifications.some((n) => n["severity"] === "CRITICAL"));
});

test("watch-and-enter without the open-command permission never dispatches", async () => {
  tables["settings"] = [{ ...allOn, allowEleanorOpenCommands: false }];
  tables["watches"]!.push(monitor({ id: 12, kind: "WATCH_AND_ENTER", side: "BUY", lot: 0.01, positionTicket: null, triggerCondition: JSON.stringify({ op: ">=", price: 101 }) }));
  const r = await run();
  assert.equal(dispatches.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["ELEANOR_OPEN_COMMANDS_NOT_ENABLED"]);
});

test("'keep' acknowledgement resets the count with a compare-and-set write", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  const r = await acknowledgeEleanorWatch(USER, 11, "keep", { trigger: "ack", nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(stateOf().alertsSinceAck, 0);
  assert.equal(stateOf().keepCount, 1);
});

test("'close' acknowledgement dispatches the close through the same gated path", async () => {
  tables["watches"]!.push(monitor({ riskParams: threeAlertsRaw() }));
  const r = await acknowledgeEleanorWatch(USER, 11, "close", { trigger: "ack", nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(dispatches.length, 1);
  assert.equal(watchRow()["status"], "FIRED");
});
