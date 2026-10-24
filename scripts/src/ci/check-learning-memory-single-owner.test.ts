// Negative fixtures for check-learning-memory-single-owner. Pure, no IO.
import assert from "node:assert/strict";
import { scanForLearningMemoryViolations as scan } from "./check-learning-memory-single-owner.js";

export {};

assert.deepEqual(scan(`const edges = await listOwnEdges(userId);`), []);
assert.deepEqual(scan(`// was: db.select().from(strategyEdgesTable)`), [], "comments are ignored");
assert.equal(scan(`const rows = await db.select().from(strategyEdgesTable);`).length, 1, "drizzle read");
assert.equal(scan(`import { db, mistakePatternsTable } from "@workspace/db";`).length, 1, "import");
assert.equal(scan("await pool.query(`SELECT * FROM mistake_patterns`);").length, 1, "raw SQL");
assert.equal(scan("await pool.query(`UPDATE strategy_edges SET edge_score = 0`);").length, 1, "raw SQL write");
assert.deepEqual(scan(`dataSourcesRead.push("strategy_edges");`), [], "a label is not a query");
assert.deepEqual(scan("await pool.query(`SELECT * FROM strategy_edges_archive`);"), [], "other tables named alike");

console.log("check-learning-memory-single-owner fixtures: ok");
