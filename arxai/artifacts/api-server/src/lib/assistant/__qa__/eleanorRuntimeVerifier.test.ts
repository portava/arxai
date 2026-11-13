// Eleanor runtime verifier: the streaming claim gate, fail-closed behaviour,
// the extracted chat loop and the production route wiring. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildEvidenceIndex, type EvidenceIndex } from "../grounding/evidence.js";
import { checkClaims } from "../grounding/claimsChecker.js";
import { ClaimGate, verifyAnswer, UNVERIFIED_MARK, VERIFIER_FAILED_NOTICE, VERIFIER_NOTICES } from "../grounding/runtimeVerifier.js";
import { runChatTurnLoop, PROVIDER_UNAVAILABLE_MESSAGE, STREAM_INTERRUPTED_MESSAGE, type ChatMessage } from "../chatTurnLoop.js";
import type { ToolChatStreamChunk } from "../../ai/llmGateway.js";

const SNAP = { name: "getMarketSnapshot", result: { symbol: "EURUSD", stale: false, freshness: "REALTIME", isLive: true, lastPrice: 1.08523 } };
const STALE = { name: "getMarketSnapshot", result: { symbol: "EURUSD", stale: true, freshness: "STALE", isLive: false, lastPrice: 1.08523 } };
const AWAIT = { name: "getTradeActionStatus", result: { actionId: 5130, status: "awaiting_confirmation" } };

test("gate releases nothing until a sentence is complete, then releases it checked", () => {
  const gate = new ClaimGate(buildEvidenceIndex([SNAP]));
  assert.equal(gate.push("EURUSD is at 1.08"), "");
  assert.equal(gate.push("523"), "", "a number split across deltas is not released half-checked");
  assert.equal(gate.push(". It traded 1.0999"), "EURUSD is at 1.08523.");
  assert.equal(gate.end(), ` It traded 1.0999${UNVERIFIED_MARK}`);
  assert.equal(gate.released, "EURUSD is at 1.08523.".length + ` It traded 1.0999${UNVERIFIED_MARK}`.length);
  assert.equal(gate.findings.length, 1);
});

test("chunked streaming produces exactly the whole-answer verification", () => {
  const answer = "1. EURUSD is 1.08523 live.\n2. It was 1.0777 earlier. Your order was filled. Done!";
  const whole = verifyAnswer(answer, [SNAP, AWAIT]);
  for (const size of [1, 3, 7, 50]) {
    const gate = new ClaimGate(buildEvidenceIndex([SNAP, AWAIT]));
    let out = "";
    for (let i = 0; i < answer.length; i += size) out += gate.push(answer.slice(i, i + size));
    out += gate.end() + gate.footer();
    assert.equal(out, whole.text, `chunk size ${size}`);
  }
  assert.match(whole.text, /1\.0777 \[unverified\]/);
  assert.ok(whole.text.includes(VERIFIER_NOTICES.EXECUTION_UNCONFIRMED));
  assert.ok(!whole.text.includes("Your order was filled"));
  assert.match(whole.text, /_ARX verifier: 2 claims in this answer/);
});

test("removal kinds replace the whole sentence; list markers and line breaks survive", () => {
  const r = verifyAnswer("- EURUSD is live at 1.0852 right now.\n- Next point.", [STALE]);
  assert.equal(r.text.split("\n")[0], `- ${VERIFIER_NOTICES.STALE_AS_LIVE}`);
  assert.match(r.text, /\n- Next point\./);
});

test("a clean answer is returned byte-for-byte with no footer", () => {
  const a = "EURUSD is 1.08523 on the live feed.";
  const r = verifyAnswer(a, [SNAP]);
  assert.equal(r.text, a);
  assert.equal(r.findings.length, 0);
});

