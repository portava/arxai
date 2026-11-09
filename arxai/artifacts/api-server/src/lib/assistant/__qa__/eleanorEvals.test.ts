// Eleanor deterministic eval suite (offline, no model key, no DB round-trip).
//
// Every fixture in ../evals/fixtures is replayed through the real chat loop
// (runChatTurnLoop) with the production system messages and tool definitions,
// a scripted model and recorded tool results. The suite fails if:
//   - the claims checker misses a planted error or raises a false alarm,
//   - anything ungrounded reaches the user unmarked,
//   - a fixture names a tool Eleanor does not have,
//   - the corpus loses coverage (categories, finding kinds, size).
process.env.DATABASE_URL ??= "postgres://eval:eval@127.0.0.1:1/eleanor_eval_offline";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EVAL_CATEGORIES, loadFixtures, runEvalFixture, scorecard, type EvalOutcome } from "../evals/harness.js";
import { FINDING_KINDS } from "../grounding/claimsChecker.js";

const { TOOL_DEFINITIONS } = await import("../tools.js");
const { buildSessionSystemMessages, GROUNDING_CONTRACT } = await import("../systemPrompt.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

const fixtures = loadFixtures(fileURLToPath(new URL("../evals/fixtures/", import.meta.url)));
const toolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name as string));
const tools = TOOL_DEFINITIONS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
const systemMessages = buildSessionSystemMessages(1, null, null, FAIL_CLOSED_ENVELOPE, "Eleanor");

const outcomes: EvalOutcome[] = [];

test("corpus shape: unique ids, every category, every finding kind planted, real tool names", () => {
  assert.ok(fixtures.length >= 50, `corpus has ${fixtures.length} fixtures`);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length, "fixture ids are unique");
  for (const c of EVAL_CATEGORIES) assert.ok(fixtures.filter((f) => f.category === c).length >= 5, `category ${c} has at least 5 fixtures`);
  for (const k of FINDING_KINDS) assert.ok(fixtures.filter((f) => f.expect.findings.includes(k)).length >= 3, `finding ${k} is planted in at least 3 fixtures`);
  assert.ok(fixtures.filter((f) => f.expect.findings.length === 0).length >= 20, "at least 20 clean answers guard against false alarms");
  for (const f of fixtures) {
    for (const t of f.turns) for (const c of t.toolCalls ?? []) assert.ok(toolNames.has(c.name), `${f.id}: ${c.name} is a real Eleanor tool`);
    assert.ok(!f.turns.at(-1)?.toolCalls?.length && f.turns.at(-1)?.text, `${f.id}: the script ends with a text turn`);
  }
});

test("the production system messages carry the grounding contract the verifier enforces", () => {
  assert.ok(systemMessages.some((m) => m.content === GROUNDING_CONTRACT));
  assert.match(GROUNDING_CONTRACT, /NOT calibrated probabilities/);
  assert.match(GROUNDING_CONTRACT, /executed status/);
});

for (const fx of fixtures) {
  test(`eval ${fx.category} :: ${fx.id}`, async () => {
    const o = await runEvalFixture(fx, { systemMessages, tools });
    outcomes.push(o);
    assert.deepEqual(o.failures, [], `${fx.description}\nraw: ${o.loop.rawAnswer}\nvisible: ${o.visible}`);
  });
}

test("scorecard: 100% of fixtures pass, every planted error caught, zero false alarms", () => {
  const s = scorecard(outcomes);
  console.log(`# Eleanor eval scorecard\n${JSON.stringify(s, null, 2)}`);
  assert.equal(s.fixtures, fixtures.length);
  assert.equal(s.passed, s.fixtures);
  for (const k of FINDING_KINDS) assert.equal(s.detection[k].caught, s.detection[k].planted, `${k}: caught ${s.detection[k].caught}/${s.detection[k].planted}`);
  assert.equal(s.falseAlarms, 0);
  assert.ok(s.claimsChecked >= 100, `claims checked: ${s.claimsChecked}`);
});
