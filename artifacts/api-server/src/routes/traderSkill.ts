// (X) Build X — Trader Benchmark & Skill Level System routes.
//
// ISOLATION: read-only scan over journal/debriefs/reviews/paper/contracts/
// edge reports/trade plans. Writes only own tables + vault audit. Never
// references live trades / mt5_* / safetyCore / canPlaceTrades / risk
// mutation surfaces. Skill is process quality, not P&L.
//
// OWNERSHIP: scores are computed only from the caller's own rows, and every
// profile / history row is stamped with and read by req.authUser.

import { Router } from "express";
import {
  db, traderSkillProfilesTable, skillLevelHistoryTable,
  tradeJournalTable, postTradeDebriefsTable,
  weeklyPerformanceReviewsTable, paperOrdersTable,
  tradingRuleViolationsTable, edgeDiscoveryReportsTable,
  tradePlansTable, vaultEventsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();
const SKILL_DISCLAIMER =
  "Skill level measures PROCESS quality (discipline, journaling, review cadence) — not short-term profit. A higher level does NOT predict future trades will be profitable.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "skill", disclaimer: SKILL_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "skill", disclaimer: SKILL_DISCLAIMER });
}
async function vaultSkill(kind: string, severity: "INFO"|"WARN", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, skill: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Levels (process-quality thresholds) ────────────────────────────────────
const LEVELS = ["Beginner", "Developing Trader", "Disciplined Trader",
                "Consistent Trader", "Advanced Trader", "Elite Trader"] as const;
type Level = typeof LEVELS[number];

function levelFromTotal(total: number): Level {
  if (total >= 90) return "Elite Trader";
  if (total >= 75) return "Advanced Trader";
  if (total >= 60) return "Consistent Trader";
  if (total >= 45) return "Disciplined Trader";
  if (total >= 30) return "Developing Trader";
  return "Beginner";
}
function nextLevel(level: Level): Level | null {
  const i = LEVELS.indexOf(level);
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1]! : null;
}
function nextLevelThreshold(level: Level): number | null {
  // Inverse of levelFromTotal — the floor of the NEXT tier.
  switch (level) {
    case "Beginner":           return 30;
    case "Developing Trader":  return 45;
    case "Disciplined Trader": return 60;
    case "Consistent Trader":  return 75;
    case "Advanced Trader":    return 90;
    case "Elite Trader":       return null;
  }
}

// Conservative cap by sample: with very thin data we never award high scores.
function sampleCap(n: number): number {
  if (n === 0)  return 0;
  if (n < 5)    return 30;
  if (n < 15)   return 60;
  if (n < 40)   return 85;
  return 100;
}

type Pillar = "discipline" | "execution" | "risk" | "emotional" | "consistency" | "planning" | "review" | "practice";

interface Subs {
  discipline: number; execution: number; risk: number;
  emotional: number; consistency: number; planning: number;
  review: number; practice: number;
  // Diagnostic (not stored on the profile; surfaced only in suggestions)
  signals: Record<string, number>;
  // Pillars with no evidence at all: their 0 was not measured. They still
  // count as 0 in the total (no points without evidence), but the API names
  // them so the UI says "no data" instead of a measured-looking 0. Review
  // and practice are counts (0 reviews / 0 closed paper trades is observed),
  // so they are always measured.
  unmeasured: Pillar[];
}

async function loadEvidence(userId: number) {
  const [journals, debriefs, reviews, papers, violations, edges, plans] = await Promise.all([
    db.select().from(tradeJournalTable).where(eq(tradeJournalTable.userId, userId)).limit(2000),
    db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId)).limit(2000),
    db.select().from(weeklyPerformanceReviewsTable).where(eq(weeklyPerformanceReviewsTable.userId, userId)).limit(200),
    db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId)).limit(2000),
    db.select().from(tradingRuleViolationsTable).where(eq(tradingRuleViolationsTable.userId, userId)).limit(500),
    db.select().from(edgeDiscoveryReportsTable).where(eq(edgeDiscoveryReportsTable.userId, userId)).limit(200),
    db.select().from(tradePlansTable).where(eq(tradePlansTable.userId, userId)).limit(500),
  ]);
  return { journals, debriefs, reviews, papers, violations, edges, plans };
}
type Evidence = Awaited<ReturnType<typeof loadEvidence>>;

/** True when the row time is known and at or before asOfMs. Unknown time ⇒ not shown to exist then. */
function atOrBefore(t: unknown, asOfMs: number): boolean {
  if (t == null) return false;
  const ms = t instanceof Date ? t.getTime() : new Date(t as string).getTime();
  return Number.isFinite(ms) && ms <= asOfMs;
}

async function computeSubScores(userId: number): Promise<Subs> {
  return scoreEvidence(await loadEvidence(userId));
}

