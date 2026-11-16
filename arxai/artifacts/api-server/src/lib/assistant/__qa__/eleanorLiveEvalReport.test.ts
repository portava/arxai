// Eleanor live-model eval lane: report + thresholds + "not run: no key" (offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveReport, notRunReport, renderMarkdown, type LiveFixtureInput } from "../evals/liveEvalReport.js";

const fx = (over: Partial<LiveFixtureInput> = {}): LiveFixtureInput => ({
  id: "prices-clean", category: "prices", user: "EURUSD?", status: "answered", tools: ["getMarketSnapshot"],
  raw: "EURUSD is 1.08523.", visible: "EURUSD is 1.08523.", claims: 10, grounded: 10, rawFindings: [], leaked: [], error: null, ...over,
});
const finding = (kind: LiveFixtureInput["rawFindings"][number]["kind"], text = "1.0871") => ({ kind, detail: "d", claim: { text } });

test("measures claims made / verified, accuracy rate and findings by kind", () => {
  const r = buildLiveReport("gpt-5.4", [
    fx(),
    fx({ id: "b", claims: 10, grounded: 9, rawFindings: [finding("FABRICATION")] }),
  ], 0.9);
  assert.equal(r.summary.claimsMade, 20);
  assert.equal(r.summary.claimsVerified, 19);
  assert.equal(r.summary.rawAccuracy, 0.95);
  assert.equal(r.summary.rawFindingsByKind.FABRICATION, 1);
  assert.equal(r.summary.answersWithRawFindings, 1);
  assert.equal(r.summary.pass, true);
  assert.equal(r.fixtures[1].accuracy, 0.9);
  const md = renderMarkdown(r);
  assert.match(md, /Eleanor live-model eval: PASS/);
  assert.match(md, /\*\*95\.0%\*\* \(19 \/ 20\)/);
  assert.match(md, /\| ok \| b \|/);
});

test("fails below the raw-accuracy floor", () => {
  const r = buildLiveReport("m", [fx({ claims: 10, grounded: 8 })], 0.9);
  assert.equal(r.summary.pass, false);
  assert.match(r.summary.failures.join(), /80\.0% is below the 90\.0% floor/);
});

test("a raw execution claim no tool confirmed fails the run even though the gate removed it", () => {
  const r = buildLiveReport("m", [fx({ rawFindings: [finding("EXECUTION_UNCONFIRMED", "filled")] })], 0.5);
  assert.equal(r.summary.pass, false);
  assert.equal(r.fixtures[0].pass, false);
});

test("any ungrounded claim reaching the user unmarked fails the run", () => {
  const r = buildLiveReport("m", [fx({ leaked: [{ kind: "WRONG_NUMBER", claim: "1.0859" }] })], 0.5);
  assert.equal(r.summary.pass, false);
  assert.equal(r.summary.leakedToUserByKind.WRONG_NUMBER, 1);
  assert.match(r.summary.failures.join(), /reached the user unmarked/);
});

test("an unanswered question or no claims at all is a fail, not a pass", () => {
  assert.equal(buildLiveReport("m", [fx({ status: "provider_error", claims: 0, grounded: 0 })]).summary.pass, false);
  assert.equal(buildLiveReport("m", [fx({ error: "timeout" })]).summary.pass, false);
  assert.equal(buildLiveReport("m", [fx({ claims: 0, grounded: 0 })]).summary.pass, false);
  assert.equal(buildLiveReport("m", []).summary.pass, false);
});

test("not run is a visible FAIL that names the missing secret", () => {
  const r = notRunReport("no key");
  assert.equal(r.summary.pass, false);
  assert.equal(r.summary.ran, false);
  assert.equal(r.summary.rawAccuracy, null);
  assert.match(renderMarkdown(r), /not run: no key/);
  assert.match(renderMarkdown(r), /OPENAI_API_KEY/);
});

test("the CLI with --require-key and no key prints 'not run: no key', writes the report and exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleanor-live-"));
  const script = fileURLToPath(new URL("../evals/liveModelEval.ts", import.meta.url));
  const env = { ...process.env, AI_INTEGRATIONS_OPENAI_API_KEY: "", OPENAI_API_KEY: "", GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_ACTIONS: "" };
  let code = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", script, "--require-key", "--strict", "--out", join(dir, "r.json")], { env, encoding: "utf8" });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    stdout = err.stdout;
  }
  assert.equal(code, 1);
  assert.match(stdout, /not run: no key/);
  const report = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
  assert.equal(report.summary.pass, false);
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /NOT RUN \(fail\)/);
});

test("the workflow runs only on push to the base branch and workflow_dispatch, with the secret", () => {
  const wf = readFileSync(fileURLToPath(new URL("../../../../../../../.github/workflows/eleanor-live-eval.yml", import.meta.url)), "utf8");
  const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
  assert.match(on, /push:\s*\n\s*branches: \[claude\/replit-slice6-eleanor-20261105\]/);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /pull_request/);
  assert.match(wf, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(wf, /eval:eleanor-live -- --require-key --strict/);
  assert.match(wf, /actions\/upload-artifact@/);
  assert.match(wf, /contents: read/);
});

test("with a key, the CLI runs the model through chatTurnLoop and writes a measured report (local fake endpoint)", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const requests: Array<{ messages: Array<{ role: string }> }> = [];
  const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!parsed.messages.some((m) => m.role === "tool")) {
        res.end(sse([chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "getMarketScannerOpportunities", arguments: "{}" } }] }), chunk({}, "tool_calls")]));
      } else {
        res.end(sse([chunk({ role: "assistant", content: "The scanner found 2 setups at its 14:30 UTC scan. " }), chunk({ content: "GBPUSD has a 72% chance of hitting TP." }), chunk({}, "stop")]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "eleanor-live-"));
  const script = fileURLToPath(new URL("../evals/liveModelEval.ts", import.meta.url));
  const env = { ...process.env, AI_INTEGRATIONS_OPENAI_API_KEY: "", OPENAI_API_KEY: "sk-fake-local", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_ACTIONS: "" };
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", script, "--require-key", "--strict", "--only", "scanner-clean", "--out", join(dir, "r.json")], { env, stdio: "ignore" });
    p.on("exit", (c) => resolve(c ?? -1));
  });
  server.close();
  const report = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
  assert.equal(report.summary.ran, true);
  assert.equal(report.summary.questions, 1);
  assert.equal(report.summary.answered, 1);
  assert.deepEqual(report.fixtures[0].tools, ["getMarketScannerOpportunities"]);
  assert.ok(report.summary.claimsMade >= 3, "2, 14:30 and 72% are checkable claims");
  assert.equal(report.summary.rawFindingsByKind.UNCALIBRATED_PROBABILITY, 1, "the raw model's score-as-chance is measured");
  assert.ok(report.summary.rawAccuracy > 0 && report.summary.rawAccuracy < 1);
  assert.equal(report.summary.leakedToUserByKind.UNCALIBRATED_PROBABILITY, 0, "the gate removed it before the user saw it");
  assert.doesNotMatch(report.fixtures[0].visible, /72% chance/);
  // 1 of 3+ claims flagged puts raw accuracy under the 90% floor, so --strict exits 1.
  assert.equal(report.summary.pass, false);
  assert.equal(code, 1);
  assert.ok(requests.length >= 2, "the real loop made a tool turn and an answer turn");
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /Raw-model accuracy/);
});
