// Mood Check-In Routes
//
// Routes:
//   POST /api/me/mood/check-in          — submit a mood check-in
//   GET  /api/me/mood/recent            — last N check-ins
//   GET  /api/me/mood/patterns          — mood→performance correlations
//   GET  /api/me/mood/states            — list of valid moods with descriptions
//
// SAFETY: requireUser on all routes. Never blocks trade execution.
// Advisory only — protective warnings surfaced to Ruby and notifications.

import { Router } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import {
  moodCheckInsTable,
  paperTradesTable,
  MOOD_STATES,
  HIGH_RISK_MOODS,
  CAUTION_MOODS,
  type MoodState,
} from "@workspace/db/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { createNotification } from "../lib/notificationService.js";
import {
  correlateMoodOutcomes,
  MOOD_ATTRIBUTION_WINDOW_MS,
} from "../lib/mood/moodOutcomeCorrelation.js";

export {
  correlateMoodOutcomes,
  MOOD_ATTRIBUTION_WINDOW_MS,
  type MoodOutcomeRow,
} from "../lib/mood/moodOutcomeCorrelation.js";

const router = Router();

// ── Mood metadata ─────────────────────────────────────────────────────────────
const MOOD_META: Record<MoodState, { label: string; description: string; emoji: string; riskLevel: "low" | "caution" | "high" }> = {
  CALM:       { label: "Calm",       emoji: "😌", description: "Clear-headed and relaxed. Good state for trading.",                riskLevel: "low"     },
  FOCUSED:    { label: "Focused",    emoji: "🎯", description: "Locked in with positive energy. Solid trading state.",            riskLevel: "low"     },
  CONFIDENT:  { label: "Confident",  emoji: "💪", description: "High conviction. Watch for overconfidence on lot sizes.",         riskLevel: "low"     },
  OBSERVING:  { label: "Observing",  emoji: "👀", description: "Just watching. Not planning to trade — smart choice.",            riskLevel: "low"     },
  UNCERTAIN:  { label: "Uncertain",  emoji: "🤔", description: "Unsure about direction or setup. Consider waiting for clarity.",   riskLevel: "caution" },
  TIRED:      { label: "Tired",      emoji: "😴", description: "Fatigue reduces judgment quality. Be extra careful.",             riskLevel: "caution" },
  FRUSTRATED: { label: "Frustrated", emoji: "😤", description: "Recent loss or missed move. High risk of emotional trading.",      riskLevel: "high"    },
  RUSHED:     { label: "Rushed",     emoji: "⏰", description: "Time pressure leads to poor decisions. Slow down.",               riskLevel: "high"    },
  REVENGE:    { label: "Revenge",    emoji: "🔥", description: "Trying to recover losses. Very high risk. Consider a break.",     riskLevel: "high"    },
  FOMO:       { label: "FOMO",       emoji: "😰", description: "Fear of missing out. Chasing moves leads to poor entries.",       riskLevel: "high"    },
};

function assessRisk(mood: MoodState): {
  riskLevel: "low" | "caution" | "high";
  isHighRisk: boolean;
  warning: string | null;
} {
  const meta = MOOD_META[mood];
  const riskLevel = meta.riskLevel;
  const isHighRisk = HIGH_RISK_MOODS.includes(mood as any);

  let warning: string | null = null;
  if (mood === "REVENGE") {
    warning = "You've flagged yourself as revenge trading. This is one of the most dangerous states to trade in. Take a 30-minute break before placing any trade.";
  } else if (mood === "FRUSTRATED") {
    warning = "Trading while frustrated increases the chance of impulsive decisions. Review your last loss calmly before opening a new position.";
  } else if (mood === "FOMO") {
    warning = "FOMO often leads to chasing moves at poor entries. Wait for the next clean setup rather than jumping into a running market.";
  } else if (mood === "RUSHED") {
    warning = "Rushed decisions rarely lead to quality trades. If you don't have time to analyse the setup properly, it's better to skip it.";
  } else if (mood === "TIRED") {
    warning = "Fatigue affects judgment. Consider whether this is the right time to trade, especially on higher-risk setups.";
  } else if (mood === "UNCERTAIN") {
    warning = "Uncertainty is a signal. If you're not sure about the setup, waiting is a valid — and often profitable — decision.";
  }

  return { riskLevel, isHighRisk, warning };
}

