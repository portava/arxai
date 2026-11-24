import { z } from "zod/v4";
import { evaluateLateEntry, type DecisionCandidate, type DecisionCandidateInput } from "@workspace/domain/self-trade";
import { evidenceMatches, isCurrentBuild, sameMarketReadSourceFamily } from "../truth/marketReadEvidence.js";
import { guardianComparisonPolicy } from "./atiGuardian.js";
import { ATI_REGIME_INSTRUMENT_CHALLENGER } from "./atiRegimeInstrument.js";

export const ATI_DEFAULT_CHALLENGER = "skip-timeframe-conflict-v1";
export const ATI_COUNTERARGUMENT_CHALLENGER = "counterargument-entry-zone-v1";
export const ATI_RETEST_CHALLENGER = "counterargument-retest-v2";
export const atiChallengerVersion = z.enum([ATI_DEFAULT_CHALLENGER, ATI_COUNTERARGUMENT_CHALLENGER, ATI_RETEST_CHALLENGER,
  ATI_REGIME_INSTRUMENT_CHALLENGER, guardianComparisonPolicy.version]);
export type AtiChallengerVersion = z.infer<typeof atiChallengerVersion>;
export const isAtiCounterargumentChallenger = (version: string | undefined) =>
  version === ATI_COUNTERARGUMENT_CHALLENGER || version === ATI_RETEST_CHALLENGER;
export const ATI_RETEST_WAIT_MS = 60_000;

export const atiCounterargumentPolicy = Object.freeze({
  spreadWarningFractionOfStop: 0.12,
  spreadVetoFractionOfStop: 0.25,
  minimumTargetRoomR: 1,
  cautionsToWait: 2,
  historyDays: 30,
  historyMinimum: 12,
  historyLossFraction: 2 / 3,
  historyLimit: 24,
  historyScanLimit: 50,
});

const priorEvidence = z.object({
  basis: z.literal("PRIOR_OWNER_SHADOW_QUOTE_SIDE_R"),
  observations: z.array(z.object({ runId: z.uuid(), observationKey: z.string(), baselineR: z.number() }).strict()),
  lossCount: z.number().int().nonnegative(),
  meanR: z.number().nullable(),
}).strict();
export type AtiCounterargumentHistory = z.infer<typeof priorEvidence>;

const concern = z.object({
  code: z.string(),
  impact: z.enum(["VETO", "WAIT", "CAUTION"]),
  detail: z.string(),
}).strict();
type Concern = z.infer<typeof concern>;

export const atiCounterargumentEvidence = z.object({
  version: z.literal(ATI_COUNTERARGUMENT_CHALLENGER),
  decision: z.enum(["KEEP", "REDUCE", "WAIT", "VETO"]),
  decidedAtMs: z.number().int().positive(),
  concerns: z.array(concern),
  evidenceGaps: z.array(z.string()),
  history: priorEvidence.nullable(),
  timing: z.object({
    state: z.enum(["AT_ENTRY", "WAIT_FOR_ZONE", "DO_NOT_CHASE", "UNVERIFIED"]),
    executablePrice: z.number().nullable(),
    from: z.number().nullable(),
    to: z.number().nullable(),
    expiresAtMs: z.number().int().positive().nullable(),
  }).strict(),
}).strict();
export type AtiCounterargumentEvidence = z.infer<typeof atiCounterargumentEvidence>;

export const atiRetestPlan = z.object({
  band: z.object({ from: z.number().positive(), to: z.number().positive() }).strict(),
  expiresAtMs: z.number().int().positive(),
  sizeRatio: z.union([z.literal(0.5), z.literal(1)]),
}).strict().refine(({ band }) => band.from <= band.to);
export type AtiRetestPlan = z.infer<typeof atiRetestPlan>;

