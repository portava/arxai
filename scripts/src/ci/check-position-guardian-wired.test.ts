// Negative fixtures for check-position-guardian-wired. Pure, no IO.
import assert from "node:assert/strict";
import { scanGuardianSource, scanRestoreStop, scanResultRecorder } from "./check-position-guardian-wired.js";

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

// The stop restore is a Trade Engine MODIFY on the resolved governed position.
const restore = (inner: string) => `export async function guardianRestoreStop(args: {
  ruleId: string;
}): Promise<GovernedOpResult> {
  const auth = authorizeManagement(args.ruleId, "RESTORE_STOP", "GOVERNED_OPS");
${inner}
}
export async function other() { await submitTrade({ mode: "LIVE", intent: "MODIFY", target: { position: p } }); }
`;
assert.deepEqual(scanRestoreStop(restore(`  const res = await submitTrade({ mode: args.position.venue, intent: "MODIFY", userId: args.userId,
    target: { position: args.position }, stopLoss: args.stopLoss, takeProfit: args.takeProfit, sourcePage: args.sourcePage });`)), []);
assert.equal(scanRestoreStop(restore(`  return submitGovernedModify(args.userId, args.position, 1, null, "X");`)).length, 1,
  "a direct governedOps call is no longer the restore path (and a MODIFY elsewhere in the file is not proof)");
assert.equal(scanRestoreStop(restore(`  return submitTrade({ mode: "LIVE", intent: "CLOSE", target: { position: args.position } });`)).length, 1,
  "the restore must be a MODIFY");
assert.equal(scanRestoreStop(restore(`  // await submitTrade({ mode: "LIVE", intent: "MODIFY", target: { position: args.position } });`)).length, 1,
  "a commented-out submit is not proof");

console.log("check-position-guardian-wired fixtures: ok");