// ── POST /api/me/mood/check-in ────────────────────────────────────────────────
const CheckInBody = z.object({
  mood:    z.enum(MOOD_STATES),
  note:    z.string().max(500).optional(),
  trigger: z.enum(["manual", "pre_trade", "after_loss", "session_start", "daily_limit_warning"]).optional(),
  symbol:  z.string().max(20).optional(),
});

router.post("/me/mood/check-in", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = CheckInBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }

  const { mood, note, trigger = "manual", symbol } = parsed.data;
  const { riskLevel, isHighRisk, warning } = assessRisk(mood);

  // Detect session
  const h = new Date().getUTCHours();
  const sessionLabel =
    h >= 0  && h < 7  ? "asian"   :
    h >= 7  && h < 12 ? "london"  :
    h >= 12 && h < 16 ? "overlap" :
    h >= 16 && h < 21 ? "newyork" : "asian";

  const [row] = await db.insert(moodCheckInsTable).values({
    userId,
    mood,
    note:    note ?? null,
    trigger,
    symbol:  symbol ?? null,
    sessionLabel,
    riskLevel,
    isHighRisk,
    warning: warning ?? null,
  }).returning();

  // Send in-app warning notification for high-risk moods
  if (isHighRisk) {
    await createNotification(userId, {
      notificationType: "mood_risk_warning",
      severity:         "warning",
      title:            `Mood check-in: ${MOOD_META[mood].label} ${MOOD_META[mood].emoji}`,
      message:          warning ?? "Consider taking a break before trading.",
      source:           "ai",
      entityType:       "mood_check_in",
      entityId:         row?.id ?? 0,
      actionLabel:      "View insights",
      actionTarget:     "/ai-coach",
    });
  }

  return res.json({
    ok: true,
    checkInId:   row?.id,
    mood,
    riskLevel,
    isHighRisk,
    warning,
    emoji:       MOOD_META[mood].emoji,
    label:       MOOD_META[mood].label,
    message:     isHighRisk
      ? warning
      : riskLevel === "caution"
      ? `${MOOD_META[mood].description} Proceed with extra care.`
      : `${MOOD_META[mood].description} Good luck.`,
  });
});

// ── GET /api/me/mood/recent ───────────────────────────────────────────────────
router.get("/me/mood/recent", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);

  const rows = await db.select()
    .from(moodCheckInsTable)
    .where(eq(moodCheckInsTable.userId, userId))
    .orderBy(desc(moodCheckInsTable.checkedInAt))
    .limit(limit);

  return res.json({
    ok: true,
    checkIns: rows.map((r) => ({
      id:          r.id,
      mood:        r.mood,
      label:       MOOD_META[r.mood as MoodState]?.label ?? r.mood,
      emoji:       MOOD_META[r.mood as MoodState]?.emoji ?? "",
      riskLevel:   r.riskLevel,
      isHighRisk:  r.isHighRisk,
      note:        r.note,
      trigger:     r.trigger,
      symbol:      r.symbol,
      warning:     r.warning,
      checkedInAt: r.checkedInAt,
    })),
  });
});

