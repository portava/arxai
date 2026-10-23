// Chart Brain v2 — Task 5: chart-level emotional / behavior protection (SLOW BRAIN).
//
// Derives RESPECTFUL, advisory behavior signals from a user's OWN recent trading
// history — chasing, revenge trading, overtrading, directional bias-lock, holding
// losers too long, and trading into a known invalidation. It is decision support
// only:
//   • It NEVER overrides market truth — it reports the trader's pattern, not the
//     chart's. A behavior caution never changes a signal, a gate, or a price.
//   • It is READ-ONLY and per-user (every query scoped by userId).
//   • It is Slow Brain — on-demand, never on the live execution path, never
//     blocking candle render or dispatch.
//   • It fails open: any error returns an empty, non-alarming result.
//   • Investors (view-only, no trade controls) get { applicable: false }.

import { db, scalpJournalEntriesTable, tradesTable, arxLivePositionsTable } from "@workspace/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { logger } from "../logger.js";

export type BehaviorSignalKey =
  | "overtrading"
  | "revenge_trading"
  | "chasing"
  | "bias_lock"
  | "holding_losers"
  | "ignoring_invalidation";

export type BehaviorSeverity = "info" | "caution" | "warning";

export interface BehaviorSignal {
  key: BehaviorSignalKey;
  severity: BehaviorSeverity;
  /** Respectful, plain-English headline. Never shaming. */
  title: string;
  /** What was observed, stated factually from the user's own history. */
  detail: string;
  /** Honest count/evidence backing the signal. */
  evidence: Record<string, unknown>;
}

export interface BehaviorProtectionResult {
  applicable: boolean;
  /** Reason when not applicable (e.g. investor view-only). */
  reason?: string;
  windowHours: number;
  signals: BehaviorSignal[];
  /** True only when at least one signal fired. */
  hasSignals: boolean;
  /** Calm summary line. Advisory only — never an instruction. */
  summary: string;
  generatedAt: string;
}

const WINDOW_HOURS = 24;
const OVERTRADE_THRESHOLD = 20; // trades in the window (mirrors existing tooling).
const REVENGE_WINDOW_MS = 15 * 60_000; // a new entry within 15m of a loss close.
const BIAS_LOCK_MIN_LOSING_STREAK = 4; // same-direction losing streak.
const HOLDING_LOSER_HOURS = 8; // open losing position older than this.

function notApplicable(reason: string): BehaviorProtectionResult {
  return {
    applicable: false,
    reason,
    windowHours: WINDOW_HOURS,
    signals: [],
    hasSignals: false,
    summary: "Behavior protection is not shown here.",
    generatedAt: new Date().toISOString(),
  };
}

function calm(signals: BehaviorSignal[]): string {
  if (signals.length === 0) {
    return "Nothing in your recent activity stands out. Trade your plan.";
  }
  const worst = signals.some((s) => s.severity === "warning")
    ? "warning"
    : signals.some((s) => s.severity === "caution")
      ? "caution"
      : "info";
  if (worst === "warning") {
    return "A couple of patterns are worth a pause before your next entry — these are observations about your habits, not the chart.";
  }
  if (worst === "caution") {
    return "A few gentle things to keep in mind from your recent trades. The market read is unchanged.";
  }
  return "Just a light note from your recent activity.";
}

/**
 * Compute advisory behavior-protection signals for a user. `isInvestor` callers
 * (view-only, no trade controls) receive { applicable: false }. Always per-user;
 * fails open.
 */
