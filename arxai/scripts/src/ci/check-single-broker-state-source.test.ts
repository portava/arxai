// Negative fixtures for check-single-broker-state-source. Pure, no IO.
import assert from "node:assert/strict";
import { ALLOWLIST, STATE_TABLES, scanFile, scanForBrokerStateTables, statementLocksRow } from "./check-single-broker-state-source.js";

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
const pool = scanFile("lib/safety/sharedLivePause.ts", `await db.update(arxMasterBridgePoolTable).set({})`);
assert.deepEqual(pool.violations, []);
assert.equal(pool.allowUsed, true);
const wrong = scanFile("lib/safety/sharedLivePause.ts", `await db.select().from(brokerHealthStateTable)`);
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

// ── arx_master_bridge_pool: one hub reader; the LIVE projection owner and the admin pause route only write ──
const poolOwner = STATE_TABLES.find((t) => t.sql === "arx_master_bridge_pool")!.owner;
assert.equal(poolOwner, "lib/brokerHub/masterBridgePoolReader.ts");
assert.deepEqual(scanFile(poolOwner, `await db.select().from(arxMasterBridgePoolTable).where(eq(arxMasterBridgePoolTable.masterConnectionId, id)).limit(1);`).violations, []);
// The projection owner may upsert but not read the row directly (whole row or columns).
assert.deepEqual(scanFile("lib/live/masterBridgePool.ts", `const [u] = await db.update(arxMasterBridgePoolTable).set(v).where(eq(arxMasterBridgePoolTable.id, e.id)).returning();`).violations, []);
assert.deepEqual(scanFile("lib/live/masterBridgePool.ts", `const [i] = await db.insert(arxMasterBridgePoolTable).values(v).returning();`).violations, []);
const ownerRead = scanFile("lib/live/masterBridgePool.ts", `const rows = await db.select().from(arxMasterBridgePoolTable)\n  .where(eq(arxMasterBridgePoolTable.masterConnectionId, id)).limit(1);`);
assert.equal(ownerRead.violations.length, 1);
assert.match(ownerRead.violations[0]!, /writer reads the table directly; read it back through lib\/brokerHub\/masterBridgePoolReader\.ts/);
// The shared-live pause authority (owner decision 19): column-select read and
// raw SQL read both fail; its scoped pause/resume update and its own row-locked
// read pass. The admin route no longer touches the table.
assert.equal(scanFile("lib/safety/sharedLivePause.ts", `const o = await db.select({ id: arxMasterBridgePoolTable.id })\n  .from(arxMasterBridgePoolTable)\n  .where(eq(arxMasterBridgePoolTable.isOverAllocated, true));`).violations.length, 1);
assert.equal(scanFile("lib/safety/sharedLivePause.ts", "await db.execute(sql`SELECT id FROM arx_master_bridge_pool WHERE is_over_allocated`)").violations.length, 1);
assert.deepEqual(scanFile("lib/safety/sharedLivePause.ts", `await tx.update(arxMasterBridgePoolTable).set({ sharedLivePaused: true }).where(eq(arxMasterBridgePoolTable.id, scope.poolId)).returning();`).violations, []);
assert.deepEqual(scanFile("lib/safety/sharedLivePause.ts", `const [row] = await tx.select().from(arxMasterBridgePoolTable)\n  .where(eq(arxMasterBridgePoolTable.id, scope.poolId)).for("update");`).violations, []);
assert.equal(scanFile("routes/adminAllocations.ts", `await db.update(arxMasterBridgePoolTable).set({ sharedLivePaused: true }).where(eq(arxMasterBridgePoolTable.id, pool.id)).returning();`).violations.length, 1);
// A row lock does not excuse a pool read: only lockingReads entries get that.
assert.equal(scanFile("lib/live/masterBridgePool.ts", `await tx.select().from(arxMasterBridgePoolTable).for("update");`).violations.length, 1);
// Raw SQL and type-only use elsewhere fail.
assert.equal(scanFile("routes/x.ts", "await db.execute(sql`select * from \"arx_master_bridge_pool\"`)").violations.length, 1);
assert.equal(scanFile("routes/x.ts", `type P = typeof arxMasterBridgePoolTable.$inferSelect;`).violations.length, 1);
assert.deepEqual(scanFile("routes/x.ts", `const p = await readMasterBridgePoolByMaster(id);`).violations, []);

