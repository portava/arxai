import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

let selectedMode: "public" | "legacy" = "public";
let resolveRead: (rows: unknown[]) => void;
let configured = true;
let capturedMode: string | null = null;
mock.module("../derivFeedClient.js", { namedExports: {
  derivMarketDataConfigured: () => configured,
  derivMarketDataSource: () => selectedMode === "public" ? "deriv_public" : "deriv",
  getDerivFeedClient: () => {
    const mode = selectedMode;
    return { getMode: () => mode, configured: () => configured, ensureConnection: () => {},
      getCandles: async () => { capturedMode = mode; return new Promise(resolve => { resolveRead = resolve; }); } };
  },
} });
const { getDerivCandles } = await import("../derivProvider.js");
beforeEach(() => { selectedMode = "public"; configured = true; capturedMode = null; });

for (const initial of ["public", "legacy"] as const) {
  test(`a deferred ${initial} response retains its captured producer through mode changes`, async () => {
    selectedMode = initial;
    const read = getDerivCandles("V75", "M1", 2);
    assert.equal(capturedMode, initial);
    selectedMode = initial === "public" ? "legacy" : "public";
    // Complete while the configured mode differs from the actual transport.
    resolveRead([{ epoch: 60, open: 100, high: 102, low: 99, close: 101 }]);
    const result = await read;
    assert.equal(result.ok, true);
    assert.equal(result.source, initial === "public" ? "deriv_public" : "deriv");
  });
}

test("public to private to public configuration cannot relabel the private producer", async () => {
  selectedMode = "legacy";
  const read = getDerivCandles("V75", "M1", 2);
  selectedMode = "public";
  resolveRead([{ epoch: 60, open: 100, high: 102, low: 99, close: 101 }]);
  assert.equal((await read).source, "deriv");
});

test("invalid or unsupported requests carry no inferred producer and never fetch", async () => {
  for (const [symbol, tf] of [["unknown", "M1"], ["V75", "W1"]]) {
    const result = await getDerivCandles(symbol!, tf!, 2);
    assert.equal(result.ok, false); assert.equal(result.source, null);
  }
  assert.equal(capturedMode, null);
});

test("unconfigured transport reports its captured source without fetching", async () => {
  configured = false;
  const result = await getDerivCandles("V75", "M1", 2);
  assert.equal(result.ok, false); assert.equal(result.source, "deriv_public");
  assert.equal(capturedMode, null);
});
