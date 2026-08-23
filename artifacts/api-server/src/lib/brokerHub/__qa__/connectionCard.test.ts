// Spec §3.1 connection card. The properties that matter are not "the fields
// exist" but: withdrawal can never be granted, market-data and trading health
// are genuinely SEPARATE signals, the state resolves most-restrictive-first,
// and anything without a source says so instead of guessing.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectionCard,
  resolveConnectionState,
  maskAccountIdentifier,
  type ConnectionCardInput,
} from "../connectionCard.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const fresh = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);

function input(over: Partial<ConnectionCardInput> = {}): ConnectionCardInput {
  return {
    connectionName: "My MT5", status: "connected", accountNumber: "1234567",
    brokerName: "SomeBroker", serverName: "Some-Server", accountCurrency: "USD",
    mode: "DEMO", accountType: "demo", eaVersion: "1.55",
    lastHeartbeat: fresh(5), lastPositionsSnapshotAt: fresh(5),
    clockDriftSeconds: 0, readOnlyMode: false, allowOrderExecution: true,
    tokenRevokedAt: null, tokenRotatedAt: null,
    allocationStatus: "active", tradingFrozen: false, closeOnlyMode: false,
    allocatedFunds: 1000, approvedForMasterLive: true, masterLiveStatus: "approved",
    lastReconciledAt: fresh(30), now: NOW, ...over,
  };
}

test("withdrawal permission is a typed literal false — it can never be granted", () => {
  const card = buildConnectionCard(input());
  assert.equal(card.permissions.withdrawal, false);
  // Even on a fully healthy, approved, live connection.
  const live = buildConnectionCard(input({ mode: "LIVE", accountType: "live" }));
  assert.equal(live.permissions.withdrawal, false);
});

test("the account identifier is masked, never returned raw", () => {
  assert.equal(maskAccountIdentifier("1234567"), "***4567");
  assert.equal(maskAccountIdentifier("12"), "**");
  assert.equal(maskAccountIdentifier(null), null);
  const card = buildConnectionCard(input());
  assert.equal(card.maskedAccountIdentifier, "***4567");
  assert.ok(!JSON.stringify(card).includes("1234567"), "the raw account number must not appear anywhere on the card");
});

test("market-data health and trading health are SEPARATE signals (spec §3.1)", () => {
  // Data flowing, but the EA is armed read-only: data healthy, trading not.
  const readOnly = buildConnectionCard(input({ readOnlyMode: true }));
  assert.equal(readOnly.marketDataHealth, "HEALTHY");
  assert.equal(readOnly.tradingHealth, "READ_ONLY");

  // Permission fine, but telemetry has stopped: trading ready, data stale.
  const noData = buildConnectionCard(input({ lastPositionsSnapshotAt: fresh(600) }));
  assert.equal(noData.marketDataHealth, "STALE");
  assert.equal(noData.tradingHealth, "READY");
});

test("state resolves MOST-RESTRICTIVE-first — never a reassuring state over a restrictive one", () => {
  // A revoked token beats a perfectly fresh heartbeat.
  assert.equal(resolveConnectionState(input({ tokenRevokedAt: fresh(1) })), "REVOKED");
  // A freeze beats a healthy connection.
  assert.equal(resolveConnectionState(input({ allocationStatus: "frozen" })), "FROZEN");
  // Close-only and trading-frozen both surface as PAUSED.
  assert.equal(resolveConnectionState(input({ closeOnlyMode: true })), "PAUSED");
  assert.equal(resolveConnectionState(input({ tradingFrozen: true })), "PAUSED");
});

test("a stale or absent heartbeat is never CONNECTED", () => {
  assert.equal(resolveConnectionState(input({ lastHeartbeat: fresh(600) })), "DEGRADED");
  assert.equal(resolveConnectionState(input({ lastHeartbeat: null })), "DISCONNECTED");
});