test("live-evaluation follow-ups survive every streaming boundary without hiding factual errors", () => {
  const cases = [
    { user: "Read R_75 M15", answer: "Next: if you want, I can also give you 2–3 trade options for R_75 M15." },
    { user: "Buy 0.1 EURUSD", answer: "Type the direct command exactly as: **buy EURUSD 0.1** in the trade command flow. Next: I can run a risk check for 0.1 EURUSD." },
    { user: "Status of 5124?", answer: "Next: If 5124 was rejected or failed, I can explain the blocker once the action record is available." },
  ];
  for (const { user, answer } of cases) {
    for (const size of [1, 2, 7, 31]) {
      const gate = new ClaimGate(buildEvidenceIndex([], user));
      let visible = "";
      for (let i = 0; i < answer.length; i += size) visible += gate.push(answer.slice(i, i + size));
      visible += gate.end() + gate.footer();
      assert.equal(visible, answer, `chunk ${size}: ${answer}`);
    }
    const checked = verifyAnswer(`${answer} Your order was filled at 1.9999.`, [], user);
    assert.ok(checked.findings.some(f => f.kind === "EXECUTION_UNCONFIRMED"));
    assert.ok(!checked.text.includes("Your order was filled"));
  }
});

test("fail closed: if the checker throws, the segment is withheld, never shown unchecked", () => {
  const broken = { numbers: null, times: [], strings: [], executions: [], symbols: new Set(), toolNames: [] } as unknown as EvidenceIndex;
  const gate = new ClaimGate(broken);
  const out = gate.push("EURUSD is 1.2345. ") + gate.end();
  assert.ok(!out.includes("1.2345"));
  assert.ok(out.includes(VERIFIER_FAILED_NOTICE));
  assert.equal(gate.failedClosed, true);
});

test("live timestamp and suggestion formats remain identical through chunked streaming", () => {
  const tools = [{name:"getRiskUtilization", result:{openTrades:2,maxOpenTrades:5,observedAt:"2026-11-09T14:32:05.000Z",riskReward:2}}];
  const answer = "Observed at 2026-11-09T14:32:05.000Z. You have 2 open trades out of a 5-trade limit. Reward to risk is 2:1. Type the direct command exactly as: `buy EURUSD 0.1`. Send the action ID, like: `142` or `action 142`. Without confirmed live candle context, any “BTC is bullish/bearish” answer would be guesswork.";
  for (const size of [1,2,7,31]) {
    const gate = new ClaimGate(buildEvidenceIndex(tools));
    let visible = "";
    for (let i=0; i<answer.length; i+=size) visible += gate.push(answer.slice(i,i+size));
    visible += gate.end() + gate.footer();
    assert.equal(visible, answer, `chunk ${size}`);
  }
  const wrong = verifyAnswer(answer.replace("14:32:05.000Z", "14:32:06.000Z"), tools);
  assert.equal(wrong.findings.length, 1);
  assert.match(wrong.text, /14:32:06\.000Z \[unverified\]/);
});

test("after verification, nothing ungrounded remains unmarked (invariant over many answers)", () => {
  const answers = [
    "EURUSD is 1.0852 live. Bid 1.0851. Ticket 99999 filled at 1.0853 on 2026-11-10 at 09:15 UTC.",
    "GBPUSD has a 71% chance. Score 72%. You have 4 positions.",
  ];
  for (const a of answers) {
    const r = verifyAnswer(a, [SNAP, AWAIT]);
    const recheck = checkClaims(r.text.replace(/\[Removed by the ARX verifier:[^\]]*\]/g, "").replace(/\n\n_ARX verifier:[^\n]*_$/, ""), [SNAP, AWAIT]);
    for (const f of recheck.findings) assert.ok(r.text.includes(`${f.claim.text}${UNVERIFIED_MARK}`), `${f.kind} ${f.claim.text} reached the user unmarked`);
  }
});