/**
 * Score the evidence. With `asOf`, only rows that existed then count (created
 * by then; paper trades closed by then), so a stored profile's pillars can be
 * judged on what that snapshot saw, not on today's rows.
 */
function scoreEvidence(e: Evidence, asOf?: Date): Subs {
  const asOfMs = asOf ? asOf.getTime() : null;
  const keep = <T extends { createdAt?: unknown }>(rows: T[]): T[] =>
    asOfMs == null ? rows : rows.filter((r) => atOrBefore(r.createdAt, asOfMs));
  const journals = keep(e.journals);
  const debriefs = keep(e.debriefs);
  const reviews = keep(e.reviews);
  const papers = keep(e.papers);
  const violations = keep(e.violations);
  const edges = keep(e.edges);
  const plans = keep(e.plans);

  const journalCount = journals.length;
  const debriefCount = debriefs.length;
  // Practice = paper trades that actually closed (CLOSED_TP / CLOSED_SL /
  // CLOSED_MANUAL). A CANCELLED order was voided or never filled: it is not
  // a practice trade and must not raise Practice or the sample cap.
  const closedPapers = papers.filter((p) => p.status.startsWith("CLOSED")
    && (asOfMs == null || atOrBefore(p.closedAt, asOfMs))).length;
  const totalActivity = journalCount + closedPapers;

  // ── Discipline: % of debriefs where the plan was followed ───────────────
  const followed = debriefs.filter((d) => d.followedPlan === 1).length;
  const disciplineRaw = debriefCount ? (followed / debriefCount) * 100 : 0;

  // ── Execution: avg YES-rate across debrief checklist items.
  // Checklist shape (from postTradeDebriefs route): Array<{id, answer:"YES"|"NO"|"UNSURE"}>.
  // Only YES answers credit execution; UNSURE/NO do not. Empty checklists ignored.
  let exSum = 0, exN = 0;
  for (const d of debriefs) {
    const cl = d.checklist as Array<{ answer?: string }> | null;
    if (Array.isArray(cl) && cl.length) {
      const yes = cl.filter((c) => c?.answer === "YES").length;
      exSum += (yes / cl.length) * 100;
      exN++;
    }
  }
  const executionRaw = exN ? exSum / exN : 0;

  // ── Risk: 100 minus a violation-rate penalty (capped) ───────────────────
  const violationRate = totalActivity > 0 ? violations.length / totalActivity : 0;
  const riskRaw = Math.max(0, 100 - violationRate * 200);   // 50% violation rate → 0

  // ── Emotional control: % of debriefs with calm/neutral/relieved emotion
  // minus penalty for journal entries tagged with revenge / overtrading.
  const calm = debriefs.filter((d) =>
    ["CALM", "NEUTRAL", "RELIEVED"].includes(d.traderEmotionAfter ?? "")).length;
  const emoBase = debriefCount ? (calm / debriefCount) * 100 : 0;
  const revengeTags = journals.filter((j) =>
    /revenge|overtrad|tilt|fomo/i.test(j.mistakeTag ?? "")).length;
  const revengeRate = journalCount > 0 ? revengeTags / journalCount : 0;
  const emotionalRaw = Math.max(0, emoBase - revengeRate * 100);

  // ── Consistency: STRONG/DEVELOPING edges as a fraction of all edge
  //    reports. Means the trader has identifiable, repeatable strengths.
  const goodEdges = edges.filter((e) =>
    e.status === "STRONG_EDGE" || e.status === "DEVELOPING_EDGE").length;
  const consistencyRaw = edges.length > 0 ? (goodEdges / edges.length) * 100 : 0;

  // ── Planning: trade plans per debrief (i.e., did they plan trades?) ─────
  const planningRaw = debriefCount > 0
    ? Math.min(100, (plans.length / debriefCount) * 100)
    : (plans.length > 0 ? 50 : 0);

  // ── Review: weekly reviews completed in the rolling 12-week window ──────
  const twelveWeeksAgo = (asOfMs ?? Date.now()) - 12 * 7 * 24 * 3600 * 1000;
  const recentReviews = reviews.filter((r) =>
    new Date(r.createdAt as unknown as string).getTime() >= twelveWeeksAgo).length;
  const reviewRaw = Math.min(100, (recentReviews / 12) * 100);

  // ── Practice: closed paper trades (proxy for replay/paper engagement) ───
  const practiceRaw = Math.min(100, (closedPapers / 50) * 100);

  // Sample-aware caps — never award a high score on thin evidence.
  const cap = sampleCap(totalActivity);
  const cap2 = (x: number) => Math.min(cap, Math.round(x));

  const unmeasured: Pillar[] = [];
  if (debriefCount === 0) unmeasured.push("discipline");
  if (exN === 0) unmeasured.push("execution");
  if (totalActivity === 0) unmeasured.push("risk");
  if (debriefCount === 0) unmeasured.push("emotional");
  if (edges.length === 0) unmeasured.push("consistency");
  if (debriefCount === 0 && plans.length === 0) unmeasured.push("planning");

  return {
    discipline: cap2(disciplineRaw),
    execution:  cap2(executionRaw),
    risk:       cap2(riskRaw),
    emotional:  cap2(emotionalRaw),
    consistency: cap2(consistencyRaw),
    planning:   cap2(planningRaw),
    review:     cap2(reviewRaw),
    practice:   cap2(practiceRaw),
    signals: {
      journalCount, debriefCount, reviewCount: reviews.length, recentReviews,
      closedPapers, violations: violations.length, plans: plans.length,
      goodEdges, totalEdges: edges.length, sampleCap: cap,
    },
    unmeasured,
  };
}

