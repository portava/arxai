// Negative fixtures for check-broker-read-adapter-single-factory. Pure, no IO.
import assert from "node:assert/strict";
import { FACTORY, scanFactory, scanFile } from "./check-broker-read-adapter-single-factory.js";

export {};

assert.deepEqual(scanFile(FACTORY, `return new Mt5ReadOnlyAdapter(mt5ProjectionReader, u, c);`), []);
assert.equal(scanFile("lib/riskGovernor/enforce.ts", `const a = new Mt5ReadOnlyAdapter(r, u, c);`).length, 1);
assert.equal(scanFile("routes/x.ts", `const a = new DerivReadOnlyAdapter(derivFeedReader, u);`).length, 1);
assert.deepEqual(scanFile("routes/x.ts", `const a = brokerReadAdapter({ venue: "DERIV", userId });`), []);
assert.deepEqual(scanFile("routes/x.ts", `// new Mt5ReadOnlyAdapter(r, u, c) used to live here`), []);

assert.deepEqual(scanFactory(`BROKER_READ_VENUES = ["MT5", "DERIV"] as const;\ncase "MT5": x;\ncase "DERIV": y;`), []);
assert.deepEqual(scanFactory(`BROKER_READ_VENUES = ["MT5", "OANDA"] as const;\ncase "MT5": x;`), ["venue OANDA has no adapter case"]);
assert.deepEqual(scanFactory(`const venues = [];`), ["BROKER_READ_VENUES not found"]);

console.log("check-broker-read-adapter-single-factory fixtures: ok");
