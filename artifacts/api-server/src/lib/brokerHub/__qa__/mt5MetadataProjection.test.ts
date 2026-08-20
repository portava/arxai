import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMt5Metadata,
  projectMt5MetadataIfEnabled,
} from "../mt5MetadataProjection.js";
import type { Mt5OwnedConnection } from "../mt5ReadOnlyAdapter.js";

const connection: Mt5OwnedConnection = {
  id: 41, userId: 7, status: "connected", lastHeartbeat: new Date(),
  accountNumber: "12345678", brokerName: "Broker", serverName: "Server",
  accountCurrency: "USD", accountBalance: 1, accountEquity: 1, margin: 0,
  freeMargin: 1, accountSyncedAt: new Date(), leverage: 100, mode: "LIVE",
  accountType: "real", capabilitiesReportedAt: new Date(),
};

test("MT5 metadata projection preserves native status but never enables broker behavior", () => {
  const result = projectMt5Metadata({
    userId: 7, connection, discoveryObservedAt: new Date("2026-08-19T00:00:00Z"),
  });
  assert.equal(result.status, "DISABLED");
  assert.equal(result.adapterNativeStatus, "connected");
  assert.equal(result.accountRefMasked, "12••••78");
  assert.equal(result.metadataEnabled, false);
  assert.equal(result.tradingEnabled, false);
  assert.equal(result.automationEnabled, false);
  assert.equal(result.canPlaceLiveTrade, false);
  assert.equal(JSON.stringify(result).includes("12345678"), false);
});

test("absent and revoked MT5 evidence remain unavailable without a bridge mutation", () => {
  assert.equal(projectMt5Metadata({
    userId: 8, connection: null, discoveryObservedAt: null,
  }).status, "DISCONNECTED");
  assert.equal(projectMt5Metadata({
    userId: 7, connection: { ...connection, status: "revoked" }, discoveryObservedAt: null,
  }).status, "REAUTH_REQUIRED");
});

test("the metadata projection surface remains off by default", () => {
  const input = { userId: 7, connection, discoveryObservedAt: null };
  assert.equal(projectMt5MetadataIfEnabled(input, {}), null);
  assert.equal(
    projectMt5MetadataIfEnabled(input, { ARX_BROKER_HUB_READONLY_ENABLED: "true" })
      ?.metadataEnabled,
    false,
  );
});

test("mismatched and ownerless MT5 evidence is rejected fail-closed", () => {
  for (const evidenceUserId of [8, null]) {
    assert.throws(
      () => projectMt5Metadata({
        userId: 7,
        connection: { ...connection, userId: evidenceUserId },
        discoveryObservedAt: null,
      }),
      /MT5_METADATA_OWNER_MISMATCH/,
    );
  }
});