// ── bridge_v2_stream_state: one hub reader; ingest writes (locking read-modify-write only) ──
const streamOwner = STATE_TABLES.find((t) => t.sql === "bridge_v2_stream_state")!.owner;
assert.equal(streamOwner, "lib/brokerHub/bridgeV2StreamState.ts");
assert.deepEqual(scanFile(streamOwner, `return db.select().from(bridgeV2StreamStateTable).where(scope(userId));`).violations, []);
// Status derivation and the admin trace no longer read the table.
const statusRead = scanFile("lib/bridgeV2/status.ts", `const rows = await db\n  .select()\n  .from(bridgeV2StreamStateTable)\n  .where(eq(bridgeV2StreamStateTable.userId, userId));`);
assert.equal(statusRead.violations.length >= 1, true);
assert.match(statusRead.violations[0]!, /bridge_v2_stream_state.*lib\/brokerHub\/bridgeV2StreamState\.ts/);
assert.equal(scanFile("routes/bridgeV2.ts", `.from(bridgeV2StreamStateTable).orderBy(desc(bridgeV2StreamStateTable.updatedAt))`).violations.length, 1);
assert.equal(scanFile("lib/bridgeV2/status.ts", `type StreamRow = typeof bridgeV2StreamStateTable.$inferSelect;`).violations.length, 1);
assert.equal(scanFile("routes/x.ts", "await db.execute(sql`SELECT count(*) FROM bridge_v2_stream_state`)").violations.length, 1);
assert.deepEqual(scanFile("lib/bridgeV2/status.ts", `const rows = await listBridgeV2StreamStates(userId);`).violations, []);
// Ingest: seed insert, counter update and the locked read pass...
assert.deepEqual(scanFile("lib/bridgeV2/ingest.ts", `await tx.insert(bridgeV2StreamStateTable).values(v).onConflictDoNothing();`).violations, []);
assert.deepEqual(scanFile("lib/bridgeV2/ingest.ts", `await tx.update(bridgeV2StreamStateTable).set(v);`).violations, []);
assert.deepEqual(scanFile("lib/bridgeV2/ingest.ts", `const [state] = await tx\n  .select()\n  .from(bridgeV2StreamStateTable)\n  .where(streamWhere)\n  .for("update")\n  .limit(1);`).violations, []);
// ...but an unlocked status read in ingest fails, and a lock in a LATER statement does not count.
assert.equal(scanFile("lib/bridgeV2/ingest.ts", `const rows = await db.select().from(bridgeV2StreamStateTable).limit(5);`).violations.length, 1);
assert.equal(scanFile("lib/bridgeV2/ingest.ts", `const a = await db.select().from(bridgeV2StreamStateTable);\nconst b = await tx.select().from(other).for("update");`).violations.length, 1);
assert.equal(scanFile("lib/bridgeV2/ingest.ts", "await db.execute(sql`SELECT * FROM bridge_v2_stream_state`)").violations.length, 1);
assert.equal(statementLocksRow(["x.from(t)", '.for("update");'], 1), true);
assert.equal(statementLocksRow(["x.from(t);", '.for("update");'], 1), false);

// Every allowlisted table is a guarded table, and every entry gives a reason.
const known = new Set(STATE_TABLES.map((t) => t.sql));
// The pool and stream status readers are off the allowlist.
for (const gone of ["lib/bridgeV2/status.ts", "routes/bridgeV2.ts"]) assert.equal(ALLOWLIST[gone], undefined, `${gone} must read through the hub`);
for (const [file, e] of Object.entries(ALLOWLIST)) {
  assert.ok(e.reason.length > 10, `${file} needs a reason`);
  assert.equal(e.access, "write", `${file}: every allowlist entry is a writer; reads go through the hub`);
  if (e.lockingReads) assert.ok(/FOR UPDATE/.test(e.reason), `${file}: lockingReads must be explained in the reason`);
  for (const t of e.tables) assert.ok(known.has(t), `${file}: ${t} is not a guarded table`);
}

console.log("check-single-broker-state-source fixtures: ok");
