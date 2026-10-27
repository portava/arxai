// Mutation proofs for check-self-trade-kill-switch-coverage: every assertion
// fires when the real source is weakened in the way it guards against, and
// the unmodified tree passes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./_lib.js";
import {
  FILES, TABLE_WRITER, checkChokepoints, checkSelfTradeKillSwitchCoverage, functionBody, scanRuntimeFile, type Sources,
} from "./check-self-trade-kill-switch-coverage.js";

const real: Sources = {};
for (const k of Object.values(FILES)) real[k] = readFileSync(join(ROOT, "artifacts/api-server/src", k), "utf8");

let n = 0;
function mutate(file: string, from: string | RegExp, to: string, expect: RegExp) {
  n++;
  const before = real[file]!;
  const after = before.replace(from, to);
  assert.notEqual(after, before, `mutation did not apply to ${file}: ${from}`);
  const v = checkChokepoints({ ...real, [file]: after });
  assert.ok(v.some((x) => expect.test(x)), `expected ${expect} for ${file} mutation ${from}; got ${JSON.stringify(v)}`);
}

// Baseline.
n++;
assert.deepEqual(checkChokepoints(real), []);
n++;
const whole = checkSelfTradeKillSwitchCoverage();
assert.equal(whole.ok, true, JSON.stringify(whole.violations));

// functionBody survives return types containing braces.
n++;
assert.match(functionBody(real[FILES.service]!, "toggleKillSwitch") ?? "", /lockKillSwitchesExclusive/);
n++;
assert.equal(functionBody("export async function f(a: number): Promise<{ x: 1 }> { return g(); }", "f"), "{ return g(); }");

// Matcher.
mutate(FILES.scope, 'effective = "MALFORMED"; // unknown / null scope on an ENGAGED row.', "effective = null;", /fail closed/);
mutate(FILES.scope, ".trim().toUpperCase()", ".trim()", /upper-cased/);
mutate(FILES.scope, "eq(selfTradeKillSwitchesTable.engaged, true)", "sql`true`", /engaged rows/);
mutate(FILES.scope, "return evaluateKillSwitchRows(rows, input);", "try { return evaluateKillSwitchRows(rows, input); } catch (e) { return NOT_KILLED; }", /must not catch/);
mutate(FILES.gate, "return readKillSwitchVerdict(input);", "return NOT_KILLED;", /delegate/);
mutate(FILES.gate, "return readKillSwitchVerdict(input);", 'switch (s) { case "SYMBOL": break; } return readKillSwitchVerdict(input);', /own copy/);

// 1. Pre-decision gate.
mutate(FILES.executionGate, "const kill = await assertAgentNotKilled({", "const kill = await noKill({", /must read the kill switches/);
mutate(FILES.executionGate, "killEngaged: kill.killed,", "killEngaged: false,", /killEngaged/);

// 2. Executor TOCTOU.
mutate(FILES.executor, /try \{\s*killNow = await assertAgentNotKilled\(/, "killNow = await assertAgentNotKilled(", /caught and refused/);
mutate(FILES.executor, "killNow = await assertAgentNotKilled({", "killNow = await skip({", /follow reserveAgentEntry|precede submitInstantTrade/);
mutate(FILES.executor, /if \(killNow\.killed\) \{/, "if (false) {", /BLOCKED before submission/);

// 3. Final claim.
mutate(FILES.authority, "await lockKillSwitchesShared(tx);", "", /shared kill lock/);
mutate(FILES.authority, "if (kill.killed) return refuse(ENTRY_KILL_SWITCH_ENGAGED);", "", /refuse before the claim operation/);
mutate(FILES.authority, /(readKillSwitchVerdict\([\s\S]*?\n\s*\},\n\s*)tx,(\n\s*\))/, "$1db,$2", /authority transaction/);
mutate(FILES.authority, /(const kill = await readKillSwitchVerdict\([\s\S]*?tx,\n\s*\))/, "$1.catch(() => NOT_KILLED)", /never be swallowed/);
mutate(FILES.authority, /return withEntryAuthority\(\n\s*request,\n\s*async \(tx, execution, envelope\) => \{\n\s*if \(execution\.commandId != null\)/,
  "return direct(\n    request,\n    async (tx, execution, envelope) => {\n      if (execution.commandId != null)", /createAgentEntryDraft/);
mutate(FILES.cas, /if \(observed && isAgentEntryCommand\(observed\)\)\s*return claimAgentCommand\(observed, "LIVE_APPROVED"/,
  'if (false) return claimAgentCommand(observed, "LIVE_APPROVED"', /claimLiveCommandForDispatch must route/);
mutate(FILES.pipeline, "agentOrigin ? await createAgentEntryDraft(", "agentOrigin ? await createUnchecked(", /createAgentEntryDraft/);

// 0. Pre-decision advisory read.
n++;
assert.ok(
  checkChokepoints({ ...real, [FILES.decisionEngine]: real[FILES.decisionEngine]!.replace(/globalKillEngaged\(\)\.catch\([\s\S]*?return true;\s*\}\),/, "globalKillEngaged().catch(() => false),") })
    .some((x) => /must count as engaged/.test(x)),
  "fail-open pre-decision catch must be flagged",
);

// 4. Writes.
mutate(FILES.service, "await lockKillSwitchesExclusive(tx);", "", /exclusive kill lock/);

// Tree scan.
const flags = (key: string, src: string, re: RegExp) => {
  n++;
  assert.ok(scanRuntimeFile(key, src).some((x) => re.test(x)), `${key}: ${src}`);
};
const clean = (key: string, src: string) => {
  n++;
  assert.deepEqual(scanRuntimeFile(key, src), [], `${key}: ${src}`);
};
flags("routes/newHaltView.ts", "await db.select().from(selfTradeKillSwitchesTable)", /readKillSwitchVerdict/);
flags("lib/selfTrade/decisionEngine.ts", "await db.update(selfTradeKillSwitchesTable).set({ engaged: false })", /writes/);
flags("routes/x.ts", 'await pool.query("UPDATE self_trade_kill_switches SET engaged=false")', /raw SQL/);
flags("lib/newBot.ts", "await submitInstantTrade({ userId, intent: { selfTradeAgentId: 1, action: 'BUY' } })", /new self-trade producer/);
flags("lib/newBot.ts", "await draftTrade({ mode: 'LIVE', kind: 'ENTRY' }, { selfTradeAgentId: a.id })", /new self-trade producer/);
clean(TABLE_WRITER, "await tx.update(selfTradeKillSwitchesTable).set({ engaged })");
clean("lib/selfTrade/selfTradeOrchestrator.ts", "await db.select().from(selfTradeKillSwitchesTable)");
clean("lib/selfTrade/livePositionManager.ts", "await guardianInstantManage({ intent: { selfTradeAgentId: agent.id } })");
clean("routes/doc.ts", "// selfTradeKillSwitchesTable is read only through killSwitchScope\nexport const x = 1;");
clean("lib/manual.ts", "await submitInstantTrade({ userId, intent })");

console.log(`check-self-trade-kill-switch-coverage.test: ${n} assertions passed`);
