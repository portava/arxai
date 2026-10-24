// Negative fixtures for check-position-guardian-wired. Pure, no IO.
import assert from "node:assert/strict";
import { scanGuardianSource, scanResultRecorder } from "./check-position-guardian-wired.js";

export {};

assert.equal(scanResultRecorder(`const r = await recordLiveCommandResult({ userId });`).length, 1, "result recorded, Guardian not scheduled");
assert.deepEqual(scanResultRecorder(`await reconcileBrokerResult(x); scheduleGuardian("DEMO", u, t, "fill");`), []);
assert.deepEqual(scanResultRecorder(`// recordLiveCommandResult(x)`), [], "comments are ignored");
assert.deepEqual(scanResultRecorder(`const a = 1;`), []);

assert.equal(scanGuardianSource(`await db.update(livePositionsTable).set({ stopLoss: 1 });`).length, 1, "direct position write");
assert.equal(scanGuardianSource(`await db.insert(arxLiveCommandsTable).values(row);`).length, 1, "direct command write");
assert.equal(scanGuardianSource(`await queueMt5CommandWithGate("MODIFY", p);`).length, 1, "legacy queue");
assert.deepEqual(scanGuardianSource(`const [row] = await logRiskEvent({ userId });`), []);
assert.deepEqual(scanGuardianSource(`const draft = await pipe.createLiveOpsDraft({ userId });`), []);

console.log("check-position-guardian-wired fixtures: ok");