test("an untrustworthy clock DEGRADES a live connection", () => {
  // Every downstream freshness decision keys off timestamps, so a drifting
  // clock must not present as fully connected.
  assert.equal(resolveConnectionState(input({ clockDriftSeconds: 42 })), "DEGRADED");
  assert.equal(resolveConnectionState(input({ clockDriftSeconds: -42 })), "DEGRADED");
  assert.equal(resolveConnectionState(input({ clockDriftSeconds: 1 })), "CONNECTED");
});

test("a frozen/revoked connection reports trading BLOCKED, not READY", () => {
  for (const over of [
    { tokenRevokedAt: fresh(1) }, { allocationStatus: "frozen" },
    { closeOnlyMode: true }, { status: "error" },
  ]) {
    assert.equal(buildConnectionCard(input(over)).tradingHealth, "BLOCKED", JSON.stringify(over));
  }
});

test("missing sources are declared in `unavailable`, never guessed", () => {
  const bare = buildConnectionCard(input({
    lastPositionsSnapshotAt: null, readOnlyMode: null, allowOrderExecution: null,
    mode: null, accountType: null, lastReconciledAt: null, brokerName: null,
  }));
  assert.equal(bare.marketDataHealth, "UNKNOWN");
  assert.equal(bare.tradingHealth, "UNKNOWN");
  assert.equal(bare.environment, "UNKNOWN");
  const joined = bare.unavailable.join(" | ");
  for (const field of ["marketDataHealth", "tradingHealth", "environment", "lastReconciledAt", "legalEntity"]) {
    assert.ok(joined.includes(field), `${field} must declare why it is unavailable`);
  }
});

test("auto-trading is OFF for every card — Phase 1 has no automation", () => {
  assert.equal(buildConnectionCard(input()).autoTradingState, "OFF");
  assert.equal(buildConnectionCard(input({ mode: "LIVE", accountType: "live" })).autoTradingState, "OFF");
});

test("approval state distinguishes NOT_APPROVED from UNKNOWN", () => {
  assert.equal(buildConnectionCard(input({ approvedForMasterLive: true })).approvalState, "APPROVED");
  assert.equal(buildConnectionCard(input({ approvedForMasterLive: false })).approvalState, "NOT_APPROVED");
  // Absent evidence must NOT read as a denial — it reads as unknown.
  assert.equal(buildConnectionCard(input({ approvedForMasterLive: null })).approvalState, "UNKNOWN");
});

// ── Route wiring (the projection must not be dead code) ─────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const routeSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../routes/meBrokerHub.ts"),
  "utf8",
);

test("the card projection is actually served by a list route", () => {
  assert.match(routeSrc, /router\.get\("\/me\/broker-hub\/connections",\s*requireUser/);
  assert.match(routeSrc, /buildConnectionCard\(/);
});

test("every card query is scoped to the authenticated user", () => {
  const start = routeSrc.indexOf('router.get("/me/broker-hub/connections",');
  const block = routeSrc.slice(start, routeSrc.indexOf("router.get", start + 10));
  // Three per-user reads plus the reconciliation lookup must all filter by
  // the session user — a card set leaking another user's connection would be
  // a per-user isolation breach, not just a display bug.
  assert.match(block, /eq\(mt5ConnectionTable\.userId, userId\)/);
  assert.match(block, /eq\(userSlotAllocationTable\.userId, userId\)/);
  assert.match(block, /eq\(userMasterLiveAccessTable\.userId, userId\)/);
  assert.match(block, /user_id = \$\{userId\}/);
  assert.ok(!/req\.(query|body|params)\.userId/.test(block), "userId must never come from the request");
});

test("the list route advertises no order submission (Phase 1 is read-only)", () => {
  const start = routeSrc.indexOf('router.get("/me/broker-hub/connections",');
  const block = routeSrc.slice(start, routeSrc.indexOf("router.get", start + 10));
  assert.match(block, /orderSubmissionAvailable: false/);
});