// ── the loop ────────────────────────────────────────────────────────────────
type Turn = { text?: string; calls?: Array<{ name: string; args?: unknown }>; throwAfter?: boolean };
function model(turns: Turn[], seen: unknown[][] = []) {
  let n = 0;
  return async (input: { messages: unknown[] }): Promise<AsyncIterable<ToolChatStreamChunk>> => {
    const t = turns[n++];
    seen.push(structuredClone(input.messages));
    if (!t) throw new Error("provider down");
    return (async function* () {
      for (const ch of (t.text ?? "").match(/.{1,4}/gs) ?? []) yield { choices: [{ delta: { content: ch } }] };
      if (t.throwAfter) throw new Error("socket reset");
      for (const [i, c] of (t.calls ?? []).entries()) yield { choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: t.calls?.length ? "tool_calls" : "stop" }] };
    })();
  };
}
function visible(events: Array<Record<string, unknown>>): string {
  let v = "";
  for (const e of events) {
    if (e.type === "content") v += String(e.content);
    if (e.type === "content_clear") v = v.slice(0, v.length - Number(e.chars));
  }
  return v;
}
const base = (turns: Turn[], dispatch: (n: string) => Promise<unknown>, events: Array<Record<string, unknown>>, seen?: unknown[][]) => ({
  model: "m", messages: [{ role: "user", content: "q" }] as ChatMessage[], tools: [], maxTurns: 4, forceStructuralRead: false,
  userText: "q", toolResultChars: 8000, streamChat: model(turns, seen), dispatch: (n: string) => dispatch(n),
  send: (e: Record<string, unknown>) => events.push(e), isAborted: () => false,
});

test("loop: preamble is cleared by exactly what was released; tool outputs become next-turn evidence", async () => {
  const events: Array<Record<string, unknown>> = [];
  const seen: unknown[][] = [];
  const r = await runChatTurnLoop(base([
    { text: "Checking the price now. One sec", calls: [{ name: "getMarketSnapshot", args: { symbol: "EURUSD" } }] },
    { text: "EURUSD is 1.08523 on the live feed." },
  ], async () => SNAP.result, events, seen));
  assert.equal(r.status, "answered");
  assert.equal(visible(events), "EURUSD is 1.08523 on the live feed.");
  const clear = events.find((e) => e.type === "content_clear");
  assert.equal(clear?.chars, "Checking the price now.".length, "the unreleased tail ' One sec' was never sent, so it is not cleared");
  assert.equal(r.assistantText, visible(events));
  assert.equal(r.findings.length, 0);
  assert.ok((seen[1] as Array<{ role: string }>).some((m) => m.role === "tool"), "turn 2 saw the tool result");
});

test("loop: final text is verified against this request's tool outputs; persisted text equals what was shown", async () => {
  const events: Array<Record<string, unknown>> = [];
  const r = await runChatTurnLoop(base([
    { calls: [{ name: "getTradeActionStatus" }] },
    { text: "Your order was filled at 1.0855. Anything else?" },
  ], async () => AWAIT.result, events));
  assert.equal(r.rawAnswer, "Your order was filled at 1.0855. Anything else?");
  assert.ok(!visible(events).includes("filled"));
  assert.ok(visible(events).startsWith(VERIFIER_NOTICES.EXECUTION_UNCONFIRMED));
  assert.equal(r.assistantText, visible(events));
  assert.deepEqual(r.findings.map((f) => f.kind).sort(), ["EXECUTION_UNCONFIRMED", "FABRICATION"]);
});

test("loop: a mid-stream failure clears everything released and reports an error", async () => {
  const events: Array<Record<string, unknown>> = [];
  const r = await runChatTurnLoop(base([{ text: "EURUSD is 1.08523. And the", throwAfter: true }], async () => SNAP.result, events));
  assert.equal(r.status, "stream_error");
  assert.equal(visible(events), "");
  assert.ok(events.some((e) => e.type === "error" && e.message === STREAM_INTERRUPTED_MESSAGE));
});

test("loop: provider failure and tool failure are reported, never invented around", async () => {
  const events: Array<Record<string, unknown>> = [];
  const r = await runChatTurnLoop(base([], async () => null, events));
  assert.equal(r.status, "provider_error");
  assert.ok(events.some((e) => e.message === PROVIDER_UNAVAILABLE_MESSAGE));

  const ev2: Array<Record<string, unknown>> = [];
  const r2 = await runChatTurnLoop(base([
    { calls: [{ name: "getMarketSnapshot" }] },
    { text: "EURUSD is 1.0852." },
  ], async () => { throw new Error("timeout"); }, ev2));
  assert.equal(r2.toolCalls[0].status, "error");
  assert.deepEqual(r2.toolCalls[0].result, { error: "tool_failed", name: "getMarketSnapshot", message: "timeout" });
  assert.match(visible(ev2), /1\.0852 \[unverified\]/, "a price after a failed tool is marked, not shown as fact");
});

