import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOperationalRateCapMonitor, type AuditedOrderOutcome, type RateCapAlert } from "../operationalRateCapMonitor.js";

const input: AuditedOrderOutcome = { userId: 7, auditLogId: 31, status: "REJECTED", mode: "SIMULATED",
  reason: "OPERATIONAL_RATE_CAP_REACHED:3_APPROVED_COMMANDS_PER_ROLLING_24H" };
const flush = () => delay(0);
function fixture(options: Parameters<typeof createOperationalRateCapMonitor>[1] = {}) {
  const events: unknown[] = []; const alerts: Array<{ userId: number; alert: RateCapAlert }> = [];
  const deps = { emit: (event: unknown) => { events.push(event); },
    notify: async (userId: number, alert: RateCapAlert) => { alerts.push({ userId, alert }); } };
  return { events, alerts, deps, report: createOperationalRateCapMonitor(deps, { now: () => 0, ...options }) };
}

test("a persisted rate-cap refusal emits a stable event and owner-scoped dashboard alert", async () => {
  const f = fixture(); f.report(input); await flush();
  assert.deepEqual(f.events, [{ event: "OPERATIONAL_RATE_CAP_REACHED", userId: 7, auditLogId: 31,
    mode: "SIMULATED", cap: 3, windowHours: 24, observedAt: "1970-01-01T00:00:00.000Z" }]);
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0].userId, 7);
  assert.equal(f.alerts[0].alert.alertType, "operational_rate_cap");
  assert.match(f.alerts[0].alert.message, /3 approved commands in a rolling 24-hour window/);
  assert.match(f.alerts[0].alert.message, /separate from the daily trade limit/);
  assert.equal(f.alerts[0].alert.severity, "warning");
});

test("approved outcomes, other refusal reasons, invalid identities and malformed codes do not alert", async () => {
  const f = fixture();
  for (const patch of [
    { status: "APPROVED" }, { userId: 0 }, { userId: NaN }, { userId: 1.5 }, { auditLogId: 0 },
    { mode: "UNKNOWN" }, { reason: null }, { reason: "RISK_GOVERNOR_BLOCK:trading_discipline" },
    { reason: "OPERATIONAL_RATE_CAP_REACHED:0_APPROVED_COMMANDS_PER_ROLLING_24H" },
    { reason: "OPERATIONAL_RATE_CAP_REACHED:3_APPROVED_COMMANDS_PER_ROLLING_24H token=secret" },
  ]) f.report({ ...input, ...patch });
  await flush(); assert.deepEqual(f.events, []); assert.deepEqual(f.alerts, []);
});

test("each supported mode observes refusals without implying broker execution", async () => {
  const f = fixture();
  for (const [index, mode] of ["SIMULATED", "DEMO", "LIVE"].entries()) f.report({ ...input, userId: index + 1, mode });
  await flush(); assert.equal(f.events.length, 3); assert.equal(f.alerts.length, 3);
  assert.ok(f.alerts.every(a => a.alert.message.endsWith("The rejected request was not approved.")));
});

test("concurrent refusals preserve every audit signal and coalesce delivery only for the same owner", async () => {
  const f = fixture(); let release!: () => void;
  f.deps.notify = async (userId, alert) => { f.alerts.push({ userId, alert }); await new Promise<void>(r => { release = r; }); };
  f.report(input); f.report({ ...input, auditLogId: 32 }); await flush();
  assert.equal(f.events.length, 2); assert.equal(f.alerts.length, 1);
  release(); await flush(); f.report({ ...input, auditLogId: 33 }); await flush();
  assert.equal(f.alerts.length, 2); release(); await flush();
});

test("timeout keeps one pending write per owner and bounds global in-flight delivery", async () => {
  const f = fixture({ timeoutMs: 5, maxPending: 1 }); let release!: () => void;
  f.deps.notify = async (userId, alert) => { f.alerts.push({ userId, alert }); await new Promise<void>(r => { release = r; }); };
  f.report(input); await delay(15); f.report({ ...input, auditLogId: 32 });
  f.report({ ...input, userId: 8, auditLogId: 33 }); await flush();
  assert.equal(f.alerts.length, 1);
  assert.match(JSON.stringify(f.events), /DELIVERY_TIMEOUT/); assert.match(JSON.stringify(f.events), /CAPACITY_REACHED/);
  release(); await flush(); f.report({ ...input, userId: 8, auditLogId: 34 }); await flush();
  assert.equal(f.alerts.at(-1)?.userId, 8); release(); await flush();
});

test("notification errors are redacted, release capacity and do not throw", async () => {
  const f = fixture(); f.deps.notify = async () => { throw new Error("password=secret account=private"); };
  assert.doesNotThrow(() => f.report(input)); await flush();
  assert.match(JSON.stringify(f.events), /DELIVERY_FAILED/);
  assert.doesNotMatch(JSON.stringify(f.events), /password|secret|private/);
  f.deps.notify = async (userId, alert) => { f.alerts.push({ userId, alert }); };
  f.report(input); await flush(); assert.equal(f.alerts.length, 1);
});

test("a broken log sink does not prevent dashboard delivery or escape to the order guard", async () => {
  const f = fixture(); f.deps.emit = () => { throw new Error("logger down"); };
  assert.doesNotThrow(() => f.report(input)); await flush(); assert.equal(f.alerts.length, 1);
});
