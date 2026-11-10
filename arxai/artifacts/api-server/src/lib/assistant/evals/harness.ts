// Eleanor deterministic eval harness.
//
// Replays a fixture conversation through the REAL assistant pipeline
// (runChatTurnLoop: tool-choice routing, tool dispatch, result serialization,
// the streaming claim gate and the verifier footer). Two things are replaced:
//   - the model: a scripted stream that emits the fixture's tool calls and
//     answer text in small chunks, so sentence gating is exercised
//   - the tools: recorded results keyed by tool name (in call order)
// Each fixture then gets two grades:
//   1. the claims checker on the model's RAW answer: did it find exactly the
//      expected findings (no misses, no false alarms)?
//   2. the runtime verifier on what the user actually SAW: nothing flagged is
//      shown as fact, and the expected text is present or absent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolChatStreamChunk } from "../../ai/llmGateway.js";
import { runChatTurnLoop, type ChatMessage, type ChatTurnLoopResult } from "../chatTurnLoop.js";
import { checkClaims, FINDING_KINDS, type FindingKind } from "../grounding/claimsChecker.js";
import { UNVERIFIED_MARK } from "../grounding/runtimeVerifier.js";

export const EVAL_CATEGORIES = ["prices", "positions", "fills", "executions", "risk", "chart_reads", "scanner", "errors_stale"] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface EvalFixture {
  id: string;
  category: EvalCategory;
  description: string;
  user: string;
  /** Scripted model turns, in order. A turn with toolCalls ends in tool_calls; the last turn is text. */
  turns: Array<{ toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string }>;
  /** Recorded tool results by tool name. An array is consumed in call order. A string "THROW:<msg>" makes the tool throw. */
  toolResults: Record<string, unknown>;
  expect: {
    /** Exact multiset of finding kinds the checker must report on the raw answer. */
    findings: FindingKind[];
    visibleIncludes?: string[];
    visibleExcludes?: string[];
  };
}

export interface EvalOutcome {
  fixture: EvalFixture;
  loop: ChatTurnLoopResult;
  visible: string;
  events: Array<Record<string, unknown>>;
  rawFindings: FindingKind[];
  failures: string[];
  pass: boolean;
}

const CHUNK = 7;

function scriptedModel(fixture: EvalFixture, seen: { toolChoices: unknown[]; messageCounts: number[] }) {
  let turn = 0;
  let callSeq = 0;
  return async (input: { messages: unknown[]; toolChoice: unknown }): Promise<AsyncIterable<ToolChatStreamChunk>> => {
    const t = fixture.turns[turn++];
    seen.toolChoices.push(input.toolChoice);
    seen.messageCounts.push(input.messages.length);
    if (!t) throw new Error(`fixture ${fixture.id}: model called for turn ${turn} but the script has ${fixture.turns.length}`);
    const chunks: ToolChatStreamChunk[] = [];
    const text = t.text ?? "";
    for (let i = 0; i < text.length; i += CHUNK) chunks.push({ choices: [{ delta: { content: text.slice(i, i + CHUNK) } }] });
    (t.toolCalls ?? []).forEach((c, index) => {
      const args = JSON.stringify(c.args ?? {});
      const id = `call_${++callSeq}`;
      chunks.push({ choices: [{ delta: { tool_calls: [{ index, id, function: { name: c.name, arguments: args.slice(0, 5) } }] } }] });
      chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
    });
    chunks.push({ choices: [{ delta: {}, finish_reason: t.toolCalls?.length ? "tool_calls" : "stop" }] });
    return (async function* () { for (const c of chunks) yield c; })();
  };
}

function recordedTools(fixture: EvalFixture) {
  const cursor = new Map<string, number>();
  return async (name: string): Promise<unknown> => {
    if (!(name in fixture.toolResults)) throw new Error(`no recorded result for ${name}`);
    let r = fixture.toolResults[name];
    if (Array.isArray(r) && (r as unknown[]).every((x) => x && typeof x === "object" && "__call" in (x as object))) {
      const i = cursor.get(name) ?? 0;
      cursor.set(name, i + 1);
      r = (r as Array<{ __call: unknown }>)[Math.min(i, (r as unknown[]).length - 1)].__call;
    }
    if (typeof r === "string" && r.startsWith("THROW:")) throw new Error(r.slice(6));
    return structuredClone(r);
  };
}

export interface RunOptions {
  systemMessages?: Array<{ role: "system"; content: string }>;
  tools?: unknown[];
  maxTurns?: number;
}

