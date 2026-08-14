// Profit Mission Phase 9 — Mission Risk Certificate.
//
// Pure, deterministic, IO-free. Builds the honest pre-live risk summary a user must
// read AND explicitly confirm before any live mission runs, and validates the
// confirmation payload. Acceptance is recorded append-only by the service layer.
// Banned guaranteed-profit vocabulary is intentionally absent; the confirmation
// phrase makes the user state the risk in their own acknowledgement.

import type { MissionAutomationLevel } from "./missionAutomation.js";

/** The exact phrase a user must confirm. Compared case-insensitively, trimmed. */
export const MISSION_CERTIFICATE_PHRASE =
  "I understand this is not guaranteed and losses are possible";

export interface CertificateContentInput {
  startingAmount: number;
  targetAmount: number;
  riskProfile: string;
  targetAutomationLevel: MissionAutomationLevel;
  /** Worst observed max drawdown across this mission's test results (0..100). */
  observedMaxDrawdownPct: number | null;
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
  if (input.observedMaxDrawdownPct != null) {
    summaryLines.push(`Largest drawdown seen in testing: ${input.observedMaxDrawdownPct.toFixed(1)}%`);
  }

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
