import { and, eq, isNull, lte } from "drizzle-orm";
import { atiShadowObservationsTable as observations, atiShadowRunsTable as runs, db } from "@workspace/db";
import type { DecisionCandidate } from "@workspace/domain/self-trade";
import { resolveDerivSymbol } from "../data/providers/derivProvider.js";
import { atiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { atiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { gradeAtiDerivReplay, loadAtiDerivReplayQuotes } from "./atiDerivQuoteReplay.js";
import { gradeAtiMt5Replay, loadAtiMt5ReplayQuotes, type AtiMt5ReplayQuote } from "./atiMt5QuoteReplay.js";
import { selectAtiMeasuredCosts, measuredRoundTripCosts, type AtiMeasuredCostProfile } from "./atiMeasuredCosts.js";
import { ATI_SHADOW_HOLD_WINDOW_MS, frozenAtiBracket, isAtiEntryDecision, type AtiAssumedCosts } from "./atiShadowGrading.js";
import { guardianComparisonPolicy, replayGuardianPair } from "./atiGuardian.js";

type Facts = { baseline?: DecisionCandidate; quote?: AtiMt5ReplayQuote; input?: { signal?: { marketEvidence?: { source?: string } } };
  mt5QuoteOrigin?: unknown; derivQuoteOrigin?: unknown };

export async function readAtiGuardianComparison(owner: number, agent: number, runId: string, observationKey: string, asOf: Date) {
  const [item] = await db.select({ run: runs, observation: observations }).from(runs)
    .innerJoin(observations, eq(observations.runId, runs.id)).where(and(eq(runs.id, runId), eq(runs.ownerId, owner),
      eq(runs.agentId, agent), isNull(runs.researchSource), eq(observations.observationKey, observationKey),
      lte(observations.observedAt, asOf), lte(observations.recordedAt, asOf))).limit(1);
  if (!item) return null;
  const { run, observation } = item;
  const facts = observation.evidence as Facts;
  const source = facts.input?.signal?.marketEvidence?.source;
  const mt5 = atiMt5QuoteOrigin.safeParse(facts.mt5QuoteOrigin);
  const deriv = atiDerivQuoteOrigin.safeParse(facts.derivQuoteOrigin);
  const base = { runId, observationKey, asOf: asOf.toISOString(), symbol: run.symbol, setup: run.setup, timeframe: run.timeframe,
    baselineVersion: run.baselineVersion, source: source ?? null, mode: source === "mt5_broker" && mt5.success ? mt5.data.mode : null,
    policy: guardianComparisonPolicy, evidenceBasis: "SIMULATED_QUOTE_SIDES", executionAuthority: "NONE" };
  if (observation.coverage !== "OBSERVED" || !observation.sourceIdentity)
    return { ...base, state: "UNRESOLVED", reason: observation.coverage === "OBSERVED" ? "SOURCE_IDENTITY_UNVERIFIED" : observation.coverage };
  if (run.setup !== observation.setup || !isAtiEntryDecision(observation.baselineOutcome))
    return { ...base, state: "NO_BASELINE_ENTRY" };
  const candidate = facts.baseline;
  const thesis = candidate?.thesis;
  const bracket = candidate && frozenAtiBracket(candidate);
  const decision = +observation.observedAt, end = decision + ATI_SHADOW_HOLD_WINDOW_MS, cutoff = Math.min(+asOf, end);
  const expiry = Date.parse(candidate?.setupExpiresAt ?? "");
  if (!bracket || !thesis || candidate?.setup !== run.setup || candidate.outcome !== observation.baselineOutcome ||
      !Number.isFinite(expiry) || expiry <= decision || !facts.quote)
    return { ...base, state: "UNRESOLVED", reason: "INVALID_ENTRY_EVIDENCE" };
  const assumed = run.assumedCosts as AtiAssumedCosts | null;
  const profile = source === "mt5_broker" && mt5.success ? selectAtiMeasuredCosts(
    run.measuredCostProfile as AtiMeasuredCostProfile | null, mt5.data, observation.sourceIdentity, decision) : null;
  const measured = profile ? measuredRoundTripCosts(profile, bracket.action) : null;
  const pair = replayGuardianPair(thesis, candidate.outcome === "APPROVED_REDUCED" ? .5 : 1, {
    assumed: assumed ? 2 * (assumed.adverseSlippagePerFillPriceUnits + assumed.feePerFillPriceUnits) : null,
    measured: measured?.slippageCommissionAndFee ?? null, measuredSlippage: measured?.slippage ?? null,
  });
  let grade;
  if (source === "deriv_public" && deriv.success && resolveDerivSymbol(run.symbol)?.derivId === deriv.data.symbol) {
    const rows = await loadAtiDerivReplayQuotes(deriv.data, cutoff);
    grade = gradeAtiDerivReplay(rows, deriv.data, facts.quote, bracket, decision, cutoff, expiry, {}, pair.observe);
  } else if (source === "mt5_broker" && mt5.success) {
    const rows = await loadAtiMt5ReplayQuotes(owner, mt5.data, decision, cutoff);
    grade = gradeAtiMt5Replay(rows, mt5.data, facts.quote, run.symbol, bracket, decision, cutoff, expiry, {}, pair.observe);
  } else return { ...base, state: "UNRESOLVED", reason: "ARCHIVE_ORIGIN_UNVERIFIED" };
  const result = pair.result();
  const noFill = "noFill" in grade ? grade.noFill : undefined;
  const state = result.baseline.exit && result.challenger.exit ? "SETTLED_PAIR" : noFill ? "NO_FILL"
    : cutoff >= end || grade.state === "UNVERIFIED" ? "UNRESOLVED" : "PENDING";
  return { ...base, ...result, state, staticBracketState: grade.state, reason: noFill?.reason ??
    (state === "UNRESOLVED" ? grade.state === "UNVERIFIED" ? "QUOTE_COVERAGE_INCOMPLETE" : "HOLD_WINDOW_ENDED" : null) };
}
