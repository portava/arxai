// Profit Mission Phase 9 — Mission Risk Certificate.
//
// Pure, deterministic, IO-free. Builds the honest pre-live risk summary a user must
// read AND explicitly confirm before any live mission runs, and validates the
// confirmation payload. Acceptance is recorded append-only by the service layer.
// Banned guaranteed-profit vocabulary is intentionally absent; the confirmation
// phrase makes the user state the risk in their own acknowledgement.

import type { MissionAutomationLevel } from "./missionAutomation.js";
import type { MissionTestMetrics } from "./missionTestingLab.js";

/** The exact phrase a user must confirm. Compared case-insensitively, trimmed. */
export const MISSION_CERTIFICATE_PHRASE =
  "I understand this is not guaranteed and losses are possible";

/** Strategy/symbol/timeframe identity of the closed-draft record behind the figure. */
export interface CertificateDrawdownContext {
  strategyKey: string;
  symbol: string;
  timeframe: string;
}

/**
 * The single drawdown figure the certificate may print. It comes from ONE
 * closed-mission-draft aggregate (never a max pooled across records, sources or
 * contexts). It is the drawdown of the mission's nominal starting-amount equity
 * curve built from recorded draft P/L — not broker account equity — and the
 * execution mode and net costs behind it are unverified. Generated-price
 * simulations and unknown-source/legacy records can never supply it.
 */
export interface CertificateObservedDrawdown {
  /** Peak-relative realised drawdown percentage (non-negative). */
  pct: number;
  source: "closed_mission_drafts";
  validation: "unverified";
  /** Closed trades in the aggregate the figure was read from (> 0). */
  sampleSize: number;
  /** Exact context of that aggregate, or "Mixed" when it spans contexts. */
  context: CertificateDrawdownContext | "Mixed";
}

export interface CertificateContentInput {
  startingAmount: number;
  targetAmount: number;
  riskProfile: string;
  targetAutomationLevel: MissionAutomationLevel;
  /** Closed-draft drawdown record, or null when no qualifying record exists. */
  observedDrawdown: CertificateObservedDrawdown | null;
}

/**
 * Structural subset of a projected mission test result (the API's
 * MissionTestResultDto) the drawdown selector reads. Projection happens upstream;
 * this module never re-trusts stored labels or verified flags.
 */
export interface CertificateDrawdownCandidate {
  id: number;
  kind: string;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  metrics: Pick<MissionTestMetrics, "totalTrades" | "winningTrades" | "losingTrades" | "maxDrawdownPct">;
  evidence: { source: string; validation: string };
  createdAt: string;
}

function createdAtMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function qualifiesAsClosedDraftDrawdown(r: CertificateDrawdownCandidate): boolean {
  const m = r.metrics;
  return r.kind === "FORWARD"
    && r.evidence?.source === "closed_mission_drafts"
    && r.evidence?.validation === "unverified"
    // Invalid stored metrics are projected as an all-zero fallback (totalTrades 0),
    // and a zero-match aggregate also has totalTrades 0: neither is a drawdown record.
    && Number.isSafeInteger(m.totalTrades) && m.totalTrades > 0
    && Number.isSafeInteger(m.winningTrades) && Number.isSafeInteger(m.losingTrades)
    && m.winningTrades >= 0 && m.losingTrades >= 0
    && m.winningTrades + m.losingTrades <= m.totalTrades
    && typeof m.maxDrawdownPct === "number" && Number.isFinite(m.maxDrawdownPct) && m.maxDrawdownPct >= 0;
}

/**
 * Basis: docs/PROFIT_MISSION_EVIDENCE_ACCEPTANCE.md competitive-criteria bullet
 * (generated prices cannot establish market performance), acceptance items 3
 * (source classification), 4 (Mixed labelling) and 5 (generated P/L is gross price
 * units; drawdown uses each contemporaneous peak); owner brief Truth System and
 * Profit Mission lines (distinguish unavailable from estimates; evaluate drawdown,
 * never claim from backtests). Matched strategy/symbol/timeframe/mode comparison
 * remains listed there as unfinished capability work — this selector does not
 * provide it; it only refuses to pool records.
 *
 * Pick the certificate's drawdown record from projected test results. Pure and
 * deterministic: the newest (createdAt desc, id desc — the list order) FORWARD
 * closed-mission-draft aggregate with parsed metrics and at least one closed
 * trade. Generated-price, unknown-source/legacy, invalid and zero-sample rows
 * never contribute, whatever their drawdown. No maximum is taken across rows.
 */