export async function getBehaviorProtection(
  userId: number,
  opts: { isInvestor: boolean },
): Promise<BehaviorProtectionResult> {
  if (opts.isInvestor) {
    return notApplicable("Investor view is read-only and does not include trade behavior coaching.");
  }
  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000);
  const signals: BehaviorSignal[] = [];

  try {
    // ── Recent closed scalp baskets (per-user), newest first ──
    const closedBaskets = await db
      .select()
      .from(scalpJournalEntriesTable)
      .where(
        and(
          eq(scalpJournalEntriesTable.userId, userId),
          eq(scalpJournalEntriesTable.status, "CLOSED"),
          gte(scalpJournalEntriesTable.closedAt, since),
        ),
      )
      .orderBy(desc(scalpJournalEntriesTable.closedAt));

    // ── Recent trades (per-user) for overtrade + revenge corroboration ──
    const recentTrades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.createdAt, since)))
      .orderBy(desc(tradesTable.createdAt));

    // ── Open live positions (per-user) for holding-too-long ──
    const openLive = await db
      .select()
      .from(arxLivePositionsTable)
      .where(
        and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)),
      );

    // 1) Overtrading — count of distinct entries in the window.
    const tradeCount = recentTrades.length + closedBaskets.length;
    if (tradeCount >= OVERTRADE_THRESHOLD) {
      signals.push({
        key: "overtrading",
        severity: "warning",
        title: "High trade frequency today",
        detail: `You've taken ${tradeCount} positions in the last ${WINDOW_HOURS}h. Frequency this high often means quality is slipping.`,
        evidence: { tradeCount, windowHours: WINDOW_HOURS, threshold: OVERTRADE_THRESHOLD },
      });
    }

    // 2) Revenge trading — a new entry opened shortly after a losing close.
    let revengeEpisodes = 0;
    const losingCloses = closedBaskets
      .filter((b) => b.result === "LOSS" && b.closedAt)
      .map((b) => b.closedAt!.getTime());
    const entryTimes = [
      ...closedBaskets.map((b) => b.openedAt?.getTime() ?? b.createdAt.getTime()),
      ...recentTrades.map((t) => (t.createdAt ?? since).getTime()),
    ].sort((a, b) => a - b);
    for (const lossAt of losingCloses) {
      if (entryTimes.some((e) => e > lossAt && e - lossAt <= REVENGE_WINDOW_MS)) {
        revengeEpisodes += 1;
      }
    }
    if (revengeEpisodes >= 2) {
      signals.push({
        key: "revenge_trading",
        severity: "warning",
        title: "Quick re-entries after losses",
        detail: `On ${revengeEpisodes} occasion(s) you opened a new position within ${Math.round(
          REVENGE_WINDOW_MS / 60_000,
        )} minutes of a loss. A short reset usually helps.`,
        evidence: { revengeEpisodes, windowMinutes: REVENGE_WINDOW_MS / 60_000 },
      });
    }

    // 3) Chasing — repeated HIGH chase-risk or LATE entry timing at entry.
    const chaseFlags = closedBaskets.filter(
      (b) => (b.chaseRiskAtEntry ?? "").toUpperCase() === "HIGH",
    ).length;
    const lateEntries = closedBaskets.filter(
      (b) => (b.entryTimingAtEntry ?? "").toUpperCase() === "LATE",
    ).length;
    if (chaseFlags >= 3 || lateEntries >= 3) {
      signals.push({
        key: "chasing",
        severity: "caution",
        title: "Entering after the move has run",
        detail: `Several recent entries were flagged ${
          chaseFlags >= 3 ? `high chase-risk (${chaseFlags})` : `late timing (${lateEntries})`
        } at the moment you entered. Waiting for a pullback tends to improve placement.`,
        evidence: { highChaseEntries: chaseFlags, lateEntries },
      });
    }

    // 4) Bias-lock — a same-direction losing streak.
    let streakDir: string | null = null;
    let streak = 0;
    let maxStreak = 0;
    let maxStreakDir: string | null = null;
    for (const b of closedBaskets) {
      if (b.result !== "LOSS") {
        streak = 0;
        streakDir = null;
        continue;
      }
      if (b.direction === streakDir) {
        streak += 1;
      } else {
        streakDir = b.direction;
        streak = 1;
      }
      if (streak > maxStreak) {
        maxStreak = streak;
        maxStreakDir = streakDir;
      }
    }
    if (maxStreak >= BIAS_LOCK_MIN_LOSING_STREAK && maxStreakDir) {
      signals.push({
        key: "bias_lock",
        severity: "caution",
        title: `Repeated ${maxStreakDir} attempts not working`,
        detail: `You've had ${maxStreak} ${maxStreakDir} losses in a row. The market may not be agreeing with that direction right now.`,
        evidence: { losingStreak: maxStreak, direction: maxStreakDir },
      });
    }

    // 5) Holding losers — open live position underwater and aging.
    const now = Date.now();
    const heldLosers = openLive.filter(
      (p) =>
        (p.floatingPl ?? 0) < 0 &&
        now - p.openedAt.getTime() >= HOLDING_LOSER_HOURS * 3_600_000,
    );
    if (heldLosers.length > 0) {
      const oldest = heldLosers.reduce((a, b) =>
        a.openedAt.getTime() <= b.openedAt.getTime() ? a : b,
      );
      const ageH = Math.round((now - oldest.openedAt.getTime()) / 3_600_000);
      signals.push({
        key: "holding_losers",
        severity: "caution",
        title: "A losing position has been open a while",
        detail: `${heldLosers.length} open position(s) are underwater, the oldest for ~${ageH}h. It can help to revisit whether the original idea is still valid.`,
        evidence: { count: heldLosers.length, oldestAgeHours: ageH },
      });
    }

    // 6) Ignoring invalidation — open losing position past a meaningful floating loss.
    const deepUnderwater = openLive.filter((p) => (p.floatingPl ?? 0) < 0).length;
    const reExitWarned = closedBaskets.filter(
      (b) => b.rubyWarnedCorrectly === true && b.result === "LOSS",
    ).length;
    if (reExitWarned >= 2) {
      signals.push({
        key: "ignoring_invalidation",
        severity: "info",
        title: "Exit warnings preceded recent losses",
        detail: `On ${reExitWarned} recent trade(s), an exit warning fired before the loss. Acting on those a little sooner could protect P/L.`,
        evidence: { warnedThenLost: reExitWarned, openUnderwater: deepUnderwater },
      });
    }

    return {
      applicable: true,
      windowHours: WINDOW_HOURS,
      signals,
      hasSignals: signals.length > 0,
      summary: calm(signals),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err, userId }, "behaviorProtection: failed (degrading to empty)");
    return {
      applicable: true,
      windowHours: WINDOW_HOURS,
      signals: [],
      hasSignals: false,
      summary: "Nothing in your recent activity stands out. Trade your plan.",
      generatedAt: new Date().toISOString(),
    };
  }
}
