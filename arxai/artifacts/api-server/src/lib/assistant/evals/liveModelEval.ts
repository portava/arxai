// Eleanor live-model eval lane. A CI lane of its own:
// .github/workflows/eleanor-live-eval.yml (push to the base branch and
// workflow_dispatch only; never on pull requests). Docs: docs/ELEANOR_EVALS.md.
//
// For each fixture question, the REAL model (production system messages, all
// tool definitions, the production chat loop and runtime verifier) answers
// against the fixture's RECORDED tool results. A tool the fixture did not
// record returns an explicit not-recorded error, never live data, so the run
// touches no database, broker or account, and cannot place an order. The claims
// checker then grades:
//   - the model's RAW answer: claims made, claims verified, findings by kind,
//     raw-model accuracy (verified / made);
//   - what the user SAW after the verifier: any ungrounded claim left unmarked
//     is a leak (the gate guarantees zero; this proves it on real model text).
// Thresholds and report shape: liveEvalReport.ts.
//
//   OPENAI_API_KEY=... pnpm --filter @workspace/api-server run eval:eleanor-live -- \
//     [--require-key] [--strict] [--only <id-substring>] [--out report.json] [--summary report.md]
//
// AI_INTEGRATIONS_OPENAI_API_KEY (+ _BASE_URL), the variables the app itself
// reads, take precedence; OPENAI_API_KEY maps onto them with the public
// api.openai.com base URL.
//   --require-key  no key => print "not run: no key", write a NOT RUN report, exit 1
//                  (CI always passes it). Without it, no key exits 0 (local use).
//   --strict       exit 1 when the thresholds fail (CI always passes it).
//   ELEANOR_EVAL_MODEL        model id (default: the production chat model)
//   ELEANOR_EVAL_MIN_ACCURACY raw-model accuracy floor 0..1 (default 0.90)

import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLiveReport, notRunReport, renderMarkdown, DEFAULT_MIN_RAW_ACCURACY, type LiveEvalReport, type LiveFixtureInput } from "./liveEvalReport.js";

// CLI output goes to stdout directly (the server no-console guard covers this tree).
const out = (line: string) => process.stdout.write(`${line}\n`);
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const minAccuracy = Number(process.env.ELEANOR_EVAL_MIN_ACCURACY ?? DEFAULT_MIN_RAW_ACCURACY);
if (!(minAccuracy > 0 && minAccuracy <= 1)) {
  out(`ELEANOR_EVAL_MIN_ACCURACY must be in (0, 1], got ${process.env.ELEANOR_EVAL_MIN_ACCURACY}`);
  process.exit(2);
}

function emit(report: LiveEvalReport): void {
  const md = renderMarkdown(report);
  if (opt("--out")) writeFileSync(opt("--out")!, JSON.stringify(report, null, 2));
  if (opt("--summary")) writeFileSync(opt("--summary")!, md);
  // GitHub job summary, when running in Actions.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  out(JSON.stringify(report.summary, null, 2));
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim() && process.env.OPENAI_API_KEY?.trim()) {
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
}
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim()) {
  if (flag("--require-key")) {
    out("not run: no key (set the OPENAI_API_KEY repository secret, or AI_INTEGRATIONS_OPENAI_API_KEY locally)");
    if (process.env.GITHUB_ACTIONS) out("::error title=Eleanor live eval not run::not run: no key. Add the OPENAI_API_KEY repository secret; no accuracy rate was measured.");
    emit(notRunReport("no key", minAccuracy));
    process.exit(1);
  }
  out("eval:eleanor-live not run: no key (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY unset). Pass --require-key to fail instead.");
  process.exit(0);
}
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "https://api.openai.com/v1";
// The loop imports tools.ts (db module); nothing here queries it.
process.env.DATABASE_URL ??= "postgres://eval:eval@127.0.0.1:1/eleanor_eval_offline";

