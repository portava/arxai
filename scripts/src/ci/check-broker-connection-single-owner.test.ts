// Negative fixtures for check-broker-connection-single-owner. Pure, no IO.
import assert from "node:assert/strict";
import { scanForBrokerConnectionViolations as scan } from "./check-broker-connection-single-owner.js";

export {};

assert.deepEqual(scan(`const c = await getUserConnection(userId, id);`), []);
assert.deepEqual(scan(`// was: db.select().from(mt5ConnectionTable)`), [], "comments are ignored");
assert.equal(scan(`const rows = await db.select().from(mt5ConnectionTable);`).length, 1, "drizzle read");
assert.equal(scan(`import { db, mt5ConnectionTable } from "@workspace/db";`).length, 1, "import");
assert.equal(scan(`type Row = typeof mt5ConnectionTable.$inferSelect;`).length, 1, "type-only use");
assert.equal(scan("const r = await pool.query(`SELECT id FROM mt5_connection WHERE user_id = $1`);").length, 1, "raw SQL");
assert.deepEqual(scan("const r = await pool.query(`SELECT id FROM mt5_connection_audit`);"), [], "other tables named alike");
assert.equal(scan(`const has = !!conn.apiKeyHash;`).length, 1, "token hash read");
assert.deepEqual(scan(`const has = conn.hasBridgeToken;`), []);

console.log("check-broker-connection-single-owner fixtures: ok");