export function freezeAtiRetestPlan(baseline: DecisionCandidate, input: DecisionCandidateInput, review: AtiCounterargumentEvidence): AtiRetestPlan | null {
  const { timing, decidedAtMs, concerns } = review;
  const late = input.signal.late;
  if (review.decision !== "WAIT" || (timing.state !== "WAIT_FOR_ZONE" && timing.state !== "DO_NOT_CHASE") ||
      !late || late.isLate || late.doNotChase || timing.from == null || timing.to == null ||
      timing.expiresAtMs == null || timing.expiresAtMs <= decidedAtMs ||
      concerns.some(({ impact, code }) => impact === "VETO" || (impact === "WAIT" && code !== "WAIT_FOR_ZONE" && code !== "DO_NOT_CHASE"))) {
    return null;
  }
  const cautions = concerns.filter(({ impact }) => impact === "CAUTION").length;
  if (cautions >= atiCounterargumentPolicy.cautionsToWait) return null;
  return {
    band: { from: timing.from, to: timing.to },
    expiresAtMs: Math.min(timing.expiresAtMs, decidedAtMs + ATI_RETEST_WAIT_MS),
    sizeRatio: baseline.outcome === "APPROVED_REDUCED" || cautions ? 0.5 : 1,
  };
}

export function counterargumentOutcome<T extends string>(baseline: T, decision: AtiCounterargumentEvidence["decision"]) {
  if (baseline !== "APPROVED" && baseline !== "APPROVED_REDUCED") return baseline;
  if (decision === "VETO") return "BLOCKED";
  if (decision === "WAIT") return "WAIT";
  if (decision === "REDUCE") return "APPROVED_REDUCED";
  return baseline;
}

