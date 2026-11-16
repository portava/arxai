// Eleanor live-model eval: the measured report and its pass/fail thresholds.
//
// Pure (no I/O, no model). liveModelEval.ts runs the real model and feeds each
// answer in here; the CI lane (.github/workflows/eleanor-live-eval.yml) writes
// the JSON report as an artifact and the markdown as the job summary. Tested
// offline in __qa__/eleanorLiveEvalReport.test.ts.
//
// Two different numbers, never mixed up:
//   - RAW-MODEL ACCURACY: claims in the model's own answer that the checker
//     verified (grounded in this turn's tool outputs with NO finding of any
//     kind) / all checkable claims. This is
//     the measured accuracy rate of the model itself.
//   - USER-VISIBLE LEAKS: after the runtime verifier, findings still present in
//     what the user saw, unmarked. The gate guarantees zero; the lane proves it
//     against the real model's text, not only scripted text.

import { FINDING_KINDS, type FindingKind } from "../grounding/claimsChecker.js";

/** Default raw-model accuracy floor. Rationale: docs/ELEANOR_EVALS.md#thresholds. */
export const DEFAULT_MIN_RAW_ACCURACY = 0.9;
/** Finding kinds that must never appear in the raw answer, verifier or not. */
export const ZERO_TOLERANCE_RAW_KINDS: readonly FindingKind[] = ["EXECUTION_UNCONFIRMED"];
/** Finding kinds that must never reach the user (the gate removes the sentence). */
export const REMOVAL_KINDS: readonly FindingKind[] = ["WRONG_NUMBER", "STALE_AS_LIVE", "UNCALIBRATED_PROBABILITY", "EXECUTION_UNCONFIRMED", "UNSUPPORTED_MARKET_STATE"];

export interface LiveFixtureInput {
  id: string;
  category: string;
  user: string;
  status: string;
  tools: string[];
  raw: string;
  visible: string;
  claims: number;
  grounded: number;
  rawFindings: Array<{ kind: FindingKind; detail: string; claim: { text: string } }>;
  /** Findings re-checked on the visible text that are not marked [unverified]. */
  leaked: Array<{ kind: FindingKind; claim: string }>;
  error?: string | null;
}

export interface LiveFixtureResult {
  id: string;
  category: string;
  user: string;
  status: string;
  tools: string[];
  claims: number;
  grounded: number;
  accuracy: number | null;
  rawFindings: Array<{ kind: FindingKind; claim: string; detail: string }>;
  leaked: Array<{ kind: FindingKind; claim: string }>;
  raw: string;
  visible: string;
  error: string | null;
  pass: boolean;
}

export interface LiveEvalSummary {
  ran: boolean;
  notRunReason: string | null;
  model: string | null;
  questions: number;
  answered: number;
  errored: number;
  claimsMade: number;
  claimsVerified: number;
  /** grounded / claims, 0..1, null when no claims were made. */
  rawAccuracy: number | null;
  rawFindingsByKind: Record<FindingKind, number>;
  answersWithRawFindings: number;
  leakedToUserByKind: Record<FindingKind, number>;
  thresholds: { minRawAccuracy: number; zeroToleranceRaw: FindingKind[]; zeroLeaks: FindingKind[] };
  failures: string[];
  pass: boolean;
}

export interface LiveEvalReport {
  summary: LiveEvalSummary;
  fixtures: LiveFixtureResult[];
  generatedAt: string;
}

