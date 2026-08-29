// Capability #46 — escape route builder: no-fabrication proofs.
//
// Proven here (offline, no DB):
//   * every identity value on the page is sourced or explicitly unavailable —
//     a null broker/server/account yields flagged UNKNOWN-value steps and an
//     `unavailable` entry, never an invented name,
//   * account identifiers are masked, never raw,
//   * position staleness is computed against the injected clock and an empty
//     confirmed-positions history carries a typed reason,
//   * a failed connections read degrades to a page that still renders the
//     emergency procedure with the failure stated.
//
// Run: pnpm --filter @workspace/api-server run test:escape-route

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEscapeRoutePage, type EscapeRouteConnectionInput } from "../escapeRoute.js";

const NOW = new Date("2026-08-29T12:00:00Z");

function conn(over: Partial<EscapeRouteConnectionInput>): EscapeRouteConnectionInput {
  return {
    connectionId: 1,
    connectionName: "Main",
    brokerName: "Deriv Ltd",
    serverName: "DerivSVG-Server-02",
    accountNumber: "12345678",
    accountCurrency: "USD",
    mode: "LIVE",
    accountType: "real",
    lastHeartbeat: NOW,
    lastPositionsSnapshotAt: NOW,
    ...over,
  };
}

test("fully-reported connection: real values flow into the steps, nothing flagged", () => {
  const page = buildEscapeRoutePage({ connections: [conn({})], positionsByConnection: new Map(), now: NOW });
  const c = page.connections[0]!;
  assert.equal(c.brokerName, "Deriv Ltd");
  assert.equal(c.serverName, "DerivSVG-Server-02");
  assert.equal(c.maskedAccountIdentifier, "****5678");
  assert.equal(c.environment, "LIVE");
  assert.equal(c.directAccessInstructions.length, 5);
  assert.ok(c.directAccessInstructions.every((s) => s.usesUnknownValue === false));
  const serverStep = c.directAccessInstructions.find((s) => s.title.includes("server"))!;
  assert.match(serverStep.detail, /DerivSVG-Server-02/);
});

test("raw account number NEVER appears anywhere on the page", () => {
  const page = buildEscapeRoutePage({ connections: [conn({})], positionsByConnection: new Map(), now: NOW });
  assert.equal(JSON.stringify(page).includes("12345678"), false);
});

test("unreported identity: flagged steps + unavailable reasons, no invention", () => {
  const page = buildEscapeRoutePage({
    connections: [conn({ brokerName: null, serverName: null, accountNumber: null, mode: null, accountType: null })],
    positionsByConnection: new Map(),
    now: NOW,
  });
  const c = page.connections[0]!;
  assert.equal(c.brokerName, null);
  assert.equal(c.serverName, null);
  assert.equal(c.maskedAccountIdentifier, null);
  assert.equal(c.environment, "UNKNOWN");
  assert.ok(c.unavailable.some((u) => u.startsWith("brokerName")));
  assert.ok(c.unavailable.some((u) => u.startsWith("serverName")));
  assert.ok(c.unavailable.some((u) => u.startsWith("accountIdentifier")));
  // The three identity-dependent steps admit the unknown instead of guessing.
  const flagged = c.directAccessInstructions.filter((s) => s.usesUnknownValue);
  assert.equal(flagged.length, 3);
  for (const s of flagged) assert.match(s.detail, /not (been )?reported|account-opening email/i);
});

test("last-confirmed positions: staleness from the injected clock", () => {
  const fresh = new Map([[1, [{
    brokerTicket: "T1", symbol: "V75", side: "BUY", volume: 0.1, entryPrice: 100,
    currentPrice: 101, stopLoss: 99, takeProfit: 105, floatingPl: 1, lastSyncedAt: NOW,
  }]]]);
  const page = buildEscapeRoutePage({ connections: [conn({})], positionsByConnection: fresh, now: NOW });
  const lc = page.connections[0]!.lastConfirmedPositions;
  assert.equal(lc.positions.length, 1);
  assert.equal(lc.stale, false);
  assert.equal(lc.unavailableReason, null);

  const old = new Date(NOW.getTime() - 10 * 60_000);
  const stalePage = buildEscapeRoutePage({
    connections: [conn({ lastPositionsSnapshotAt: old })],
    positionsByConnection: new Map([[1, [{
      brokerTicket: "T1", symbol: "V75", side: "BUY", volume: 0.1, entryPrice: 100,
      currentPrice: null, stopLoss: null, takeProfit: null, floatingPl: null, lastSyncedAt: old,
    }]]]),
    now: NOW,
  });
  assert.equal(stalePage.connections[0]!.lastConfirmedPositions.stale, true);
});

test("no snapshot ever confirmed → typed reason, null asOf", () => {
  const page = buildEscapeRoutePage({
    connections: [conn({ lastPositionsSnapshotAt: null })],
    positionsByConnection: new Map(),
    now: NOW,
  });
  const lc = page.connections[0]!.lastConfirmedPositions;
  assert.equal(lc.asOf, null);
  assert.equal(lc.stale, null);
  assert.match(lc.unavailableReason ?? "", /No positions snapshot/);
});

test("failed connections read: emergency procedure still renders with the failure stated", () => {
  const page = buildEscapeRoutePage({
    connections: [],
    positionsByConnection: new Map(),
    now: NOW,
    connectionsUnavailableReason: "Connection metadata could not be read",
  });
  assert.equal(page.connections.length, 0);
  assert.match(page.connectionsUnavailableReason ?? "", /could not be read/);
  assert.equal(page.emergencyProcedure.length, 5);
  assert.match(page.nonCustodyStatement, /never holds your funds/);
});
