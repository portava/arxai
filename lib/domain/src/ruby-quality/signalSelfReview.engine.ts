// Task #199 — Post-trade Ruby self-review builder. PURE.
//
// Produces TWO views from a resolved signal-outcome row:
//   - userSummary : one plain-language paragraph for the trader. NO internal
//     enum tokens, no thresholds, no scanner internals.
//   - adminDetail : a structured breakdown (what Ruby got right / missed,
//     timing, slippage/spread/news effect, and the concrete adjustment) — only
//     ever returned to ADMIN/OWNER sessions.
//
// Honesty: every line is derived from the recorded row. Missing evidence yields
// "not recorded" rather than an invented claim.

import type {
  ExitReason, SignalOutcomeStatus, SignalReviewType, TimingClass,
} from "./rubyQuality.types";

export interface SelfReviewInput {
  symbol: string;
  direction: string | null;
  decision: string;
  outcomeStatus: SignalOutcomeStatus;
  pnlR: number | null;
  userEntered: boolean;
  explanationUsed: boolean;
  timingClass: TimingClass | null;
  newsNearby: boolean;
  spreadAtSignal: number | null;
  expectedSlippage: number | null;
  actualSlippage: number | null;
  expectedStartDrawdown: number | null;
  actualStartDrawdown: number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
  exitReason: ExitReason | null;
  confidenceScore: number;
  edgeScore: number | null;
  /** Optional tags from the trade-outcome analyzer (admin detail only). */
  mistakeTags?: string[];
  successTags?: string[];
}

export interface SelfReview {
  reviewType: SignalReviewType;
  userSummary: string;
  adminDetail: {
    gotRight: string[];
    missed: string[];
    timingNote: string;
    slippageNote: string;
    spreadNote: string;
    newsNote: string;
    adjustment: string;
    tags: { mistakes: string[]; successes: string[] };
    metrics: {
      pnlR: number | null;
      mfe: number | null;
      mae: number | null;
      expectedVsActualSlippage: { expected: number | null; actual: number | null };
      expectedVsActualStartDrawdown: { expected: number | null; actual: number | null };
      exitReason: ExitReason | null;
      timingClass: TimingClass | null;
    };
  };
}

const num = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "not recorded" : String(Math.round(n * 100) / 100);

export function buildSignalSelfReview(i: SelfReviewInput): SelfReview {
  const isNoTrade = i.decision === "no_trade" || i.decision === "reject";
  const reviewType: SignalReviewType = isNoTrade && !i.userEntered ? "NO_TRADE" : "POST_TRADE";

  const gotRight: string[] = [];
  const missed: string[] = [];

  if (i.outcomeStatus === "WIN") gotRight.push("Called a setup that paid off.");
  if (i.outcomeStatus === "LOSS") missed.push("Called a setup that lost.");
  if (i.outcomeStatus === "NO_TRADE_CORRECT") gotRight.push("Avoided a setup that did not pay off.");
  if (i.outcomeStatus === "NO_TRADE_MISSED") missed.push("Skipped a setup that actually ran.");
  if (i.timingClass === "LATE") missed.push("Entry was late versus when the signal appeared.");
  if (i.timingClass === "ON_TIME") gotRight.push("Entry timing matched the signal.");
  if (i.newsNearby) missed.push("A high-impact news window was nearby.");
  if (i.actualSlippage != null && i.expectedSlippage != null && i.actualSlippage > i.expectedSlippage) {
    missed.push("Real slippage came in worse than estimated.");
  }

  // ── User-facing summary (plain language, no internals) ─────────────────────
  let userSummary: string;
  switch (i.outcomeStatus) {
    case "WIN":
      userSummary = `The ${i.symbol} idea worked out${i.pnlR != null ? ` (about ${num(i.pnlR)}R)` : ""}. ${i.timingClass === "LATE" ? "Getting in earlier next time would have helped." : "Timing and follow-through were solid."}`;
      break;
    case "LOSS":
      userSummary = `The ${i.symbol} idea didn't work this time${i.pnlR != null ? ` (about ${num(i.pnlR)}R)` : ""}. ${i.newsNearby ? "News nearby likely added noise. " : ""}We'll be more selective on similar setups.`;
      break;
    case "BREAKEVEN":
      userSummary = `The ${i.symbol} idea went roughly flat — no real edge played out, so protecting the account was the right call.`;
      break;
    case "NO_TRADE_CORRECT":
      userSummary = `Skipping ${i.symbol} was the right move — it never offered a clean payoff.`;
      break;
    case "NO_TRADE_MISSED":
      userSummary = `${i.symbol} ended up moving without us. We'll watch for this kind of setup more closely.`;
      break;
    default:
      userSummary = `${i.symbol} is still being tracked — no confirmed result yet, so there's nothing to grade.`;
  }

  // ── Admin detail ───────────────────────────────────────────────────────────
  const timingNote = i.timingClass == null
    ? "No entry timestamp recorded — timing not graded."
    : `Entry timing: ${i.timingClass}.`;
  const slippageNote = `Slippage expected ${num(i.expectedSlippage)} vs actual ${num(i.actualSlippage)}.`;
  const spreadNote = `Spread at signal: ${num(i.spreadAtSignal)}.`;
  const newsNote = i.newsNearby
    ? "High-impact news window was nearby at signal time."
    : "No high-impact news window flagged at signal time.";

  let adjustment: string;
  if (i.timingClass === "LATE") adjustment = "Tighten the late-entry tolerance or flag chased entries sooner.";
  else if (i.outcomeStatus === "LOSS" && i.newsNearby) adjustment = "Extend the news lockout window around this symbol.";
  else if (i.actualSlippage != null && i.expectedSlippage != null && i.actualSlippage > i.expectedSlippage) adjustment = "Raise the slippage estimate for this symbol/session.";
  else if (i.outcomeStatus === "LOSS" && i.confidenceScore < 60) adjustment = "Raise the minimum confidence floor for this setup.";
  else if (i.outcomeStatus === "NO_TRADE_MISSED") adjustment = "Re-check whether the avoidance threshold was too strict here.";
  else adjustment = "No threshold change indicated — keep current settings.";

  return {
    reviewType,
    userSummary,
    adminDetail: {
      gotRight,
      missed,
      timingNote,
      slippageNote,
      spreadNote,
      newsNote,
      adjustment,
      tags: { mistakes: i.mistakeTags ?? [], successes: i.successTags ?? [] },
      metrics: {
        pnlR: i.pnlR,
        mfe: i.maxFavorableExcursion,
        mae: i.maxAdverseExcursion,
        expectedVsActualSlippage: { expected: i.expectedSlippage, actual: i.actualSlippage },
        expectedVsActualStartDrawdown: { expected: i.expectedStartDrawdown, actual: i.actualStartDrawdown },
        exitReason: i.exitReason,
        timingClass: i.timingClass,
      },
    },
  };
}
