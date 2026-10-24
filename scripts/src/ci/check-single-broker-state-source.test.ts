// Negative fixtures for check-single-broker-state-source. Pure, no IO.
import assert from "node:assert/strict";
import { ALLOWLIST, STATE_TABLES, scanFile, scanForBrokerStateTables } from "./check-single-broker-state-source.js";

export {};

// The hub owners may touch their tables.
assert.deepEqual(scanFile("lib/brokerHub/brokerHealthState.ts", `await db.select().from(brokerHealthStateTable).limit(1);`).violations, []);

// A raw drizzle read outside the hub fails, naming the owner.
const raw = scanFile("lib/alerts/ruleEngine.ts", `const rows = await db.select().from(brokerHealthStateTable).limit(1);`);
assert.equal(raw.violations.length, 1);
assert.match(raw.violations[0]!, /broker_health_state.*lib\/brokerHub\/brokerHealthState\.ts/);

// Raw SQL counts too, quoted or not.
assert.equal(scanFile("routes/x.ts", "await db.execute(sql`SELECT * FROM broker_health_logs`);").violations.length, 1);
assert.equal(scanFile("routes/x.ts", 'await db.execute(sql`UPDATE "broker_readonly_snapshots" SET x=1`);').violations.length, 1);
assert.equal(scanFile("routes/x.ts", `import { brokerReadonlyLogsTable } from "@workspace/db";`).violations.length, 1);

// Type-only use is still direct coupling to the table.
assert.equal(scanFile("routes/x.ts", `type S = typeof brokerHealthStateTable.$inferSelect;`).violations.length, 1);

// Comments, string lists of table names, and longer names do not match.
assert.deepEqual(scanFile("routes/x.ts", `// brokerHealthStateTable used to be read here`).violations, []);
assert.deepEqual(scanFile("lib/systemHealth/health.ts", `const TABLES = ["broker_health_state", "x"];`).violations, []);
assert.deepEqual(scanForBrokerStateTables(`select * from broker_health_state_archive`), []);

// Hub reads are fine.
assert.deepEqual(scanFile("routes/x.ts", `const s = await readBrokerHealthState();`).violations, []);

// Allowlisted files may touch only their named tables.
const pool = scanFile("routes/adminAllocations.ts", `await db.update(arxMasterBridgePoolTable).set({})`);
assert.deepEqual(pool.violations, []);
assert.equal(pool.allowUsed, true);
const wrong = scanFile("routes/adminAllocations.ts", `await db.select().from(brokerHealthStateTable)`);
assert.equal(wrong.violations.length, 1);
assert.equal(wrong.allowUsed, false);

// A "write" entry may insert/update but never select; reads go back through the hub.
assert.deepEqual(scanFile("routes/brokerHealth.ts", `await db.insert(brokerHealthLogsTable).values({});`).violations, []);
assert.deepEqual(scanFile("routes/brokerHealth.ts", `await writer.update(brokerHealthStateTable).set(patch).where(eq(brokerHealthStateTable.id, id));`).violations, []);
const writerRead = scanFile("routes/brokerHealth.ts", `const rows = await tx.select().from(brokerHealthStateTable).limit(1);`);
assert.equal(writerRead.violations.length, 1);
assert.match(writerRead.violations[0]!, /writer reads the table directly/);
assert.equal(scanFile("lib/brokerReadOnly/service.ts", `db.select().from(brokerReadonlySnapshotsTable)`).violations.length, 1);
assert.equal(scanFile("lib/brokerReadOnly/service.ts", "await db.execute(sql`SELECT 1 FROM broker_readonly_logs`)").violations.length, 1);
assert.equal(scanFile("lib/brokerReadOnly/service.ts", `.innerJoin(brokerReadonlyLogsTable, x)`).violations.length, 1);
assert.deepEqual(scanFile("lib/brokerReadOnly/service.ts", `await db.insert(brokerReadonlySnapshotsTable).values({ userId });`).violations, []);
// A writer for one table is not a writer for another.
assert.equal(scanFile("lib/brokerReadOnly/service.ts", `await db.insert(brokerHealthLogsTable).values({});`).violations.length, 1);

// A new pool reader outside the allowlist fails.
assert.equal(scanFile("routes/meSharedAccount.ts", `db.select().from(arxMasterBridgePoolTable)`).violations.length, 1);

// Every allowlisted table is a guarded table, and every entry gives a reason.
const known = new Set(STATE_TABLES.map((t) => t.sql));
for (const [file, e] of Object.entries(ALLOWLIST)) {
  assert.ok(e.reason.length > 10, `${file} needs a reason`);
  assert.ok(e.access === "write" || e.access === "readwrite", `${file}: access must be write or readwrite`);
  for (const t of e.tables) assert.ok(known.has(t), `${file}: ${t} is not a guarded table`);
}

console.log("check-single-broker-state-source fixtures: ok");
