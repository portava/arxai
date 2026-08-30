// C8 TURN-OF-MONTH — THE OWNER'S PRESS. Not runnable by accident.
//
// READ THIS BEFORE RUNNING ANYTHING HERE
// --------------------------------------
// This script is the only path from a provisioned dataset to a C8 verdict. It
// is gated because a verdict here is meant to be IRREVERSIBLE: a MISS retires
// the experiment, emits an FDR charge against the family, and refuses
// re-evaluation of the same spec on the same data.
//
// WHERE THE "NO SECOND SPIN" PROPERTY ACTUALLY LIVES — say it exactly
// --------------------------------------------------------------------
// `TransferProofHarness` enforces the rule in memory, and that memory dies with
// the process: this script builds a NEW harness on every invocation, so the
// harness alone retires nothing across runs. An earlier version of this header
// asserted cross-run permanence as a fact. It was not one, and stating a safety
// property that does not exist is worse than not having it, because it stops
// anyone looking.
//
// The durable half is `docs/c8-data/verdict-ledger.jsonl` (see
// ./c8VerdictLedger.ts): the verdict phase reads it before the press and
// refuses when this spec+data pair already appears, writes a VERDICT_INTENT row
// BEFORE calling verdict() so a crash mid-press still spends the shot, and
// writes the outcome after. An unreadable ledger or a failed append REFUSES —
// not being able to read the record of the shot is not permission to re-take
// it. The honest limit: it is a committed file. Deleting it to respin is a
// visible act in git history, not an accident.
//
// THE TWO PHASES, AND WHY THEY ARE SEPARATE
// ------------------------------------------
//   --phase evaluate   Reads the holdout, computes the OOS statistics, and
//                      STOPS. Requires --confirm-oos-read. This does not retire
//                      anything and can be re-run — but it is still a real
//                      threshold, because a human who has seen the OOS Sharpe
//                      cannot unsee it, and every later decision is made by
//                      someone who knows the answer.
//
//   --phase verdict    Calls harness.verdict(). THIS IS THE ONE SHOT. Requires
//                      --confirm-one-shot AND a shadow-P&L file.
//
// WHY THE VERDICT PHASE DEMANDS SHADOW DATA — a trap worth naming
// ----------------------------------------------------------------
// The pre-registered pass bar has FOUR clauses and one of them is SHADOW_CI:
// at least `minShadowObservations` live-shadow observations whose 95% CI
// excludes zero from the positive side. The verdict is an AND. So calling
// verdict() with zero shadow observations produces a GUARANTEED MISS — and that
// MISS is terminal: it retires the experiment and charges FDR exactly as a
// real failure would, on a technicality, before the strategy was ever given a
// chance to fail on its merits.
//
// That is not a hypothetical. It is what happens if someone runs this script
// end-to-end the day the data lands. So the verdict phase REFUSES to run
// without at least the pre-registered number of shadow observations, and says
// why. Accruing them is a separate, slower job: shadow the strategy live across
// at least that many month boundaries, recording each boundary's P&L.
//
// THE SECOND GUARANTEED-MISS TRAP: PBO IS DECIDED BEFORE THE HOLDOUT IS READ
// ---------------------------------------------------------------------------
// The shadow clause is not the only clause that can be known-failed in advance,
// and the other one is easier to miss because it looks like an out-of-sample
// measurement. It is not. `TransferProofHarness.evaluate` computes PBO as
// `estimatePbo(input.selectionField, ...)` — from the FIT-STAGE selection field
// ALONE. The OOS returns never enter it. So the PBO clause's pass/fail is fully
// determined by the fit window, i.e. before the holdout is touched at all.
//
// That means a dataset can be arranged such that the verdict is a deterministic
// MISS no matter what the holdout says, and running the runbook end-to-end
// would spend the one shot, retire the niche and charge FDR on a number that
// was knowable an hour earlier for free. Same harm as the shadow trap, same
// remedy: this script computes the fit-stage PBO in step 2, PRINTS it before
// anything irreversible, and the verdict phase REFUSES when it already fails
// the bar. `--accept-certain-miss` is the deliberate override for an owner who
// wants to formally retire an experiment they know cannot pass; it is not a
// default and it names what it is doing.
//
// Nothing in this script places, sizes, or authorises a trade. It reads a
// snapshot file and writes an evidence file plus a ledger row.

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  TURN_OF_MONTH_SPEC,
  TransferProofHarness,
  buildCostModel,
  buildFitSelectionField,
  buildTurnOfMonthEvaluationInput,
  isRefusal,
  isTurnOfMonthBuildRefusal,
  pboPreflight,
  PBO_PREFLIGHT_BLOCKS,
  verifyTurnOfMonthPreRegistration,
} from "@workspace/validation";
import { checkSeriesIntegrity, formatIntegrityReport, parseSnapshot } from "@workspace/markets/daily-series";
import { parseArgv, requireStr } from "./c8DataFeed.js";
import {
  DEFAULT_VERDICT_LEDGER,
  VERDICT_LEDGER_FORMAT,
  describeLedgerEntry,
  findSpentShot,
  parseVerdictLedger,
  serialiseLedgerEntry,
  type VerdictLedgerEntry,
} from "./c8VerdictLedger.js";