// ── wiring ──────────────────────────────────────────────────────────────────
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("route wiring: the chat route runs the shared loop and persists the verified text", () => {
  const route = src("../../../routes/meAssistant.ts");
  assert.match(route, /const loop = await runChatTurnLoop\(\{/);
  assert.match(route, /maxTurns: MAX_TURNS_PER_REQUEST/);
  assert.match(route, /streamChat: streamToolChat/);
  assert.match(route, /dispatch: \(name, parsedArgs\) => dispatchTool\(name, parsedArgs, userId, req, safetyEnvelope\)/);
  assert.match(route, /assistantText = loop\.assistantText;/);
  assert.match(route, /"eleanor_claims_verifier_flagged"/);
  assert.doesNotMatch(route, /for \(let turn = 0; turn < MAX_TURNS_PER_REQUEST; turn\+\+\)/, "no second, unverified loop in the route");
});

test("loop wiring: every content event goes through the claim gate; the loop cannot place orders", () => {
  const loop = src("../chatTurnLoop.ts");
  assert.equal(loop.match(/send\(\{ type: "content", /g)?.length, 1, "one content emitter");
  assert.match(loop, /const emit = \(text: string\) => \{ if \(text\) send\(\{ type: "content", content: text \}\); \};/);
  assert.match(loop, /emit\(gate\.push\(delta\.content\)\)/);
  assert.match(loop, /resolveAssistantToolChoice\(turn, input\.forceStructuralRead, input\.maxTurns\)/);
  assert.doesNotMatch(loop, /placeOrder|enforcePreTradeRisk|liveAllowed|recordAndExecuteEleanor/);
});

// Regressions from the independent review: exercise the actual turn pipeline.
import { runEvalFixture, type EvalFixture } from "../evals/harness.js";
const pipelineCases: EvalFixture[] = [
  {id:'pipeline-sign-flip',category:'positions',description:'A loss becomes a profit',user:'What is my P&L?',turns:[{toolCalls:[{name:'getTradeJournalSummary'}]},{text:'Your EURUSD P&L is +$125.50.'}],toolResults:{getTradeJournalSummary:{lookbackDays:30,totalClosed:1,perSymbol:[{symbol:'EURUSD',count:1,pnl:-125.5}],isEmpty:false}},expect:{findings:['WRONG_NUMBER'],visibleExcludes:['+$125.50']}},
  {id:'pipeline-symbol-swap',category:'prices',description:'One symbol uses another symbol price',user:'Compare EURUSD and GBPUSD prices.',turns:[{toolCalls:[{name:'getMarketSnapshot',args:{symbol:'EURUSD'}},{name:'getMarketSnapshot',args:{symbol:'GBPUSD'}}]},{text:'EURUSD is trading at 1.2800 right now.'}],toolResults:{getMarketSnapshot:[{__call:{symbol:'EURUSD',lastPrice:1.08,stale:false,freshness:'REALTIME'}},{__call:{symbol:'GBPUSD',lastPrice:1.28,stale:false,freshness:'REALTIME'}}]},expect:{findings:['WRONG_NUMBER'],visibleExcludes:['1.2800']}},
  {id:'pipeline-false-execution',category:'executions',description:'No execution result, unrelated negation',user:'Did my order execute?',turns:[{text:'Your order was filled, no further action is needed.'}],toolResults:{},expect:{findings:['EXECUTION_UNCONFIRMED'],visibleExcludes:['Your order was filled']}},
];

for (const fixture of pipelineCases) {
  test(fixture.id, async () => {
    const result = await runEvalFixture(fixture);
    assert.equal(result.pass, true, JSON.stringify(result.failures));
    assert.equal(result.loop.assistantText, result.visible);
  });
}