// ── GET /api/me/mood/patterns ─────────────────────────────────────────────────
// Returns (a) a frequency breakdown of the user's check-ins and (b) a real
// mood→outcome correlation over their CLOSED paper trades. (b) was documented
// here for a long time but never computed — `paperTradesTable` was imported and
// unused, and the response was a histogram plus a canned sentence. It is now
// computed, and when it cannot be it says so instead of implying it exists.
router.get("/me/mood/patterns", requireUser, async (req, res) => {
  const userId   = req.authUser!.id;
  const daysBack = parseInt(String(req.query.daysBack ?? "90"), 10) || 90;
  const since    = new Date(Date.now() - daysBack * 24 * 60 * 60_000);

  const checkIns = await db.select()
    .from(moodCheckInsTable)
    .where(and(
      eq(moodCheckInsTable.userId, userId),
      gte(moodCheckInsTable.checkedInAt, since),
    ))
    .orderBy(desc(moodCheckInsTable.checkedInAt));

  if (checkIns.length === 0) {
    return res.json({
      ok: true,
      hasData: false,
      outcomeCorrelation: {
        available: false,
        reason: "NO_CHECK_INS",
        note: "No mood check-ins yet — there is nothing to correlate trades against.",
      },
      message: "No mood check-ins yet. Check in before trades to start building your mood performance profile.",
    });
  }

  // Real mood→outcome correlation over CLOSED paper trades in the same window.
  const closed = await db.select({
    openedAt: paperTradesTable.openedAt,
    pnl:      paperTradesTable.pnl,
  })
    .from(paperTradesTable)
    .where(and(
      eq(paperTradesTable.userId, userId),
      eq(paperTradesTable.status, "closed"),
      gte(paperTradesTable.openedAt, since),
    ));

  const usableTrades = closed
    .filter((t): t is { openedAt: Date; pnl: number } => t.openedAt != null && t.pnl != null)
    .map((t) => ({ openedAt: t.openedAt, pnl: t.pnl }));

  const correlation = correlateMoodOutcomes(
    checkIns
      .filter((c): c is typeof c & { checkedInAt: Date } => c.checkedInAt != null)
      .map((c) => ({ mood: c.mood, checkedInAt: c.checkedInAt })),
    usableTrades,
  );

  const outcomeCorrelation = correlation.attributedTrades === 0
    ? {
        available: false as const,
        reason: "NO_ATTRIBUTABLE_TRADES" as const,
        note: `No closed trade in the last ${daysBack} days opened within ${MOOD_ATTRIBUTION_WINDOW_MS / 3_600_000}h of a check-in, so no mood can be tied to an outcome. Check in shortly before you trade to build this.`,
        unattributedTrades: correlation.unattributedTrades,
      }
    : {
        available: true as const,
        windowHours: MOOD_ATTRIBUTION_WINDOW_MS / 3_600_000,
        attributedTrades: correlation.attributedTrades,
        unattributedTrades: correlation.unattributedTrades,
        byMood: correlation.rows.map((r) => ({
          ...r,
          label: MOOD_META[r.mood as MoodState]?.label ?? r.mood,
          emoji: MOOD_META[r.mood as MoodState]?.emoji ?? "",
        })),
      };

  // Aggregate by mood
  const byMood: Record<string, {
    count: number; highRisk: number; withNote: number;
  }> = {};

  for (const c of checkIns) {
    const m = c.mood;
    byMood[m] = byMood[m] ?? { count: 0, highRisk: 0, withNote: 0 };
    byMood[m].count++;
    if (c.isHighRisk) byMood[m].highRisk++;
    if (c.note) byMood[m].withNote++;
  }

  const moodBreakdown = Object.entries(byMood)
    .map(([mood, d]) => ({
      mood,
      label:     MOOD_META[mood as MoodState]?.label ?? mood,
      emoji:     MOOD_META[mood as MoodState]?.emoji ?? "",
      riskLevel: MOOD_META[mood as MoodState]?.riskLevel ?? "low",
      ...d,
      pct: Math.round((d.count / checkIns.length) * 100),
    }))
    .sort((a, b) => b.count - a.count);

  const highRiskTotal = checkIns.filter((c) => c.isHighRisk).length;
  const highRiskPct   = Math.round((highRiskTotal / checkIns.length) * 100);

  const mostCommonMood = moodBreakdown[0]?.mood ?? null;
  const mostDangerous  = moodBreakdown
    .filter((m) => HIGH_RISK_MOODS.includes(m.mood as any))
    .sort((a, b) => b.count - a.count)[0]?.mood ?? null;

  return res.json({
    ok: true,
    hasData: true,
    totalCheckIns:  checkIns.length,
    daysBack,
    highRiskCheckIns: highRiskTotal,
    highRiskPct,
    mostCommonMood,
    mostDangerousMood: mostDangerous,
    /** How mostDangerousMood was picked: how OFTEN you flag it, not what it cost. */
    mostDangerousMoodBasis: "CHECK_IN_FREQUENCY",
    moodBreakdown,
    outcomeCorrelation,
    insight: highRiskPct > 30
      ? `${highRiskPct}% of your check-ins are in high-risk emotional states. This is worth reviewing — emotional trading is one of the most common causes of account drawdown.`
      : highRiskPct > 15
      ? `${highRiskPct}% of your check-ins are in high-risk states. Consider a brief check-in routine before each session.`
      : "Your emotional state profile looks healthy. Keep checking in to track patterns over time.",
  });
});

// ── GET /api/me/mood/states ───────────────────────────────────────────────────
router.get("/me/mood/states", requireUser, (_req, res) => {
  return res.json({
    ok: true,
    states: MOOD_STATES.map((m) => ({
      value:     m,
      ...MOOD_META[m],
      isHighRisk: HIGH_RISK_MOODS.includes(m as any),
      isCaution:  CAUTION_MOODS.includes(m as any),
    })),
  });
});

export default router;
