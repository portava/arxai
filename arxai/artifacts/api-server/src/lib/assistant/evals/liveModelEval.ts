// Eleanor live-model eval lane. OPTIONAL: it needs an OpenAI key and is NOT
// part of the default `ci`. Docs: docs/ELEANOR_EVALS.md.
//
// For each fixture question, the REAL model (production system messages, all
// tool definitions, the production chat loop and runtime verifier) answers
// against the fixture's RECORDED tool results. A tool the fixture did not
// record returns an explicit not-recorded error, never live data, so the run
// touches no database, broker or account. The claims checker then grades the
// model's raw answers. The lane reports a grounding rate (grounded claims /
// all claims) and every finding by kind.
//
//   AI_INTEGRATIONS_OPENAI_API_KEY=... [AI_INTEGRATIONS_OPENAI_BASE_URL=...] \
//     pnpm --filter @workspace/api-server run eval:eleanor-live -- [--strict] [--only <id-substring>] [--out report.json]
//
// OPENAI_API_KEY is accepted too (the base URL then defaults to api.openai.com).
// Without a key the lane prints "skipped" and exits 0, unless --require-key is passed.
// --strict exits 1 when any raw answer has a finding.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "https://api.openai.com/v1";
}
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim()) {
  console.log("eval:eleanor-live skipped: no AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY set.");
  process.exit(flag("--require-key") ? 1 : 0);
}
// The loop imports tools.ts (db module); nothing here queries it.
process.env.DATABASE_URL ??= "postgres://eval:eval@127.0.0.1:1/eleanor_eval_offline";

const { loadFixtures } = await import("./harness.js");
const { runChatTurnLoop } = await import("../chatTurnLoop.js");
const { checkClaims, FINDING_KINDS } = await import("../grounding/claimsChecker.js");
const { streamToolChat } = await import("../../ai/llmGateway.js");
const { TOOL_DEFINITIONS } = await import("../tools.js");
const { buildSessionSystemMessages } = await import("../systemPrompt.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

const MODEL = process.env.ELEANOR_EVAL_MODEL ?? "gpt-5.4";
const fixtures = loadFixtures(fileURLToPath(new URL("./fixtures/", import.meta.url)))
  .filter((f) => Object.keys(f.toolResults).length > 0)
  .filter((f) => !opt("--only") || f.id.includes(opt("--only")!));
// One run per distinct question + recorded data (planted-error fixtures share them).
const seen = new Set<string>();
const runs = fixtures.filter((f) => { const k = f.user + JSON.stringify(f.toolResults); if (seen.has(k)) return false; seen.add(k); return true; });

const tools = TOOL_DEFINITIONS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
const report: Array<Record<string, unknown>> = [];
let claims = 0, grounded = 0;
const byKind = Object.fromEntries(FINDING_KINDS.map((k) => [k, 0])) as Record<string, number>;

for (const f of runs) {
  const recorded = f.toolResults;
  const outcome = await runChatTurnLoop({
    model: MODEL,
    messages: [...buildSessionSystemMessages(1, null, null, FAIL_CLOSED_ENVELOPE, "Eleanor"), { role: "user", content: f.user }],
    tools,
    maxTurns: 4,
    forceStructuralRead: false,
    userText: f.user,
    toolResultChars: 8000,
    streamChat: streamToolChat,
    dispatch: async (name) => {
      if (!(name in recorded)) return { error: "not_recorded_for_eval", tool: name, message: "This tool has no recorded result in the eval fixture; no data is available." };
      const r = recorded[name];
      if (typeof r === "string" && r.startsWith("THROW:")) throw new Error(r.slice(6));
      return structuredClone(r);
    },
    send: () => {},
    isAborted: () => false,
  });
  const check = checkClaims(outcome.rawAnswer, outcome.toolCalls.map((c) => ({ name: c.name, result: c.result })), f.user);
  claims += check.claims.length;
  grounded += check.claims.filter((c) => c.grounded).length;
  for (const x of check.findings) byKind[x.kind]++;
  report.push({
    id: f.id, category: f.category, user: f.user, status: outcome.status,
    tools: outcome.toolCalls.map((c) => c.name), raw: outcome.rawAnswer, visible: outcome.assistantText,
    findings: check.findings.map((x) => ({ kind: x.kind, claim: x.claim.text, detail: x.detail })),
  });
  console.log(`${check.findings.length === 0 ? "ok  " : "FLAG"} ${f.id} [${outcome.toolCalls.map((c) => c.name).join(", ")}] ${check.findings.map((x) => `${x.kind}:${x.claim.text}`).join(" ")}`);
}

const summary = {
  model: MODEL, questions: runs.length, claims, grounded,
  groundingRate: claims ? Math.round((grounded / claims) * 1000) / 10 : null,
  answersWithFindings: report.filter((r) => (r.findings as unknown[]).length > 0).length,
  findingsByKind: byKind,
};
console.log(JSON.stringify(summary, null, 2));
if (opt("--out")) writeFileSync(opt("--out")!, JSON.stringify({ summary, report }, null, 2));
process.exit(flag("--strict") && summary.answersWithFindings > 0 ? 1 : 0);
