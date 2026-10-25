// Negative fixtures for check-broker-state-single-reader. Pure, no IO.
import assert from "node:assert/strict";
import { scanForBrokerStateViolations } from "./check-broker-state-single-reader.js";

export {};

assert.deepEqual(scanForBrokerStateViolations(`const s = await readLatestUserMt5State(userId);`), []);
assert.deepEqual(scanForBrokerStateViolations(`// legacy: db.select().from(mt5StateTable)`), [], "comments are ignored");
assert.equal(scanForBrokerStateViolations(`const rows = await db.select().from(mt5StateTable).limit(1);`).length, 1);
assert.equal(scanForBrokerStateViolations(`import { db, mt5StateTable } from "@workspace/db";`).length, 1);
assert.equal(scanForBrokerStateViolations("await db.execute(sql`SELECT * FROM mt5_state LIMIT 1`);").length, 1);
assert.deepEqual(scanForBrokerStateViolations(`await db.update(mt5StateTable).set({ equity }).where(eq(mt5StateTable.id, id));`, true), [],
  "the ingest may write");
assert.equal(scanForBrokerStateViolations(`const rows = await db.select().from(mt5StateTable);`, true).length, 1,
  "the ingest may not read around the hub");

console.log("check-broker-state-single-reader fixtures: ok");
