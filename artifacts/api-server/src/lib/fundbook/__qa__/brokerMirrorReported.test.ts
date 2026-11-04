// Broker mirror truth: a bridge that never reported its balance / equity is
// sent as 0 (the response fields are non-null numbers), so the admin overview
// summed it as a real $0.00 with no way to tell it apart. Each bridge now
// also says whether the EA actually reported those figures.
//
// Requires Node's experimental module-mock flag.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const connections = [
  { id: 1, userId: 10, connectionName: "a", status: "CONNECTED", accountType: "DEMO", accountBalance: 1000, accountEquity: 1010, margin: 0, freeMargin: 1010, accountCurrency: "USD", lastHeartbeat: new Date(), lastPositionsSnapshotAt: null },
  { id: 2, userId: 11, connectionName: "b", status: "CONNECTED", accountType: "DEMO", accountBalance: null, accountEquity: null, margin: null, freeMargin: null, accountCurrency: null, lastHeartbeat: new Date(), lastPositionsSnapshotAt: null },
  { id: 3, userId: 12, connectionName: "c", status: "CONNECTED", accountType: "DEMO", accountBalance: 500, accountEquity: null, margin: null, freeMargin: null, accountCurrency: "USD", lastHeartbeat: null, lastPositionsSnapshotAt: null },
];

mock.module("../../brokerHub/connections.js", {
  namedExports: { listConnections: async () => connections },
});
mock.module("../../positions/ledger.js", {
  namedExports: { readOpenLivePositionsWithPools: async () => [] },
});

const { getBrokerMirror } = await import("../brokerMirror.js");

test("each bridge says whether its balance and equity were actually reported", async () => {
  const { bridges } = await getBrokerMirror(Date.now());
  const byId = new Map(bridges.map((b) => [b.bridgeConnectionId, b]));
  assert.equal(byId.get(1)!.accountEquityReported, true);
  assert.equal(byId.get(1)!.accountBalanceReported, true);
  assert.equal(byId.get(2)!.accountEquityReported, false);
  assert.equal(byId.get(2)!.accountBalanceReported, false);
  assert.equal(byId.get(3)!.accountEquityReported, false);
  assert.equal(byId.get(3)!.accountBalanceReported, true);
});

test("the existing numeric fields are unchanged (additive only)", async () => {
  const { bridges } = await getBrokerMirror(Date.now());
  const b2 = bridges.find((b) => b.bridgeConnectionId === 2)!;
  assert.equal(b2.accountEquity, 0);
  assert.equal(b2.accountBalance, 0);
});