export function selectCertificateObservedDrawdown(
  results: readonly CertificateDrawdownCandidate[],
): CertificateObservedDrawdown | null {
  let best: CertificateDrawdownCandidate | null = null;
  for (const r of results) {
    if (!qualifiesAsClosedDraftDrawdown(r)) continue;
    if (best == null) { best = r; continue; }
    const a = createdAtMs(r.createdAt);
    const b = createdAtMs(best.createdAt);
    if (a > b || (a === b && r.id > best.id)) best = r;
  }
  if (best == null) return null;
  const mixed = [best.strategyKey, best.symbol, best.timeframe].some((v) => v === "Mixed");
  return {
    pct: best.metrics.maxDrawdownPct,
    source: "closed_mission_drafts",
    validation: "unverified",
    sampleSize: best.metrics.totalTrades,
    context: mixed
      ? "Mixed"
      : { strategyKey: best.strategyKey, symbol: best.symbol, timeframe: best.timeframe },
  };
}

function isUsableObservedDrawdown(d: CertificateObservedDrawdown | null): d is CertificateObservedDrawdown {
  return d != null
    && d.source === "closed_mission_drafts"
    && d.validation === "unverified"
    && Number.isFinite(d.pct) && d.pct >= 0
    && Number.isSafeInteger(d.sampleSize) && d.sampleSize > 0;
}

/** The certificate's single drawdown line (always present; never a pooled figure). */
export function certificateDrawdownLine(d: CertificateObservedDrawdown | null): string {
  if (!isUsableObservedDrawdown(d)) {
    return "Largest drawdown: unavailable (no closed-trade drawdown record available for this mission). "
      + "No drawdown figure is shown. Generated-price simulations are never used for this line.";
  }
  const context = d.context === "Mixed"
    ? "mixed context"
    : `strategy ${d.context.strategyKey}, ${d.context.symbol} ${d.context.timeframe}`;
  return `Largest drawdown in the newest closed-draft aggregate: ${d.pct.toFixed(1)}% `
    + `(source: closed mission drafts, unverified; ${d.sampleSize} closed trade${d.sampleSize === 1 ? "" : "s"}; ${context}). `
    + "This is the drawdown of the mission's nominal starting-amount equity curve built from recorded draft P/L, "
    + "not broker account equity; execution mode and net costs are unverified. "
    + "Generated-price simulations are excluded.";
}

export interface CertificateContent {
  phrase: string;
  title: string;
  summaryLines: string[];
  acknowledgements: string[];
}

/** Build the certificate text shown before a live mission. */
export function buildCertificateContent(input: CertificateContentInput): CertificateContent {
  const requiredProfit = Math.max(0, input.targetAmount - input.startingAmount);
  const summaryLines: string[] = [
    `Starting capital: ${input.startingAmount}`,
    `Target: ${input.targetAmount} (profit goal of ${requiredProfit})`,
    `Risk profile: ${input.riskProfile}`,
    `Requested automation level: ${input.targetAutomationLevel}`,
  ];
  summaryLines.push(certificateDrawdownLine(input.observedDrawdown));

  const acknowledgements: string[] = [
    "Trading involves the risk of loss, including the possible loss of your starting capital.",
    "Past and simulated results are estimates only and do not predict future outcomes.",
    "This target is a goal, not a promise — the mission may fall short or lose money.",
    "Live automation only ever places trades through the platform's existing safety gates, which can refuse or stop a trade at any time.",
    "You can pause, reduce automation, or stop this mission at any time.",
  ];

  return {
    phrase: MISSION_CERTIFICATE_PHRASE,
    title: "Mission Risk Certificate",
    summaryLines,
    acknowledgements,
  };
}

export interface CertificateAcceptanceResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Validate a user's confirmation. The confirmation string must match the required
 * phrase (case-insensitive, trimmed) and `confirmed` must be true. Fail-closed.
 */
export function validateCertificateAcceptance(payload: {
  confirmed: unknown;
  phrase: unknown;
}): CertificateAcceptanceResult {
  if (payload.confirmed !== true) {
    return { ok: false, reason: "explicit confirmation is required" };
  }
  if (typeof payload.phrase !== "string") {
    return { ok: false, reason: "confirmation phrase is required" };
  }
  const got = payload.phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const want = MISSION_CERTIFICATE_PHRASE.toLowerCase();
  if (got !== want) {
    return { ok: false, reason: "confirmation phrase does not match" };
  }
  return { ok: true, reason: null };
}