const SPEC = TURN_OF_MONTH_SPEC;

/**
 * CSCV block count. The SAME constant the pre-flight uses, passed to the
 * harness, so the number printed in step 2b is the number the PBO clause is
 * later judged on. Step 4 asserts they came out identical.
 */
const PBO_BLOCKS = PBO_PREFLIGHT_BLOCKS;

function line(s = ""): void {
  console.log(s);
}

function usage(): void {
  line("C8 TURN-OF-MONTH EVALUATION — the owner's press");
  line("");
  line("  PHASE 1 (repeatable, but you cannot unsee the answer):");
  line("    node --import tsx scripts/src/c8TurnOfMonthEvaluate.ts \\");
  line("      --phase evaluate --confirm-oos-read \\");
  line("      --snapshot docs/c8-data/<SYMBOL>.snapshot.json \\");
  line("      --at <iso instant> --evidence docs/c8-data/<SYMBOL>.evaluation.json");
  line("");
  line("  PHASE 2 (ONE SHOT — a miss retires the niche and charges FDR):");
  line("    node --import tsx scripts/src/c8TurnOfMonthEvaluate.ts \\");
  line("      --phase verdict --confirm-one-shot \\");
  line("      --snapshot docs/c8-data/<SYMBOL>.snapshot.json \\");
  line(`      --shadow docs/c8-data/<SYMBOL>.shadow.json   # >= ${SPEC.passBar.minShadowObservations} observations`);
  line("      --at <iso instant> --evidence docs/c8-data/<SYMBOL>.verdict.json   # REQUIRED for a verdict");
  line("");
  line("  Both phases refuse without their confirmation flag. --at is always required:");
  line("  the harness never reads a clock.");
  line("");
  line("  Other flags:");
  line(`    --ledger <path>          the durable one-shot record (default ${DEFAULT_VERDICT_LEDGER}).`);
  line("                             The verdict phase refuses if this spec+data pair is already in it.");
  line("    --accept-certain-miss    proceed to a verdict whose PBO clause is ALREADY known to fail from");
  line("                             the fit window alone. Spends the shot on a foregone MISS, deliberately.");
}

