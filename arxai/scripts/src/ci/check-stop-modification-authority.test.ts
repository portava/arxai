// Negative fixtures for check-stop-modification-authority. Pure, no IO.
import assert from "node:assert/strict";
import { scanFile } from "./check-stop-modification-authority.js";

export {};

const edit = `await db.update(livePositionsTable).set({ stopLoss: 1.1 }).where(eq(livePositionsTable.id, id));`;
assert.equal(scanFile("routes/positions.ts", edit).length, 1, "a route moving the stop on the ledger");
assert.equal(scanFile("lib/x.ts", `await tx.update(arxLivePositionsTable).set({ closedAt: new Date() });`).length, 1, "closing on the ledger");
assert.equal(scanFile("lib/x.ts", "await db.execute(sql`UPDATE arx_live_positions SET stop_loss = 1`);").length, 1, "raw SQL");
assert.deepEqual(scanFile("lib/mt5/executionReconciler.ts", edit), [], "broker snapshot writer");
assert.deepEqual(scanFile("lib/x.ts", `// await db.update(livePositionsTable).set({ stopLoss: 1 })`), [], "comment");
assert.deepEqual(scanFile("lib/x.ts", `await submitGovernedModify(userId, pos, 1.1, null, "POSITIONS_PAGE");`), []);

const meta = `const set: Record<string, unknown> = { reconcileState, reconcileNote: n };
if (x) set.sourceCommandId = id;
await tx.update(arxLivePositionsTable).set(set).where(eq(arxLivePositionsTable.id, id));`;
assert.deepEqual(scanFile("routes/adminBridgeControl.ts", meta), [], "metadata only");
assert.ok(scanFile("routes/adminBridgeControl.ts", meta.replace("if (x)", "set.stopLoss = 0;\nif (x)")).length > 0, "metadata writer moving the stop");

process.stdout.write("check-stop-modification-authority fixtures: ok\n");

assert.equal(scanFile("lib/strategy.ts", "livePositionWriter.update({ stopLoss: 1 }, scope)").length, 1);
assert.equal(scanFile("lib/positionGuardian/reconcile.ts", "demoPositionWriter.updateReturning({ closedAt: now }, scope, cols)").length, 1);
assert.ok(scanFile("routes/adminBridgeControl.ts", "const set = { stopLoss: 1 }; reconcileLivePositionMetadata(id, set, tx)").length > 0);