const { loadFixtures, stripVerifierMarks, isMarked } = await import("./harness.js");
const { runChatTurnLoop } = await import("../chatTurnLoop.js");
const { checkClaims } = await import("../grounding/claimsChecker.js");
const { streamToolChat } = await import("../../ai/llmGateway.js");
const { TOOL_DEFINITIONS } = await import("../tools.js");
const { buildSessionSystemMessages } = await import("../systemPrompt.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

// Same model the production chat route uses (routes/meAssistant.ts MODEL).
const MODEL = process.env.ELEANOR_EVAL_MODEL?.trim() || "gpt-5.4";
const fixtures = loadFixtures(fileURLToPath(new URL("./fixtures/", import.meta.url)))
  .filter((f) => Object.keys(f.toolResults).length > 0)
  .filter((f) => !opt("--only") || f.id.includes(opt("--only")!));
// One run per distinct question + recorded data (planted-error fixtures share them).
const seen = new Set<string>();
const runs = fixtures.filter((f) => { const k = f.user + JSON.stringify(f.toolResults); if (seen.has(k)) return false; seen.add(k); return true; });

const tools = TOOL_DEFINITIONS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
const inputs: LiveFixtureInput[] = [];

for (const f of runs) {
  const recorded = f.toolResults;
  const calls: Record<string, number> = {};
  let error: string | null = null;
  let outcome: Awaited<ReturnType<typeof runChatTurnLoop>> | null = null;
  try {
    outcome = await runChatTurnLoop({
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
        let r = recorded[name];
        // Several recorded calls to one tool: [{ __call: result }, ...] in call order.
        if (Array.isArray(r) && r.every((x) => x && typeof x === "object" && "__call" in x)) {
          const i = calls[name] = (calls[name] ?? -1) + 1;
          r = (r[Math.min(i, r.length - 1)] as { __call: unknown }).__call;
        }
        if (typeof r === "string" && r.startsWith("THROW:")) throw new Error(r.slice(6));
        return structuredClone(r);
      },
      send: () => {},
      isAborted: () => false,
      // A provider failure returns status "provider_error" and no exception, so
      // keep the provider's own message: a failed run must say why it failed.
      logError: (msg, err) => {
        const e = err as { status?: number; message?: string } | null;
        error = `${msg}${e?.status ? ` HTTP ${e.status}` : ""}: ${String(e?.message ?? err)}`.slice(0, 300);
      },
    });
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const toolOutputs = (outcome?.toolCalls ?? []).map((c) => ({ name: c.name, result: c.result }));
  const raw = outcome?.rawAnswer ?? "";
  const visible = outcome?.assistantText ?? "";
  const check = checkClaims(raw, toolOutputs, f.user);
  const recheck = checkClaims(stripVerifierMarks(visible), toolOutputs, f.user);
  const leaked = recheck.findings.filter((x) => !isMarked(visible, x.claim.text)).map((x) => ({ kind: x.kind, claim: x.claim.text }));
  inputs.push({
    id: f.id, category: f.category, user: f.user, status: outcome?.status ?? "error",
    tools: outcome?.toolCalls.map((c) => c.name) ?? [], raw, visible,
    // Verified = matched to tool data AND no finding of any kind (a real number
    // misused, e.g. a score shown as a chance, is not a verified claim).
    claims: check.claims.length, grounded: check.claims.filter((c) => c.grounded && !check.findings.some((x) => x.claim === c)).length,
    rawFindings: check.findings.map((x) => ({ kind: x.kind, detail: x.detail, claim: { text: x.claim.text } })),
    leaked, error,
  });
  const tag = error || outcome?.status !== "answered" ? "ERR " : leaked.length ? "LEAK" : check.findings.length ? "FLAG" : "ok  ";
  out(`${tag} ${f.id} [${inputs.at(-1)!.tools.join(", ")}] ${error ?? check.findings.map((x) => `${x.kind}:${x.claim.text}`).join(" ")}`);
}

const report = buildLiveReport(MODEL, inputs, minAccuracy);
emit(report);
if (!report.summary.pass) for (const f of report.summary.failures) out(`FAIL: ${f}`);
process.exit(flag("--strict") && !report.summary.pass ? 1 : 0);