/** Shadow P&L file: a JSON array of numbers, or of {pnl:number} objects. */
function parseShadow(text: string): number[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("shadow file must be a JSON array");
  return raw.map((r, i) => {
    const v = typeof r === "number" ? r : (r as { pnl?: unknown })?.pnl;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`shadow observation ${i} is not a finite number — a NaN observation is a failed read, not evidence`);
    }
    return v;
  });
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const phase = argv.phase;
  if (phase !== "evaluate" && phase !== "verdict") {
    usage();
    return 2;
  }
  if (typeof argv.at !== "string") {
    line("REFUSED: --at <iso instant> is required. This path never reads a clock.");
    return 2;
  }
  const at = argv.at;

  if (phase === "evaluate" && argv["confirm-oos-read"] !== true) {
    line("REFUSED: --phase evaluate needs --confirm-oos-read.");
    line("Reading the holdout is a threshold: once you have seen the out-of-sample result, every later");
    line("decision is made by someone who knows the answer. Confirm deliberately.");
    return 2;
  }
  if (phase === "verdict" && argv["confirm-one-shot"] !== true) {
    line("REFUSED: --phase verdict needs --confirm-one-shot.");
    line("A verdict is irreversible: a MISS retires the experiment, charges the family's FDR, and this script");
    line("will refuse to re-run the same spec on this data (see the one-shot ledger). Confirm deliberately.");
    return 2;
  }

  const evidencePath = typeof argv.evidence === "string" && argv.evidence.length > 0 ? argv.evidence : undefined;
  if (phase === "verdict" && evidencePath === undefined) {
    line("REFUSED: --phase verdict needs --evidence <path>.");
    line("The shot may not be spent without writing down what it produced. An unrecorded verdict is a decision");
    line("nobody can audit and a retirement nobody can point at — the evidence file is not optional here.");
    return 2;
  }

  const ledgerPath = typeof argv.ledger === "string" && argv.ledger.length > 0 ? argv.ledger : DEFAULT_VERDICT_LEDGER;
  const ledger = await readLedger(ledgerPath);
  if (!ledger.ok) {
    line(`REFUSED: the one-shot ledger at ${resolvePath(ledgerPath)} could not be read — ${ledger.detail}`);
    line("Fail closed. Not being able to read the record of whether the shot was already taken is not");
    line("permission to take it again.");
    return 2;
  }

  // ── 0. pre-registration ───────────────────────────────────────────────────
  line("0. PRE-REGISTRATION");
  const pre = verifyTurnOfMonthPreRegistration();
  if (!pre.intact) {
    line(`   REFUSED — ${pre.detail}`);
    return 1;
  }
  line(`   intact: ${pre.specHash}`);
  line(`   ${SPEC.experimentKey}`);
  line(`   instrument ${SPEC.instrument} (${SPEC.instrumentClass}), size ${SPEC.size}`);
  line(`   rule "${SPEC.calendarRule}"  offsets entry ${SPEC.entryOffsetDays}, exit ${SPEC.exitOffsetDays}`);
  line(`   fit ${SPEC.fitWindow.start}..${SPEC.fitWindow.end}, holdout ${SPEC.holdoutWindow.start}..${SPEC.holdoutWindow.end}`);
  line(
    `   pass bar: netDSR >= ${SPEC.passBar.minNetDsr}, PBO < ${SPEC.passBar.maxPbo}, ` +
      `netSharpe >= ${SPEC.passBar.minNetSharpe}, shadow n >= ${SPEC.passBar.minShadowObservations}`,
  );
  line();

  // ── 1. the dataset ────────────────────────────────────────────────────────
  const snapshotPath = requireStr(argv, "snapshot");
  const snap = parseSnapshot(await readFile(snapshotPath, "utf8"));
  if (!snap.ok) {
    line(`1. DATASET — REFUSED ${snap.code}: ${snap.detail}`);
    return 1;
  }
  line("1. DATASET");
  line(`   ${snapshotPath}`);
  line(`   symbol ${snap.series.symbol}, adjustment ${snap.series.provenance.adjustment}, terms ${snap.series.provenance.termsOfUse}`);
  line(`   source ${snap.series.provenance.source} via ${snap.series.provenance.request}`);
  line(`   fetchedAt ${snap.series.provenance.fetchedAt}`);
  line(`   ${snap.series.provenance.detail}`);
  if (snap.series.provenance.termsOfUse === "UNVERIFIED") {
    line("   NOTE: this dataset's licence is UNVERIFIED. That is an owner gate before it backs capital.");
  }
  if (snap.series.symbol !== SPEC.instrument) {
    line(
      `   NOTE: the pre-registered instrument is "${SPEC.instrument}" and this dataset is "${snap.series.symbol}". ` +
        "The spec's notes leave the venue instrument to the owner; this substitution is the owner's call and is recorded here, not decided here.",
    );
  }
  const integrity = checkSeriesIntegrity(snap.series, {
    requiredCoverage: [
      { label: "fitWindow", start: SPEC.fitWindow.start, end: SPEC.fitWindow.end },
      { label: "holdoutWindow", start: SPEC.holdoutWindow.start, end: SPEC.holdoutWindow.end },
    ],
  });
  line("   INTEGRITY GUARD");
  line(formatIntegrityReport(integrity));
  if (!integrity.ok) {
    line("   REFUSED: the dataset does not pass the integrity guard. No evaluation runs on refused data.");
    return 1;
  }
  line();

  // ── 2. the fit-stage selection field (PBO's input) ────────────────────────
  const costModel = buildCostModel({
    instrument: SPEC.instrument,
    instrumentClass: SPEC.instrumentClass,
    venue: typeof argv.venue === "string" ? argv.venue : "unpriced-research-venue",
  });
  const selection = buildFitSelectionField(snap.series.bars, SPEC, SPEC.fitWindow, costModel);
  line("2. FIT-STAGE SELECTION FIELD (for PBO)");
  line(
    `   ${selection.variants.length} variants over ${selection.commonBoundaryMonths.length} common boundary months; ` +
      `the pre-registered variant is index ${selection.specVariantIndex}`,
  );
  if (selection.specVariantIndex < 0) {
    line("   REFUSED: the pre-registered (entry, exit) offsets are not in the declared fit grid.");
    line("   PBO against a field the search never contained is measuring a fiction.");
    return 1;
  }
  line(
    `   costs applied to every variant row: perSide ${costModel.perSideCostFrac.toFixed(6)} ` +
      `(spread ${costModel.spread.provenance}, slippage ${costModel.slippage.provenance}, commission ${costModel.commission.provenance})`,
  );
  line();

  // ── 2b. PBO PRE-FLIGHT — the clause that is decided before the holdout ─────
  // PBO is a property of the SELECTION, not of the out-of-sample track: the
  // harness computes it from this field alone. So its verdict is knowable right
  // now, for free, and printing it here is what stops the runbook from spending
  // the one shot on an arithmetic certainty.
  const fitPbo = pboPreflight(selection.field, SPEC, PBO_BLOCKS);
  const pboClauseWouldPass = fitPbo.wouldPass;
  line("2b. PBO PRE-FLIGHT (decided by the FIT window alone — no holdout involved)");
  line(
    `   PBO ${Number.isFinite(fitPbo.pbo) ? fitPbo.pbo.toFixed(6) : "UNMEASURABLE"}   ` +
      `(bar < ${SPEC.passBar.maxPbo})   medianOosRank ` +
      `${Number.isFinite(fitPbo.medianOosRank) ? fitPbo.medianOosRank.toFixed(6) : "n/a"}, ` +
      `${fitPbo.combinations} CSCV partition(s) over ${fitPbo.blocks} blocks`,
  );
  line(`   ${fitPbo.detail}`);
  line(`   the PBO clause of the pass bar WOULD ${pboClauseWouldPass ? "PASS" : "FAIL"} on this dataset, today`);
  if (!pboClauseWouldPass) {
    line("   WARNING — THE VERDICT IS ALREADY DECIDED. The pass bar is an AND. This clause fails from the fit");
    line("   window alone, so no holdout result of any kind can produce a PASS. Seeking a verdict on this data");
    line("   spends the one shot on a foregone MISS: it retires the experiment and charges the family's FDR for");
    line("   a number that did not need the holdout to be known. The honest moves are to change the DATASET or");
    line("   the pre-registered SEARCH (a new experiment key, not a re-pinned hash) — not to press on.");
  }
  line();

  if (phase === "verdict" && !pboClauseWouldPass && argv["accept-certain-miss"] !== true) {
    line("VERDICT — REFUSED: the PBO clause already fails from the fit window alone.");
    line(
      `   PBO ${Number.isFinite(fitPbo.pbo) ? fitPbo.pbo.toFixed(6) : "UNMEASURABLE"} against a bar of < ${SPEC.passBar.maxPbo}. ` +
        "The pass bar is an AND, and this clause does not read the holdout, so the verdict is a MISS before",
    );
    line("   the holdout is opened. This script will not spend the one shot on a foregone conclusion.");
    line("   If you intend to formally retire this experiment anyway, re-run with --accept-certain-miss.");
    line("   Nothing has been retired and no FDR has been charged. The holdout was NOT read on this run.");
    return 2;
  }

  // ── 3. the OOS input ──────────────────────────────────────────────────────
  const build = buildTurnOfMonthEvaluationInput(snap.series.bars, SPEC, SPEC.holdoutWindow, {
    at,
    costModel,
    fingerprintSymbol: snap.series.symbol,
    fingerprintAdjustment: snap.series.provenance.adjustment,
    // The experiment itself is a trial, and the fit grid was searched. Charging
    // the DSR only for the one variant would understate the multiplicity.
    nTrials: selection.variants.length,
    selectionField: selection.field,
    pboBlocks: PBO_BLOCKS,
  });
  if (isTurnOfMonthBuildRefusal(build)) {
    line(`3. OOS TRACK — REFUSED ${build.code}: ${build.detail}`);
    return 1;
  }
  line("3. OOS TRACK");
  line(`   ${build.trades.length} round trips, ${build.skipped.length} boundary/boundaries skipped at the window seams`);
  for (const s of build.skipped) line(`     SKIPPED ${s.boundaryMonth} (${s.reason})`);
  line(`   data window ${build.input.dataWindow.start}..${build.input.dataWindow.end}`);
  line(`   dataFingerprint ${build.input.dataFingerprint}`);
  line(`   total cost charged over the track ${build.totalCostCharged.toFixed(6)}`);
  line();

  // ── 3b. THE ONE-SHOT LEDGER — the durable no-respin memory ────────────────
  // The harness's own `retiredOnData` set dies with this process, so on its own
  // it retires nothing across runs. This is the check that actually spans them.
  const spent = findSpentShot(ledger.entries, pre.specHash, build.input.dataFingerprint);
  line("3b. ONE-SHOT LEDGER");
  line(`   ${resolvePath(ledgerPath)}  (${ledger.entries.length} row(s)${ledger.existed ? "" : ", file does not exist yet"})`);
  if (spent) {
    line(`   THIS SPEC + THIS DATA IS ALREADY IN THE LEDGER:`);
    line(`     ${describeLedgerEntry(spent)}`);
    if (phase === "verdict") {
      line("   VERDICT — REFUSED. The shot on this spec and this dataset has been taken. Re-running it would be");
      line("   a second spin on the same pre-registration, which is the one thing this apparatus exists to prevent.");
      line("   A genuine change of mind is a NEW experiment key on NEW data, not a repeat of this command.");
      return 2;
    }
    line("   NOTE: re-reading the holdout is allowed and retires nothing, but the verdict phase will refuse.");
  } else {
    line("   no prior row for this spec+data pair — the shot is unspent");
  }
  line();

  // ── 4. register + evaluate ────────────────────────────────────────────────
  const harness = new TransferProofHarness();
  const reg = harness.register(SPEC, at);
  if (isRefusal(reg)) {
    line(`4. REGISTER — REFUSED ${reg.code}: ${reg.detail}`);
    return 1;
  }
  const ev = harness.evaluate(SPEC, build.input);
  if (isRefusal(ev)) {
    line(`4. EVALUATE — REFUSED ${ev.code}: ${ev.detail}`);
    return 1;
  }
  const e = ev.evaluation!;
  line("4. EVALUATION (out of sample, net of costs)");
  line(`   observations ${e.nObs} over ${e.dataWindow.start}..${e.dataWindow.end}`);
  line(`   net Sharpe   ${e.netSharpe.toFixed(6)}   (bar >= ${SPEC.passBar.minNetSharpe})`);
  line(`   net DSR      ${e.netDsr.toFixed(6)}   (bar >= ${SPEC.passBar.minNetDsr})`);
  line(
    `   PBO          ${Number.isFinite(e.pbo) ? e.pbo.toFixed(6) : "UNMEASURABLE"}   (bar < ${SPEC.passBar.maxPbo})`,
  );
  line(`   cost model   ${e.costModelHash}`);
  line();

  // The pre-flight and the clause must be the same number, or the pre-flight is
  // reassurance about a different quantity. Both come from the same field and
  // the same block count, so a divergence means one of them changed.
  if (Number.isFinite(e.pbo) !== Number.isFinite(fitPbo.pbo) || (Number.isFinite(e.pbo) && e.pbo !== fitPbo.pbo)) {
    line(
      `   REFUSED: the pre-flight PBO (${fitPbo.pbo}) and the harness's PBO (${e.pbo}) disagree. They are computed ` +
        "from the same selection field with the same block count and must be identical; a divergence means the",
    );
    line("   pre-flight guard is no longer guarding the clause it claims to guard. Nothing has been retired.");
    return 1;
  }

  if (phase === "evaluate") {
    line("PHASE STOPS HERE. No verdict has been issued and nothing has been retired.");
    line(
      `To reach a verdict the SHADOW_CI clause needs at least ${SPEC.passBar.minShadowObservations} live-shadow ` +
        "observations; calling verdict() with none is a guaranteed MISS on a technicality.",
    );
    if (evidencePath !== undefined) await writeEvidence(evidencePath, { phase, at, harness, build, integrity, snapshotPath });
    return 0;
  }

  // ── 5. shadow observations — required before a verdict may be sought ──────
  // The real refusal for a missing --evidence happened before the OOS read; this
  // is the same condition restated where the type system can see it, so that no
  // future edit can reach the press with nowhere to write the result.
  if (evidencePath === undefined) {
    line("5. VERDICT — REFUSED: --evidence <path> is required. The shot is not spent without a written record.");
    return 2;
  }
  const shadowPath = typeof argv.shadow === "string" ? argv.shadow : undefined;
  if (shadowPath === undefined) {
    line("5. VERDICT — REFUSED: no --shadow file.");
    line(
      `   The pass bar is an AND over four clauses and one of them needs >= ${SPEC.passBar.minShadowObservations} ` +
        "live-shadow observations. Seeking a verdict without them GUARANTEES a MISS, and that MISS retires the",
    );
    line("   experiment and charges FDR exactly as a real failure would. This script will not spend the shot that way.");
    return 2;
  }
  const shadow = parseShadow(await readFile(shadowPath, "utf8"));
  if (shadow.length < SPEC.passBar.minShadowObservations) {
    line(
      `5. VERDICT — REFUSED: ${shadow.length} shadow observation(s) < the pre-registered ${SPEC.passBar.minShadowObservations}.`,
    );
    return 2;
  }
  for (const pnl of shadow) {
    const r = harness.recordShadowPnl(reg.specHash, pnl, at);
    if (isRefusal(r)) {
      line(`5. SHADOW — REFUSED ${r.code}: ${r.detail}`);
      return 1;
    }
  }
  line(`5. SHADOW: ${shadow.length} observation(s) accrued from ${shadowPath}`);
  line();

  // ── 6. THE VERDICT ────────────────────────────────────────────────────────
  // The INTENT row goes down FIRST. If this process dies between here and the
  // outcome row, the pair is still marked spent — a crash mid-press must not
  // hand the shot back. A failed append refuses before anything is spent.
  if (reg.specHash !== pre.specHash) {
    line(`6. VERDICT — REFUSED: the registered spec hash ${reg.specHash} is not the locked ${pre.specHash}.`);
    line("   The ledger check in step 3b was keyed on the locked hash, so proceeding would spend a shot the");
    line("   ledger was not consulted about.");
    return 1;
  }
  const base = {
    format: VERDICT_LEDGER_FORMAT,
    experimentKey: SPEC.experimentKey,
    specHash: reg.specHash,
    dataFingerprint: build.input.dataFingerprint,
    at,
    evidence: resolvePath(evidencePath),
  } as const;
  const intent = await appendLedger(ledgerPath, { ...base, kind: "VERDICT_INTENT" });
  if (!intent.ok) {
    line(`6. VERDICT — REFUSED: could not write the one-shot ledger at ${resolvePath(ledgerPath)} — ${intent.detail}`);
    line("   Fail closed. A verdict that cannot be recorded as taken is a verdict that can be taken twice.");
    return 2;
  }

  const verdict = harness.verdict(reg.specHash, at);
  if (isRefusal(verdict)) {
    line(`6. VERDICT — REFUSED ${verdict.code}: ${verdict.detail}`);
    line("   NOTE: the VERDICT_INTENT row is already in the ledger and this spec+data pair now counts as spent.");
    line("   That is deliberate — the alternative is a refusal path that quietly restores the shot.");
    return 1;
  }
  line("6. VERDICT");
  line(`   ${verdict.verdict}  ${verdict.experimentKey}`);
  for (const c of verdict.clauses) {
    line(`     ${c.pass ? "pass" : "FAIL"}  ${c.clause.padEnd(12)} ${c.bar.padEnd(44)} ${c.detail}`);
  }
  line(`   ${verdict.detail}`);
  if (verdict.fdrCharge) {
    line(`   FDR charge emitted: key ${verdict.fdrCharge.key}, p ${verdict.fdrCharge.p.toFixed(6)}`);
    line("   Feed this to lib/discovery controlFdr — choosing this niche was itself a trial.");
  }
  await writeEvidence(evidencePath, { phase, at, harness, build, integrity, snapshotPath, verdict });

  const outcome = await appendLedger(ledgerPath, {
    ...base,
    kind: "VERDICT",
    verdict: verdict.verdict,
    detail: verdict.detail,
  });
  if (!outcome.ok) {
    line(`   WARNING: the outcome row could not be appended to the ledger — ${outcome.detail}`);
    line("   The VERDICT_INTENT row IS there, so the shot is correctly recorded as spent; what is missing is the");
    line(`   outcome. The full result is in ${resolvePath(evidencePath)}. Reconcile the ledger by hand.`);
    return 1;
  }
  line(`   LEDGER: the shot is recorded at ${resolvePath(ledgerPath)}. Commit it — that record is the no-respin rule.`);
  return 0;
}