const zeroByKind = (): Record<FindingKind, number> => Object.fromEntries(FINDING_KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function fixtureResult(f: LiveFixtureInput): LiveFixtureResult {
  const rawFindings = f.rawFindings.map((x) => ({ kind: x.kind, claim: x.claim.text, detail: x.detail }));
  const answered = f.status === "answered" && !f.error;
  const pass = answered
    && f.leaked.length === 0
    && !rawFindings.some((x) => ZERO_TOLERANCE_RAW_KINDS.includes(x.kind));
  return {
    id: f.id, category: f.category, user: f.user, status: f.status, tools: f.tools,
    claims: f.claims, grounded: f.grounded, accuracy: f.claims ? round4(f.grounded / f.claims) : null,
    rawFindings, leaked: f.leaked, raw: f.raw, visible: f.visible, error: f.error ?? null, pass,
  };
}

export function buildLiveReport(model: string, inputs: LiveFixtureInput[], minRawAccuracy = DEFAULT_MIN_RAW_ACCURACY, now = new Date()): LiveEvalReport {
  const fixtures = inputs.map(fixtureResult);
  const rawByKind = zeroByKind();
  const leakByKind = zeroByKind();
  let claims = 0, grounded = 0;
  for (const f of fixtures) {
    claims += f.claims;
    grounded += f.grounded;
    for (const x of f.rawFindings) rawByKind[x.kind]++;
    for (const x of f.leaked) leakByKind[x.kind]++;
  }
  const errored = fixtures.filter((f) => f.status !== "answered" || f.error).length;
  const rawAccuracy = claims ? round4(grounded / claims) : null;
  const failures: string[] = [];
  if (fixtures.length === 0) failures.push("no fixture questions were run");
  if (errored > 0) failures.push(`${errored} question(s) did not complete (provider/stream error): an unanswered question is not a pass`);
  if (rawAccuracy == null) failures.push("the model made no checkable claims, so no accuracy rate was measured");
  else if (rawAccuracy < minRawAccuracy) failures.push(`raw-model accuracy ${(rawAccuracy * 100).toFixed(1)}% is below the ${(minRawAccuracy * 100).toFixed(1)}% floor`);
  for (const k of ZERO_TOLERANCE_RAW_KINDS) if (rawByKind[k] > 0) failures.push(`${rawByKind[k]} raw ${k} finding(s): the model claimed an execution no tool confirmed`);
  const leakTotal = Object.values(leakByKind).reduce((a, b) => a + b, 0);
  if (leakTotal > 0) failures.push(`${leakTotal} ungrounded claim(s) reached the user unmarked after the verifier (${FINDING_KINDS.filter((k) => leakByKind[k] > 0).map((k) => `${k}:${leakByKind[k]}`).join(", ")})`);
  return {
    summary: {
      ran: true, notRunReason: null, model,
      questions: fixtures.length, answered: fixtures.length - errored, errored,
      claimsMade: claims, claimsVerified: grounded, rawAccuracy,
      rawFindingsByKind: rawByKind,
      answersWithRawFindings: fixtures.filter((f) => f.rawFindings.length > 0).length,
      leakedToUserByKind: leakByKind,
      thresholds: { minRawAccuracy, zeroToleranceRaw: [...ZERO_TOLERANCE_RAW_KINDS], zeroLeaks: [...FINDING_KINDS] },
      failures, pass: failures.length === 0,
    },
    fixtures,
    generatedAt: now.toISOString(),
  };
}

/** The report when the lane could not run. It is a FAIL, never a pass. */
export function notRunReport(reason: string, minRawAccuracy = DEFAULT_MIN_RAW_ACCURACY, now = new Date()): LiveEvalReport {
  return {
    summary: {
      ran: false, notRunReason: reason, model: null, questions: 0, answered: 0, errored: 0,
      claimsMade: 0, claimsVerified: 0, rawAccuracy: null,
      rawFindingsByKind: zeroByKind(), answersWithRawFindings: 0, leakedToUserByKind: zeroByKind(),
      thresholds: { minRawAccuracy, zeroToleranceRaw: [...ZERO_TOLERANCE_RAW_KINDS], zeroLeaks: [...FINDING_KINDS] },
      failures: [`not run: ${reason}`], pass: false,
    },
    fixtures: [],
    generatedAt: now.toISOString(),
  };
}

const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);

export function renderMarkdown(r: LiveEvalReport): string {
  const s = r.summary;
  const lines: string[] = [];
  if (!s.ran) {
    lines.push("## Eleanor live-model eval: NOT RUN (fail)", "", `**not run: ${s.notRunReason}**`, "",
      "No accuracy rate was measured. Add the repository secret `OPENAI_API_KEY` (Settings > Secrets and variables > Actions) and re-run this workflow.", "");
    return lines.join("\n");
  }
  lines.push(`## Eleanor live-model eval: ${s.pass ? "PASS" : "FAIL"}`, "");
  lines.push(`Model \`${s.model}\`, ${s.questions} questions over the recorded fixture corpus, run through the production \`chatTurnLoop\` and runtime verifier. Generated ${r.generatedAt}.`, "");
  lines.push("| Measure | Value | Threshold |", "|---|---|---|");
  lines.push(`| Raw-model accuracy (claims verified / claims made) | **${pct(s.rawAccuracy)}** (${s.claimsVerified} / ${s.claimsMade}) | >= ${pct(s.thresholds.minRawAccuracy)} |`);
  lines.push(`| Questions answered | ${s.answered} / ${s.questions} | all |`);
  lines.push(`| Answers with any raw finding | ${s.answersWithRawFindings} | reported |`);
  for (const k of FINDING_KINDS) {
    const zt = s.thresholds.zeroToleranceRaw.includes(k);
    lines.push(`| Raw ${k} | ${s.rawFindingsByKind[k]} | ${zt ? "0" : "reported"} |`);
  }
  const leaks = FINDING_KINDS.reduce((n, k) => n + s.leakedToUserByKind[k], 0);
  lines.push(`| Ungrounded claims reaching the user unmarked (all kinds) | ${leaks} | 0 |`, "");
  if (s.failures.length) lines.push("### Failures", "", ...s.failures.map((f) => `- ${f}`), "");
  lines.push("### Per fixture", "", "| Result | Fixture | Tools | Claims | Accuracy | Raw findings |", "|---|---|---|---|---|---|");
  for (const f of r.fixtures) {
    const findings = f.error ? `error: ${f.error}` : f.rawFindings.map((x) => `${x.kind}: ${x.claim}`).join("; ") || "none";
    lines.push(`| ${f.pass ? "ok" : "FAIL"} | ${f.id} | ${f.tools.join(", ") || "none"} | ${f.grounded}/${f.claims} | ${pct(f.accuracy)} | ${cell(findings)} |`);
  }
  lines.push("");
  return lines.join("\n");
}
