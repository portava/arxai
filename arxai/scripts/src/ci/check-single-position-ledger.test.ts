import assert from "node:assert/strict";
import { LEDGER, scanFile } from "./check-single-position-ledger.js";

const fails = (source: string, key = "lib/strategy.ts") =>
  assert.ok(scanFile(key, source).length > 0, source);
const passes = (source: string, key = "lib/strategy.ts") =>
  assert.deepEqual(scanFile(key, source), [], source);
fails('import { arxLivePositionsTable as hidden } from "@workspace/db"; db.select().from(hidden)');
fails('const { livePositionsTable: hidden } = await import("@workspace/db/schema")');
fails("db.query.arxLivePositionsTable.findMany()");
fails('db.select().from(schema["livePositionsTable"])');
fails('sql`select * from "public"."arx_live_positions"`');
fails('client.query("UPDATE live_positions SET stop_loss = $1", [1])');
fails('sql`select * from ${sql.identifier("live_positions")}`');
fails('tableCount("live_positions")');
fails("livePositionColumns.id.table");
fails(
  'import { livePositionWriter as writer } from "./positions/ledger.js"; writer.update({stopLoss: 1}, scope)',
);
fails("const { insert } = demoPositionWriter");
fails('ledger["demoPositionWriter"].insert(row)');
fails('export * from "../positions/ledger.js"');
fails("reconcileLivePositionMetadata(id, metadata, tx)");
fails("livePositionWriter.update(row, scope)", "routes/adminBridgeControl.ts");
passes("livePositionLedger.read({ where: eq(livePositionColumns.userId, userId) })");
passes("demoPositionLedger.select({id: demoPositionColumns.id}, {limit: 1})");
passes("// db.select().from(arxLivePositionsTable)\n/* UPDATE live_positions */");
passes('const source = "arx_live_positions"; // diagnostic label, not SQL');
passes("livePositionWriter.update(row, scope)", "routes/mt5Live.ts");
passes("demoPositionWriter.insert(row)", "lib/mt5/executionReconciler.ts");
passes("reconcileLivePositionMetadata(id, metadata, tx)", "routes/adminBridgeControl.ts");
passes("db.select().from(arxLivePositionsTable)", LEDGER);
console.log("single-position-ledger: 23 boundary fixtures passed");