// ── the one-shot ledger's I/O (the parsing and shapes live in ./c8VerdictLedger.ts) ──

type LedgerRead =
  | { ok: true; entries: VerdictLedgerEntry[]; existed: boolean }
  | { ok: false; detail: string };

/**
 * A missing file is an EMPTY ledger — the first shot has to be able to happen.
 * Every other failure (permissions, a directory in the way, an unparsable line)
 * REFUSES: an unreadable record of the shot is not evidence it was not taken.
 */
async function readLedger(path: string): Promise<LedgerRead> {
  let text: string;
  try {
    text = await readFile(resolvePath(path), "utf8");
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return { ok: true, entries: [], existed: false };
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const parsed = parseVerdictLedger(text);
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  return { ok: true, entries: parsed.entries, existed: true };
}

async function appendLedger(path: string, entry: VerdictLedgerEntry): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const abs = resolvePath(path);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, serialiseLedgerEntry(entry), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function writeEvidence(
  path: string,
  data: Record<string, unknown> & { harness: TransferProofHarness },
): Promise<void> {
  const abs = resolvePath(path);
  await mkdir(dirname(abs), { recursive: true });
  const { harness, ...rest } = data;
  await writeFile(abs, JSON.stringify({ ...rest, chain: harness.chain() }, null, 2) + "\n", "utf8");
  line(`EVIDENCE written to ${abs}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(`c8TurnOfMonthEvaluate FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 2;
  });
