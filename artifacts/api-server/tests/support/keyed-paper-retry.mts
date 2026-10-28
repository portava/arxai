// Child process for the isolated API lane; never run against an existing DB.
import assert from "node:assert/strict";
import { openPaperOrder, getMockPrice, type PaperOpenArgs } from "../../src/lib/tradeEngine/paperVenue.js";

assert.ok(process.env.ISOLATED_API_DIRECT_URL, "requires the disposable isolated lane");
const [userId, paperAccountId] = process.argv.slice(2).map(Number);
assert.ok(Number.isInteger(userId) && userId! > 0);
assert.ok(Number.isInteger(paperAccountId) && paperAccountId! > 0);
const price = getMockPrice("EURUSD", Date.now());
const input: PaperOpenArgs = {
  userId: userId!, paperAccountId: paperAccountId!, symbol: "EURUSD", side: "BUY", orderType: "MARKET",
  lots: 0.01, entryPrice: null, stopLoss: price * 0.97, takeProfit: price * 1.06,
  strategyId: null, tradePlanId: null, decisionId: null, caller: "isolated keyed retry", clientRequestKey: "qa-keyed-retry",
};
const results = await Promise.all(Array.from({ length: 4 }, () => openPaperOrder(input)));
assert.ok(results.every(r => r.ok), JSON.stringify(results));
const ids = results.map(r => { assert.ok(r.ok && r.order); return r.order.id; });
assert.equal(new Set(ids).size, 1);
const replay = await openPaperOrder(input);
assert.ok(replay.ok && replay.order);
assert.equal(replay.order.id, ids[0]);
console.log("KEYED_RETRY_ASSERTIONS_PASSED");
// All assertions and booking promises completed; close the test-only runtime.
process.exit(0);
