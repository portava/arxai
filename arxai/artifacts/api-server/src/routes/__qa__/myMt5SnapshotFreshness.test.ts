// my-mt5 "Snapshot: fresh" is computed from the ACCOUNT snapshot's age.
//
// accountSnapshotFresh used to be the heartbeat's fresh band, so an EA that
// heartbeats every few seconds but last synced balance/equity 10 minutes ago
// showed "Snapshot: fresh" beside stale balance and equity.
import { test } from "node:test";
import assert from "node:assert/strict";

const { serializeConnection } = await import("../meMt5Connections.js");
type Row = Parameters<typeof serializeConnection>[0];

function row(heartbeatAgoMs: number | null, syncedAgoMs: number | null): Row {
  const now = Date.now();
  return {
    id: 1, userId: 7, connectionName: "My EA", brokerName: "Broker", serverName: "Srv",
    accountNumber: "12345678", accountCurrency: "USD", accountBalance: 1000, accountEquity: 1000,
    margin: 0, freeMargin: 1000, leverage: 100, accountType: "demo", status: "active",
    lastHeartbeat: heartbeatAgoMs == null ? null : new Date(now - heartbeatAgoMs),
    accountSyncedAt: syncedAgoMs == null ? null : new Date(now - syncedAgoMs),
    tokenLast4: "abcd", tokenCreatedAt: new Date(now - 86_400_000), tokenRevokedAt: null,
    readOnlyMode: true, allowOrderExecution: false, liveLocked: true, mode: "DEMO",
    createdAt: new Date(now - 86_400_000), updatedAt: new Date(now),
  } as unknown as Row;
}

test("fresh heartbeat but account snapshot 10 minutes old → not fresh", () => {
  const out = serializeConnection(row(2_000, 600_000));
  assert.equal(out.accountSnapshotFresh, false);
  assert.equal(out.accountSnapshotAgeSeconds, 600);
});

test("never synced → not fresh, age null", () => {
  const out = serializeConnection(row(2_000, null));
  assert.equal(out.accountSnapshotFresh, false);
  assert.equal(out.accountSnapshotAgeSeconds, null);
  assert.equal(out.accountSyncedAt, null);
});

test("fresh heartbeat and a recent account sync → fresh", () => {
  const out = serializeConnection(row(2_000, 5_000));
  assert.equal(out.accountSnapshotFresh, true);
});

test("a recent account sync with a stale heartbeat stays not fresh (no weakening)", () => {
  const out = serializeConnection(row(45_000, 5_000));
  assert.equal(out.accountSnapshotFresh, false);
});