export async function runEvalFixture(fixture: EvalFixture, opts: RunOptions = {}): Promise<EvalOutcome> {
  const events: Array<Record<string, unknown>> = [];
  const seen = { toolChoices: [] as unknown[], messageCounts: [] as number[] };
  const messages: ChatMessage[] = [...(opts.systemMessages ?? []), { role: "user", content: fixture.user }];
  const loop = await runChatTurnLoop({
    model: "eval-scripted",
    messages,
    tools: opts.tools ?? [],
    maxTurns: opts.maxTurns ?? 4,
    forceStructuralRead: false,
    userText: fixture.user,
    toolResultChars: 8000,
    streamChat: scriptedModel(fixture, seen),
    dispatch: recordedTools(fixture),
    send: (e) => events.push(e),
    isAborted: () => false,
  });

  // What the client renders: content deltas minus content_clear.
  let visible = "";
  for (const e of events) {
    if (e.type === "content") visible += String(e.content);
    if (e.type === "content_clear") visible = visible.slice(0, Math.max(0, visible.length - Number(e.chars)));
  }

  const failures: string[] = [];
  // Grade 1: the checker on the raw answer against this turn's tool outputs.
  const raw = checkClaims(loop.rawAnswer, loop.toolCalls.map((c) => ({ name: c.name, result: c.result })), fixture.user);
  const rawFindings = raw.findings.map((f) => f.kind).sort();
  const expected = [...fixture.expect.findings].sort();
  if (JSON.stringify(rawFindings) !== JSON.stringify(expected)) {
    failures.push(`findings: expected [${expected.join(", ")}] got [${rawFindings.join(", ")}] :: ${raw.findings.map((f) => f.detail).join(" ; ")}`);
  }
  // Grade 2: what the user saw.
  if (visible !== loop.assistantText) failures.push("visible text differs from the persisted assistantText");
  for (const s of fixture.expect.visibleIncludes ?? []) if (!visible.includes(s)) failures.push(`visible text missing ${JSON.stringify(s)}`);
  for (const s of fixture.expect.visibleExcludes ?? []) if (visible.includes(s)) failures.push(`visible text still shows ${JSON.stringify(s)}`);
  // Fail-closed invariant: re-checking the visible text finds no unmarked ungrounded claim.
  const recheck = checkClaims(stripVerifierMarks(visible), loop.toolCalls.map((c) => ({ name: c.name, result: c.result })), fixture.user);
  const leaked = recheck.findings.filter((f) => !isMarked(visible, f.claim.text));
  if (leaked.length > 0) failures.push(`unmarked ungrounded claims reached the user: ${leaked.map((f) => `${f.kind}:${f.claim.text}`).join(", ")}`);
  // Pipeline sanity: each tool turn's results were handed back to the model.
  const toolTurns = fixture.turns.filter((t) => t.toolCalls?.length).length;
  if (loop.toolCalls.length !== fixture.turns.reduce((n, t) => n + (t.toolCalls?.length ?? 0), 0)) failures.push("not every scripted tool call was dispatched");
  for (let i = 1; i <= toolTurns && i < seen.messageCounts.length; i++) {
    if (seen.messageCounts[i] <= seen.messageCounts[i - 1]) failures.push(`turn ${i} did not see the previous turn's tool results`);
  }
  if (loop.status !== "answered") failures.push(`loop status ${loop.status}`);
  return { fixture, loop, visible, events, rawFindings: rawFindings as FindingKind[], failures, pass: failures.length === 0 };
}

export function stripVerifierMarks(s: string): string {
  return s.replace(/\[Removed by the ARX verifier:[^\]]*\]/g, "").replace(/\[Withheld:[^\]]*\]/g, "").replace(/\n\n_ARX verifier:[^\n]*_$/, "");
}
export function isMarked(visible: string, claimText: string): boolean {
  return visible.includes(`${claimText}${UNVERIFIED_MARK}`);
}

export function loadFixtures(dir: string): EvalFixture[] {
  const out: EvalFixture[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalFixture[];
    for (const fx of parsed) out.push(fx);
  }
  return out;
}

export interface Scorecard {
  fixtures: number;
  passed: number;
  byCategory: Record<string, { fixtures: number; passed: number }>;
  /** Per finding kind: planted (expected) vs caught exactly. */
  detection: Record<FindingKind, { planted: number; caught: number }>;
  /** Clean answers (no expected findings) that the checker flagged anyway. */
  falseAlarms: number;
  cleanAnswers: number;
  claimsChecked: number;
}

export function scorecard(outcomes: EvalOutcome[]): Scorecard {
  const detection = Object.fromEntries(FINDING_KINDS.map((k) => [k, { planted: 0, caught: 0 }])) as Scorecard["detection"];
  const byCategory: Scorecard["byCategory"] = {};
  let falseAlarms = 0, cleanAnswers = 0, claimsChecked = 0;
  for (const o of outcomes) {
    const c = (byCategory[o.fixture.category] ??= { fixtures: 0, passed: 0 });
    c.fixtures++;
    if (o.pass) c.passed++;
    for (const k of FINDING_KINDS) {
      const planted = o.fixture.expect.findings.filter((x) => x === k).length;
      const got = o.rawFindings.filter((x) => x === k).length;
      detection[k].planted += planted;
      detection[k].caught += Math.min(planted, got);
    }
    if (o.fixture.expect.findings.length === 0) {
      cleanAnswers++;
      if (o.rawFindings.length > 0) falseAlarms++;
    }
    claimsChecked += checkClaims(o.loop.rawAnswer, o.loop.toolCalls.map((t) => ({ name: t.name, result: t.result })), o.fixture.user).claims.length;
  }
  return { fixtures: outcomes.length, passed: outcomes.filter((o) => o.pass).length, byCategory, detection, falseAlarms, cleanAnswers, claimsChecked };
}