type ProfileRow = typeof traderSkillProfilesTable.$inferSelect;

const PILLAR_SCORE: Record<Pillar, (p: ProfileRow) => number> = {
  discipline: (p) => p.disciplineScore,
  execution: (p) => p.executionScore,
  risk: (p) => p.riskScore,
  emotional: (p) => p.emotionalControlScore,
  consistency: (p) => p.consistencyScore,
  planning: (p) => p.planningScore,
  review: (p) => p.reviewScore,
  practice: (p) => p.practiceScore,
};

/**
 * Pillars of a stored profile that were not measured: no evidence for them
 * when the snapshot was taken (rows that existed at profile.createdAt) and a
 * stored 0. Judging the snapshot by today's rows would show an old
 * no-evidence 0 as measured once evidence arrives. `withNewEvidence` names the
 * ones that have evidence now (a recalculation would score them). null when
 * the evidence could not be read — the caller then cannot tell a measured 0
 * from no data, and says so.
 */
async function unmeasuredPillarsOf(
  userId: number, profile: ProfileRow,
): Promise<{ unmeasured: Pillar[]; withNewEvidence: Pillar[] } | null> {
  try {
    const evidence = await loadEvidence(userId);
    const snapshotAt = profile.createdAt instanceof Date ? profile.createdAt : new Date(profile.createdAt as unknown as string);
    if (!Number.isFinite(snapshotAt.getTime())) return null;
    const then = scoreEvidence(evidence, snapshotAt);
    const nowUnmeasured = new Set(scoreEvidence(evidence).unmeasured);
    const unmeasured = then.unmeasured.filter((k) => PILLAR_SCORE[k](profile) === 0);
    return { unmeasured, withNewEvidence: unmeasured.filter((k) => !nowUnmeasured.has(k)) };
  } catch {
    return null;
  }
}

function totalFromSubs(s: Subs): number {
  // Equal-weighted across the 8 process pillars.
  const subs = [s.discipline, s.execution, s.risk, s.emotional,
                s.consistency, s.planning, s.review, s.practice];
  return Math.round(subs.reduce((a, c) => a + c, 0) / subs.length);
}

async function latestProfile(userId: number) {
  return (await db.select().from(traderSkillProfilesTable)
    .where(eq(traderSkillProfilesTable.userId, userId))
    .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1))[0];
}

// ── POST /skill/calculate — recompute and persist a new profile snapshot ───
router.post("/skill/calculate", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const subs = await computeSubScores(userId);
    const total = totalFromSubs(subs);
    const newLevel = levelFromTotal(total);

    // Most recent profile (if any) for level-change detection.
    const prev = await latestProfile(userId);
    const prevLevel = prev?.skillLevel ?? "Beginner";

    const ins = await db.insert(traderSkillProfilesTable).values({
      userId,
      skillLevel: newLevel, totalScore: total,
      disciplineScore: subs.discipline, executionScore: subs.execution,
      riskScore: subs.risk, emotionalControlScore: subs.emotional,
      consistencyScore: subs.consistency, planningScore: subs.planning,
      reviewScore: subs.review, practiceScore: subs.practice,
    }).returning();
    const profile = ins[0]!;

    if (prev && prevLevel !== newLevel) {
      const direction = LEVELS.indexOf(newLevel) > LEVELS.indexOf(prevLevel as Level) ? "promotion" : "demotion";
      await db.insert(skillLevelHistoryTable).values({
        userId,
        previousLevel: prevLevel, newLevel,
        reason: `${direction}: total score ${prev.totalScore.toFixed(0)} → ${total} (process-quality recompute)`,
      });
      await vaultSkill(`SKILL_LEVEL_${direction.toUpperCase()}`, direction === "demotion" ? "WARN" : "INFO",
        { from: prevLevel, to: newLevel, total });
    } else {
      await vaultSkill("SKILL_RECOMPUTED", "INFO", { level: newLevel, total });
    }

    ok(res, { profile, signals: subs.signals, unmeasuredPillars: subs.unmeasured });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /skill/calculate failed");
    fail(res, 500, "Failed to compute skill profile");
  }
});