function price(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function assessAtiCounterargument(baseline: DecisionCandidate, input: DecisionCandidateInput,
  quote: { bid: number; ask: number; observedAt: string } | null, ownerId: number, now: number,
  history: AtiCounterargumentHistory | null): AtiCounterargumentEvidence {
  const { signal } = input;
  const policy = atiCounterargumentPolicy;
  const concerns: Concern[] = [];
  const evidenceGaps: string[] = [];
  const htf = (input.htfSignals ?? []).filter((frame) =>
    frame.hasSufficientData && frame.dataSource === "LIVE_FEED" && frame.timeframe !== signal.timeframe &&
    isCurrentBuild(frame.generatedAt, now) && evidenceMatches(frame.marketEvidence, frame.marketEvidence, now, ownerId) &&
    sameMarketReadSourceFamily(signal.marketEvidence ?? null, frame.marketEvidence ?? null));
  if (!htf.some((frame) => frame.direction === "BUY" || frame.direction === "SELL")) evidenceGaps.push("DIRECTIONAL_HIGHER_TIMEFRAME_UNAVAILABLE");
  if (htf.some((frame) => frame.direction !== "NEUTRAL" && frame.direction !== baseline.side)) {
    concerns.push({ code: "OPPOSING_HIGHER_TIMEFRAME", impact: "CAUTION", detail: "An observed higher timeframe opposes the entry direction." });
  }
  const trend = signal.earlyTrend;
  if (!trend || trend.blind || trend.momentum === "UNKNOWN") evidenceGaps.push("MOMENTUM_UNAVAILABLE");
  else if (trend.pressure === "FADING" || trend.momentum === "COMPRESSING") {
    concerns.push({ code: "WEAKENING_MOMENTUM", impact: "CAUTION", detail: "The observed trend radar shows fading pressure or compressing momentum." });
  }
  const trap = signal.fakeout;
  if (!trap || !trend || trend.blind) evidenceGaps.push("LIQUIDITY_TRAP_READ_UNAVAILABLE");
  else if (trap.detected && ((baseline.side === "BUY" && trap.kind === "BULL_TRAP") ||
      (baseline.side === "SELL" && trap.kind === "BEAR_TRAP") ||
      (trap.kind === "FAILED_BREAKOUT" && baseline.setup === "BREAKOUT_RETEST"))) {
    concerns.push({ code: "OPPOSING_LIQUIDITY_TRAP", impact: "VETO", detail: "The observed trap or failed breakout contradicts the proposed entry." });
  }
  if (history == null || history.observations.length < policy.historyMinimum) evidenceGaps.push("COMPARABLE_PRIOR_OUTCOMES_INSUFFICIENT");
  else if (history.meanR != null && history.meanR < 0 && history.lossCount / history.observations.length >= policy.historyLossFraction) {
    concerns.push({ code: "ADVERSE_PRIOR_OUTCOMES", impact: "CAUTION", detail: "Comparable prior Shadow entries show repeated losses on observed quotes." });
  }

  const thesis = baseline.thesis;
  const zone = thesis?.entryZone;
  const side = baseline.side;
  const capturedAt = Date.parse(quote?.observedAt ?? "");
  const observedQuote = quote && price(quote.bid) && price(quote.ask) && quote.ask >= quote.bid &&
    Number.isFinite(capturedAt) && capturedAt <= now ? quote : null;
  const entry = observedQuote && side ? (side === "BUY" ? observedQuote.ask : observedQuote.bid) : null;
  const expires = Date.parse(baseline.setupExpiresAt ?? "");
  const validExpiry = Number.isFinite(expires) && expires > 0 ? expires : null;
  const from = zone && price(zone.from) && price(zone.to) ? Math.min(zone.from, zone.to) : null;
  const to = from != null && zone ? Math.max(zone.from, zone.to) : null;
  const timing: AtiCounterargumentEvidence["timing"] = { state: "UNVERIFIED", executablePrice: entry, from, to, expiresAtMs: validExpiry };
  if (entry == null || from == null || to == null || validExpiry == null || !side) {
    evidenceGaps.push("EXECUTABLE_ENTRY_TIMING_UNAVAILABLE");
    concerns.push({ code: "ENTRY_TIMING_UNVERIFIED", impact: "WAIT", detail: "Executable quote, entry band or setup expiry is unavailable." });
  } else {
    const late = signal.late ? evaluateLateEntry(signal) : null;
    const beyondBand = side === "BUY" ? entry > to : entry < from;
    if (late?.doNotChase || beyondBand || now >= validExpiry) {
      timing.state = "DO_NOT_CHASE";
      concerns.push({ code: "DO_NOT_CHASE", impact: "WAIT", detail: "The executable side is beyond the entry band or the setup is late or expired." });
    } else if (entry < from || entry > to) {
      timing.state = "WAIT_FOR_ZONE";
      concerns.push({ code: "WAIT_FOR_ZONE", impact: "WAIT", detail: "Wait for the executable side to reach the frozen entry band." });
    } else {
      timing.state = "AT_ENTRY";
      if (late?.isLate) concerns.push({ code: "ENTRY_GETTING_LATE", impact: "CAUTION", detail: "The observed signal's late-entry detector advises reducing exposure." });
      if (!late) evidenceGaps.push("LATE_ENTRY_READ_UNAVAILABLE");
    }
  }

  const stop = thesis?.stopLoss;
  const target = thesis?.takeProfits?.[0]?.from;
  if (!observedQuote || entry == null || !side || !price(stop) || !price(target)) {
    evidenceGaps.push("BRACKET_COST_GEOMETRY_UNAVAILABLE");
    concerns.push({ code: "BRACKET_GEOMETRY_UNVERIFIED", impact: "WAIT", detail: "The executable quote and complete bracket are required for the cost check." });
  } else {
    const sign = side === "BUY" ? 1 : -1;
    const risk = sign * (entry - stop);
    const room = sign * (target - entry);
    const executableExit = side === "BUY" ? observedQuote.bid : observedQuote.ask;
    const spreadOverRisk = risk > 0 ? (observedQuote.ask - observedQuote.bid) / risk : Infinity;
    if (sign * (executableExit - stop) <= 0 || room <= 0) {
      concerns.push({ code: "BRACKET_ALREADY_INVALID", impact: "VETO", detail: "The observed quote is already through a frozen bracket level." });
    } else {
      if (spreadOverRisk >= policy.spreadVetoFractionOfStop) {
        concerns.push({ code: "SPREAD_CONSUMES_STOP_ROOM", impact: "VETO", detail: "The observed spread consumes too much of the planned stop distance." });
      } else if (spreadOverRisk >= policy.spreadWarningFractionOfStop) {
        concerns.push({ code: "SPREAD_ELEVATED", impact: "CAUTION", detail: "The observed spread is large relative to the planned stop distance." });
      }
      if (room / risk < policy.minimumTargetRoomR) {
        concerns.push({ code: "LIMITED_TARGET_ROOM", impact: "CAUTION", detail: "The first planned target offers less than one unit of reward per unit of initial price risk." });
      }
    }
  }
  const cautions = concerns.filter((item) => item.impact === "CAUTION").length;
  const decision = concerns.some((item) => item.impact === "VETO") ? "VETO"
    : concerns.some((item) => item.impact === "WAIT") || cautions >= policy.cautionsToWait ? "WAIT"
      : cautions > 0 && baseline.outcome === "APPROVED" ? "REDUCE" : "KEEP";
  return { version: ATI_COUNTERARGUMENT_CHALLENGER, decision, decidedAtMs: now, concerns, evidenceGaps, history, timing };
}
