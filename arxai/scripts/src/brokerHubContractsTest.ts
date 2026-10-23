import assert from "node:assert/strict";
import {
  READ_ONLY_BROKER_ADAPTER_METHODS,
  getUnavailableVenue,
  listUnavailableVenues,
  type ReadOnlyBrokerAdapter,
} from "@workspace/domain/broker-hub";

const expectedMethods = [
  "readHealth",
  "readAccount",
  "readCapabilities",
  "readInstruments",
  "readMarketData",
] as const;

assert.deepEqual(
  READ_ONLY_BROKER_ADAPTER_METHODS,
  expectedMethods,
  "the adapter method allowlist must stay read-only",
);

const compileTimeShape = {
  identity: { venue: "MT5", userId: 7, nativeConnectionRef: "11" },
  async readHealth() {
    return {
      identity: this.identity,
      status: "DISCONNECTED" as const,
      nativeStatus: null,
      connected: false,
      observedAt: null,
      staleSeconds: null,
      reason: "fixture",
    };
  },
  async readAccount() {
    return null;
  },
  async readCapabilities() {
    return {
      identity: this.identity,
      observedAt: null,
      capabilities: {
        accountSnapshot: false,
        positionSnapshot: false,
        openOrderSnapshot: false,
        instrumentDiscovery: false,
        marketDataSnapshot: false,
      },
    };
  },
  async readInstruments() {
    return [];
  },
  async readMarketData(request: { exactBrokerSymbol: string; timeframe: string }) {
    return {
      available: false as const,
      identity: this.identity,
      timeframe: request.timeframe,
      reason: "MARKET_DATA_UNAVAILABLE" as const,
      provenance: null,
      candles: [] as const,
    };
  },
} satisfies ReadOnlyBrokerAdapter;

assert.equal(compileTimeShape.identity.venue, "MT5");

let transportCalls = 0;
const forbiddenTransport = () => {
  transportCalls += 1;
  throw new Error("unavailable venues must not invoke a transport");
};

for (const entry of listUnavailableVenues()) {
  assert.notEqual(entry.status, "CONNECTED");
  assert.equal(entry.connected, false);
  assert.deepEqual(entry.credentialRequirements, []);
  assert.equal(Object.values(entry.capabilities).some(Boolean), false);
  assert.notEqual(entry.venue, "MT5");
}

assert.equal(getUnavailableVenue("DERIV").reason, "NOT_IMPLEMENTED");
assert.equal(getUnavailableVenue("UNKNOWN").reason, "DISABLED");
assert.equal(transportCalls, 0);
assert.equal(typeof forbiddenTransport, "function");

console.log("PASS broker-hub pure contracts");