// ── GET /skill/profile — most recent profile ───────────────────────────────
router.get("/skill/profile", requireUser, async (req, res): Promise<void> => {
  const profile = (await latestProfile(req.authUser!.id)) ?? null;
  const pillars = profile ? await unmeasuredPillarsOf(req.authUser!.id, profile) : { unmeasured: [], withNewEvidence: [] };
  ok(res, {
    profile,
    unmeasuredPillars: pillars ? pillars.unmeasured : null,
    unmeasuredPillarsWithNewEvidence: pillars ? pillars.withNewEvidence : null,
  });
});

// ── GET /skill/history ─────────────────────────────────────────────────────
router.get("/skill/history", requireUser, async (req, res): Promise<void> => {
  const rows = await db.select().from(skillLevelHistoryTable)
    .where(eq(skillLevelHistoryTable.userId, req.authUser!.id))
    .orderBy(desc(skillLevelHistoryTable.createdAt)).limit(50);
  ok(res, { history: rows });
});

// ── GET /skill/suggestions — what to improve to reach next level ───────────
router.get("/skill/suggestions", requireUser, async (req, res): Promise<void> => {
  const profile = await latestProfile(req.authUser!.id);
  if (!profile) {
    ok(res, { suggestions: [{ area: "GETTING_STARTED",
      message: "No profile yet — complete some trades and debriefs, then run 'recalculate' on this page." }] });
    return;
  }

  const subs: Array<{ key: Pillar; area: string; score: number; tip: string }> = [
    { key: "discipline", area: "Discipline",        score: profile.disciplineScore,
      tip: "After every trade, write a debrief and mark whether you actually followed your written plan." },
    { key: "execution", area: "Execution",         score: profile.executionScore,
      tip: "Use the debrief checklist (entry rules, stop placement, position size) — every box you tick raises this score." },
    { key: "risk", area: "Risk control",      score: profile.riskScore,
      tip: "Each rule violation lowers this. Re-read your active rule contracts before trading." },
    { key: "emotional", area: "Emotional control", score: profile.emotionalControlScore,
      tip: "Tag emotional state honestly. Revenge / overtrading / FOMO tags are the biggest detractors." },
    { key: "consistency", area: "Consistency",       score: profile.consistencyScore,
      tip: "Run more edge reports. STRONG_EDGE and DEVELOPING_EDGE slices are what build this score." },
    { key: "planning", area: "Planning",          score: profile.planningScore,
      tip: "Create a written trade plan for every setup before placing the trade." },
    { key: "review", area: "Review cadence",    score: profile.reviewScore,
      tip: "Complete one weekly review every week — even if the week was boring." },
    { key: "practice", area: "Practice",          score: profile.practiceScore,
      tip: "Closed paper trades and replay sessions count here. Aim for 50+ closed paper trades." },
  ];
  // Lowest two pillars first — biggest leverage points.
  subs.sort((a, b) => a.score - b.score);
  // A pillar with no evidence has no score to show: it is "no data yet",
  // never a measured 0/100. (null = evidence unreadable: scores are shown
  // as stored.)
  const pillars = await unmeasuredPillarsOf(req.authUser!.id, profile);
  const unmeasured = new Set(pillars?.unmeasured ?? []);
  const newEvidence = new Set(pillars?.withNewEvidence ?? []);

  const next = nextLevel(profile.skillLevel as Level);
  const need = nextLevelThreshold(profile.skillLevel as Level);
  const header = next && need !== null
    ? { area: "NEXT_LEVEL", score: profile.totalScore,
        message: `You're at ${profile.skillLevel} (total ${profile.totalScore.toFixed(0)}). Reach ${need} to advance to ${next}. Process quality drives this — short-term P&L does not.` }
    : { area: "AT_TOP", score: profile.totalScore,
        message: "You're at Elite Trader on process quality. Maintain the discipline that got you here — past process does not guarantee future outcomes." };

  ok(res, {
    suggestions: [header, ...subs.slice(0, 3).map((s) => (newEvidence.has(s.key)
      ? { area: s.area, message: `Not measured in this profile — there was no evidence for it when the profile was calculated, and there is some since. Recalculate to score it; until then it counts as 0 in your total. ${s.tip}` }
      : unmeasured.has(s.key)
      ? { area: s.area, message: `No data yet — this pillar has no evidence and counts as 0 in your total. ${s.tip}` }
      : { area: s.area, score: Math.round(s.score), message: s.tip }))],
  });
});

export default router;
