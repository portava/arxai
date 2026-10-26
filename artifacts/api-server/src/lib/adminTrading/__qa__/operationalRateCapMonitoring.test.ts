import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const realDb = await import("@workspace/db");
let count = 3; let auditFails = false; let notificationFails = false; let loggerFails = false;
const rows: Array<Record<string, unknown>> = []; const events: unknown[] = []; const alerts: unknown[] = [];
mock.module("@workspace/db", { namedExports: { ...realDb, db: {
  select: () => ({ from: () => ({ where: async () => [{ c: count }] }) }),
  insert: () => ({ values: (row: Record<string, unknown>) => ({ returning: async () => {
    if (auditFails) throw new Error("audit unavailable"); rows.push(row); return [{ id: 31 }];
  } }) }),
} } });
mock.module("../safetyEnvelope.js", { namedExports: { getEnvelope: async () => ({ tradingMode: "SIMULATED", accountType: "demo" }) } });
mock.module("../../safety/platformSwitches.js", { namedExports: {
  platformStop: async () => ({ engaged: false, sources: [] }), preCheckStopRefusal: (value: unknown) => value,
} });
mock.module("../routingResolver.js", { namedExports: { resolveRouting: async () => ({
  connectionId: null, accountType: "unknown", effectiveRoutingMode: "USER_OWNED_MT5", connectionType: "user_owned",
  virtualAccountId: null, sharedMasterAccountId: null,
}) } });
mock.module("../brokerPlacement.js", { namedExports: { BROKER_PLACEMENT_LAYER_ENABLED: true } });
mock.module("../../riskGovernor/limitSettings.js", { namedExports: { readOperatorRiskLimits: async () => ({
  maxLotSize: 1, allowedSymbols: [], allowedDirection: "both", allowedAccountType: "both", maxTradesPerDay: 3,
}) } });
mock.module("../../riskGovernor/enforce.js", { namedExports: { enforcePreTradeRisk: async () => ({ allowed: true }) } });
mock.module("../../../routes/meAlerts.js", { namedExports: { upsertAlertOnce: async (userId: number, alert: unknown) => {
  assert.equal(rows.at(-1)?.status, "REJECTED", "audit must persist before notification");
  if (notificationFails) throw new Error("private notification error"); alerts.push({ userId, alert });
} } });
mock.module("../../logger.js", { namedExports: { logger: { warn: (event: unknown) => {
  if (loggerFails) throw new Error("logger unavailable"); events.push(event);
} } } });
const { runOrderGuards } = await import("../orderGuard.js");
const request = { userId: 7, symbol: "EURUSD", side: "BUY" as const, lotSize: 0.02,
  requestedBy: "user" as const, confirmedByUser: false, mode: "SIMULATED" as const };
beforeEach(() => { count = 3; auditFails = false; notificationFails = false; loggerFails = false;
  rows.length = 0; events.length = 0; alerts.length = 0; });

test("real order guard persists its rejection before monitoring and retains its exact result", async () => {
  const result = await runOrderGuards(request); await delay(0);
  assert.equal(result.status, "REJECTED"); assert.equal(result.auditLogId, 31);
  assert.equal(result.reason, "OPERATIONAL_RATE_CAP_REACHED:3_APPROVED_COMMANDS_PER_ROLLING_24H");
  assert.equal(rows.length, 1); assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as { userId: number }).userId, request.userId);
  assert.equal((events[0] as { auditLogId: number }).auditLogId, 31);
});
test("audit failure cannot emit a false persisted-refusal alert", async () => {
  auditFails = true; await assert.rejects(runOrderGuards(request), /audit unavailable/); await delay(0);
  assert.equal(events.length, 0); assert.equal(alerts.length, 0);
});
test("notification and logging failure cannot turn a refusal into approval or throw", async () => {
  notificationFails = true; loggerFails = true;
  const result = await runOrderGuards(request); await delay(0);
  assert.equal(result.status, "REJECTED"); assert.equal(result.auditLogId, 31);
});
test("other refusals and approved paper requests do not create rate-cap alerts", async () => {
  const refused = await runOrderGuards({ ...request, lotSize: 2 }); await delay(0);
  assert.equal(refused.reason, "LOT_EXCEEDS_LIMIT:1");
  count = 0; const approved = await runOrderGuards(request); await delay(0);
  assert.equal(approved.status, "APPROVED"); assert.equal(events.length, 0); assert.equal(alerts.length, 0);
});
