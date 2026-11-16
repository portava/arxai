// Owner decision 17 — the Risk Governor's broker status uses the shared MT5
// heartbeat policy. Imports enforce.ts (which imports @workspace/db), so it
// runs in ci:integration; it reads no rows.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrokerHeartbeat, evaluatePreTradeRisk, resolveEffectiveLimits, type RiskContext } from "../enforce.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const at = (ageMs: number) => classifyBrokerHeartbeat({ status: "connected", lastHeartbeat: new Date(NOW.getTime() - ageMs) }, NOW);

test("broker status bands: < 15 s CONNECTED, 15–60 s DEGRADED, >= 60 s DISCONNECTED", () => {
  assert.equal(at(14_999).status, "CONNECTED");
  // Was CONNECTED up to 30 s before the decision.
  assert.equal(at(15_000).status, "DEGRADED");
  assert.equal(at(59_999).status, "DEGRADED");
  // Was DEGRADED (closing allowed) up to 120 s before the decision.
  assert.equal(at(60_000).status, "DISCONNECTED");
  assert.equal(at(119_000).status, "DISCONNECTED");
});

test("missing, revoked and future-dated heartbeats are DISCONNECTED", () => {
  assert.equal(classifyBrokerHeartbeat(null, NOW).status, "DISCONNECTED");
  assert.equal(classifyBrokerHeartbeat({ status: "connected", lastHeartbeat: null }, NOW).status, "DISCONNECTED");
  assert.equal(classifyBrokerHeartbeat({ status: "revoked", lastHeartbeat: NOW }, NOW).status, "DISCONNECTED");
  const future = at(-5_000);
  assert.equal(future.status, "DISCONNECTED");
  assert.match(future.detail, /invalid/);
  assert.equal(classifyBrokerHeartbeat({ status: "connected", lastHeartbeat: new Date(Number.NaN) }, NOW).status, "DISCONNECTED");
});


test("close eligibility retains the historical inclusive 120s boundary without changing status or permitting new risk", () => {
  const intent = { userId: 1, venue: "DEMO" as const, origin: "manual" as const, action: "CLOSE" as const,
    symbol: "EURUSD", side: "BUY" as const, lots: 0.1 };
  for (const age of [0, 14_999, 15_000, 59_999, 60_000, 119_999, 120_000, 120_001]) {
    const ctx: RiskContext = { now: NOW, limits: resolveEffectiveLimits({}), account: null,
      instruments: {}, positions: [], inFlight: [], quote: null, daily: { realizedPnl: 0, floatingPnl: 0 }, broker: at(age) };
    const close = evaluatePreTradeRisk(intent, ctx);
    assert.equal(close.blockedBy.includes("broker_unavailable"), age > 120_000, `age ${age}`);
    if (age >= 15_000) assert.ok(evaluatePreTradeRisk({ ...intent, action: "OPEN" }, ctx).blockedBy.includes("broker_unavailable"));
  }
  for (const status of ["revoked", "disconnected", "unknown"]) {
    const broker = classifyBrokerHeartbeat({ status, lastHeartbeat: new Date(NOW.getTime() - 90_000) }, NOW);
    assert.equal(broker.closeAllowedUntil ?? null, null, status);
  }
  assert.equal(at(-1).closeAllowedUntil ?? null, null);
  assert.equal(classifyBrokerHeartbeat(null, NOW).closeAllowedUntil ?? null, null);
});
