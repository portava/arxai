// (Y) Build Y — AI Mentor Mode routes.
//
// ISOLATION: read-only scan over skill profile, debriefs, edge reports,
// readiness, weekly reviews, rule contracts/violations. Writes only own
// tables + vault audit. Never references live trade execution / mt5_* /
// safetyCore / canPlaceTrades / risk mutation surfaces.
//
// Mentor guides BEHAVIOR. It cannot change canPlaceTrades, locks, or
// authorize trades — and the UI must surface that boundary clearly.

import { Router } from "express";
import {
  db, aiMentorSessionsTable, mentorActionItemsTable,
  traderSkillProfilesTable, postTradeDebriefsTable,
  edgeDiscoveryReportsTable, tradingReadinessChecksTable,
  weeklyPerformanceReviewsTable, tradingRuleContractsTable,
  tradingRuleViolationsTable, vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

/** Authenticated caller id — `requireUser` gates every /mentor/* route. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}
const MENTOR_DISCLAIMER =
  "Your AI mentor guides BEHAVIOR — discipline, focus, what to work on. It does NOT predict or promise profit, and it CANNOT override the safety system, risk locks, or trade authorization gates.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "mentor", disclaimer: MENTOR_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "mentor", disclaimer: MENTOR_DISCLAIMER });
}
async function vaultMentor(kind: string, severity: "INFO"|"WARN", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, mentor: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

const SESSION_TYPES = [
  "DAILY_BRIEFING", "PRE_MARKET_GUIDANCE", "POST_TRADE_GUIDANCE",
  "WEEKLY_RESET", "RISK_WARNING", "CONFIDENCE_REBUILD", "DISCIPLINE_CHECK",
] as const;
type SessionType = typeof SESSION_TYPES[number];

const GenerateBody = z.object({
  sessionType: z.enum(SESSION_TYPES).optional(),
  relatedTradeId: z.number().int().optional(),
});

// ── Context loader (READ-ONLY across 7 systems) ────────────────────────────
// ISOLATION: `userId` is required — every one of the seven reads below feeds
// text the mentor presents as "your" skill, "your" mistakes, "your" violated
// rules. There is no honest unscoped variant of this briefing.
async function loadContext(userId: number) {
  const [skill, debriefs, edges, readiness, reviews, contracts, violations] = await Promise.all([
    db.select().from(traderSkillProfilesTable)
      .where(eq(traderSkillProfilesTable.userId, userId))
      .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
    db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(20),
    db.select().from(edgeDiscoveryReportsTable)
      .where(eq(edgeDiscoveryReportsTable.userId, userId))
      .orderBy(desc(edgeDiscoveryReportsTable.confidenceScore)).limit(20),
    db.select().from(tradingReadinessChecksTable)
      .where(eq(tradingReadinessChecksTable.userId, userId))
      .orderBy(desc(tradingReadinessChecksTable.id)).limit(1),
    db.select().from(weeklyPerformanceReviewsTable)
      .where(eq(weeklyPerformanceReviewsTable.userId, userId))
      .orderBy(desc(weeklyPerformanceReviewsTable.createdAt)).limit(1),
    db.select().from(tradingRuleContractsTable)
      .where(eq(tradingRuleContractsTable.userId, userId)).limit(20),
    db.select().from(tradingRuleViolationsTable)
      .where(eq(tradingRuleViolationsTable.userId, userId))
      .orderBy(desc(tradingRuleViolationsTable.id)).limit(20),
  ]);
  const recentMistakes = debriefs
    .map((d) => d.biggestMistake).filter((m): m is string => !!m && m.length > 0).slice(0, 5);
  const strongestEdge = edges.find((e) => e.status === "STRONG_EDGE")
                     ?? edges.find((e) => e.status === "DEVELOPING_EDGE")
                     ?? null;
  const weakestEdge   = edges.find((e) => e.status === "NO_EDGE")
                     ?? edges.find((e) => e.status === "WEAK_EDGE")
                     ?? null;
  return {
    skill: skill[0] ?? null,
    recentDebriefs: debriefs,
    recentMistakes,
    strongestEdge, weakestEdge,
    readiness: readiness[0] ?? null,
    weeklyReview: reviews[0] ?? null,
    activeContracts: contracts,
    recentViolations: violations.slice(0, 10),
  };
}
type Ctx = Awaited<ReturnType<typeof loadContext>>;

// ── Auto-detect the most appropriate session type ──────────────────────────
function detectSessionType(ctx: Ctx, requested?: SessionType, relatedTradeId?: number): SessionType {
  if (requested) return requested;
  // Trade-linked invocation (e.g. from post-trade flow) → POST_TRADE_GUIDANCE.
  if (relatedTradeId != null) return "POST_TRADE_GUIDANCE";
  // Hard violations in last 10 → RISK_WARNING wins (highest urgency).
  if (ctx.recentViolations.some((v) => v.severity === "HARD")) return "RISK_WARNING";
  // Readiness LOCKED/NOT_READY → DISCIPLINE_CHECK.
  const rs = ctx.readiness?.status;
  if (rs === "LOCKED" || rs === "NOT_READY") return "DISCIPLINE_CHECK";
  // Low emotional or discipline pillar → CONFIDENCE_REBUILD.
  if (ctx.skill && (ctx.skill.emotionalControlScore < 40 || ctx.skill.disciplineScore < 40))
    return "CONFIDENCE_REBUILD";
  // Time-of-week / time-of-day cues for the remaining three types.
  const now = new Date();
  const dow = now.getUTCDay();   // 0=Sun, 1=Mon
  const hr  = now.getUTCHours();
  if (dow === 1 && hr < 12) return "WEEKLY_RESET";          // Monday morning UTC
  if (hr >= 6 && hr < 12)   return "PRE_MARKET_GUIDANCE";   // pre-market window
  return "DAILY_BRIEFING";
}

// ── Compose session text ───────────────────────────────────────────────────
function compose(sessionType: SessionType, ctx: Ctx): {
  mainFocus: string; mentorMessage: string; recommendedAction: string;
  relatedTradeId: number | null; relatedStrategyId: number | null;
  actions: Array<{ title: string; description: string }>;
} {
  const level = ctx.skill?.skillLevel ?? "Beginner";
  const totalScore = Math.round(ctx.skill?.totalScore ?? 0);
  const weakestPillar = pickWeakestPillar(ctx.skill);
  const oneRule = pickOneRule(ctx);
  const oneStrength = ctx.strongestEdge?.edgeName ?? null;
  const oneMistake  = ctx.recentMistakes[0] ?? "drifting from your written plan";

  switch (sessionType) {
    case "RISK_WARNING": {
      // Guard: a user can request RISK_WARNING manually with no HARD violations
      // present. Fall back to a generic risk warning rather than throwing.
      const v = ctx.recentViolations.find((x) => x.severity === "HARD")
            ?? ctx.recentViolations.find((x) => x.severity === "WARN")
            ?? null;
      const ref = v ? `"${(v.message ?? v.violationType ?? "").slice(0, 120)}"` : "your recent risk indicators";
      return {
        mainFocus: "Stop. Re-anchor to your rules.",
        mentorMessage:
          `A risk warning was raised based on ${ref}. Before another trade, pause for at least one full session. ` +
          `Open your rule contract, re-read the violated line out loud, and write — by hand — what you'll do differently the next session.`,
        recommendedAction: "Pause trading. Re-read your rule contract. Write your correction.",
        relatedTradeId: null, relatedStrategyId: null,
        actions: [
          { title: "Pause for one session",   description: "No new trades for the rest of today. Use the time to journal." },
          { title: "Re-read rule contract",   description: "Open the violated rule. Read it out loud. Write your correction." },
          { title: "Submit a discipline debrief", description: "File a debrief explaining the violation honestly — no excuses." },
        ],
      };
    }
    case "DISCIPLINE_CHECK": {
      const why = ctx.readiness?.status === "LOCKED" ? "you are LOCKED out by the safety system"
                : ctx.readiness?.status === "NOT_READY" ? "your readiness check came back NOT_READY"
                : "discipline indicators are slipping";
      return {
        mainFocus: "Today is a no-trade discipline day.",
        mentorMessage:
          `${cap(why)}. The mentor will not negotiate this. Use today for process work — review your last 10 trades, run an edge report, ` +
          `complete a weekly review if you owe one. The trades will still be there tomorrow.`,
        recommendedAction: "Complete process work. Do not place trades today.",
        relatedTradeId: null, relatedStrategyId: null,
        actions: [
          { title: "Run an edge report",    description: "Generate or re-read an edge report. Look honestly." },
          { title: "Review last 10 trades", description: "Read every debrief. Look for one repeat pattern." },
        ],
      };
    }
    case "CONFIDENCE_REBUILD": {
      return {
        mainFocus: "Rebuild from process — small, slow, repeatable.",
        mentorMessage:
          `Your ${weakestPillar.label} score is at ${weakestPillar.score}. That's a process problem, not a skill problem — and process is the fastest thing you can fix. ` +
          (oneStrength
            ? `Lean into ONE thing you've shown you can do: ${oneStrength}. Trade that, and only that, for the next 5 trades.`
            : `Reduce surface area. Pick one symbol, one strategy, smallest size, and trade only that for the next 5 entries.`),
        recommendedAction: oneStrength
          ? `Trade only ${oneStrength}, smallest size, for the next 5 trades.`
          : `Pick one setup. Smallest size. 5 trades only. Then stop and review.`,
        relatedTradeId: null,
        relatedStrategyId: ctx.strongestEdge?.strategyId ?? null,
        actions: [
          { title: "Reduce to one setup",      description: "Pick one symbol + one strategy. Nothing else for 5 trades." },
          { title: "Smallest position size",   description: "Use the minimum lot. Outcome is irrelevant; execution is everything." },
          { title: "Debrief every single one", description: "All 5 trades get a full debrief. No exceptions." },
        ],
      };
    }
    case "POST_TRADE_GUIDANCE": {
      return {
        mainFocus: "Capture what just happened — honestly.",
        mentorMessage:
          `Open the debrief now while the trade is fresh. The single highest-leverage habit at the ${level} level is writing the debrief in the first 10 minutes. ` +
          `Be honest about whether you followed your plan; the data is more valuable than your ego.`,
        recommendedAction: "Write the post-trade debrief. Right now.",
        relatedTradeId: null, relatedStrategyId: null,
        actions: [
          { title: "Submit debrief now", description: "Use the standard 7-question checklist. Don't skip the emotion field." },
        ],
      };
    }
    case "PRE_MARKET_GUIDANCE": {
      const session = ctx.weeklyReview?.bestSession ?? "your usual session";
      return {
        mainFocus: `Trade ${session}. Trade your strongest setup. Skip the rest.`,
        mentorMessage:
          `Today's plan: trade only your strongest known edge${oneStrength ? ` (${oneStrength})` : ""}. ` +
          `One rule to respect: ${oneRule}. One mistake to avoid: ${oneMistake}. ` +
          `If conditions don't match, don't trade — there is no penalty for sitting out.`,
        recommendedAction: `Stick to one setup. Skip if conditions don't match. Debrief every entry.`,
        relatedTradeId: null,
        relatedStrategyId: ctx.strongestEdge?.strategyId ?? null,
        actions: [
          { title: "Confirm conditions before each entry", description: "Setup criteria must match. If unsure, skip." },
          { title: "Cap the day",                          description: "Hard limit on number of trades and total loss for today." },
        ],
      };
    }
    case "WEEKLY_RESET": {
      const focus = ctx.weeklyReview?.nextWeekFocus ?? `improve your weakest pillar: ${weakestPillar.label}`;
      return {
        mainFocus: `This week's focus: ${focus}.`,
        mentorMessage:
          `New week, fresh slate. Last week your weakest area was ${weakestPillar.label} (${weakestPillar.score}/100). ` +
          `Pick ONE concrete behavior to change — not three, not five. Behavior change compounds; ambition does not.`,
        recommendedAction: `Pick one process change. Track it daily. Review on Friday.`,
        relatedTradeId: null, relatedStrategyId: null,
        actions: [
          { title: "Choose one weekly behavior change", description: `Tied to: ${weakestPillar.label}. One sentence, specific.` },
          { title: "Schedule end-of-week review",       description: "Same time, every week. Non-negotiable." },
        ],
      };
    }
    case "DAILY_BRIEFING":
    default: {
      return {
        mainFocus: oneStrength
          ? `Lean into ${oneStrength}. Skip everything else.`
          : `Build the sample. Trade small, journal everything.`,
        mentorMessage:
          `${level} (${totalScore}/100). ` +
          `Top warning: ${ctx.weakestEdge ? `your data shows NO measurable edge on ${ctx.weakestEdge.edgeName} — avoid it today.` : `watch for ${oneMistake}.`} ` +
          `One rule to respect: ${oneRule}. One strength to lean into: ${oneStrength ?? "patience — wait for your A+ setup"}. ` +
          `Recommended drill: write a one-line trade plan for the very next setup before you click anything.`,
        recommendedAction: `Plan, execute, debrief. One setup at a time.`,
        relatedTradeId: null,
        relatedStrategyId: ctx.strongestEdge?.strategyId ?? null,
        actions: [
          { title: "Write one trade plan before market open", description: "Symbol, direction, entry, stop, target. One line." },
          { title: "Debrief every trade",                      description: "No exceptions. The plan is to follow the plan." },
        ],
      };
    }
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function pickWeakestPillar(p: typeof traderSkillProfilesTable.$inferSelect | null) {
  if (!p) return { label: "discipline", score: 0 };
  const opts: Array<{ label: string; score: number }> = [
    { label: "discipline",        score: p.disciplineScore },
    { label: "execution",         score: p.executionScore },
    { label: "risk control",      score: p.riskScore },
    { label: "emotional control", score: p.emotionalControlScore },
    { label: "consistency",       score: p.consistencyScore },
    { label: "planning",          score: p.planningScore },
    { label: "review cadence",    score: p.reviewScore },
    { label: "practice",          score: p.practiceScore },
  ];
  opts.sort((a, b) => a.score - b.score);
  return { label: opts[0]!.label, score: Math.round(opts[0]!.score) };
}
function pickOneRule(ctx: Ctx): string {
  // Prefer an active contract's first no-trade condition; otherwise derive a
  // hard numeric rule from the contract; otherwise a sensible default.
  const active = ctx.activeContracts.find((c) => c.isActive === 1) ?? ctx.activeContracts[0];
  if (active) {
    const noTrade = (active.noTradeConditions ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (noTrade[0]) return `do not trade when: ${noTrade[0]}`.slice(0, 140);
    if (active.maxDailyLossPercent != null)
      return `stop trading once you hit ${Math.round(active.maxDailyLossPercent * 100)}% daily loss.`;
    if (active.maxTradesPerDay != null)
      return `cap yourself at ${active.maxTradesPerDay} trades today, no exceptions.`;
    if (active.requiredRrMinimum != null)
      return `every trade must have at least ${active.requiredRrMinimum.toFixed(1)}R reward-to-risk.`;
  }
  return "stop trading the moment you feel the urge to 'make it back'.";
}

// ── POST /mentor/sessions — generate a new session ─────────────────────────
router.post("/mentor/sessions", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = uid(req);
    const b = GenerateBody.parse(req.body ?? {});
    const ctx = await loadContext(userId);
    const sessionType = detectSessionType(ctx, b.sessionType, b.relatedTradeId);
    const composed = compose(sessionType, ctx);

    const ins = await db.insert(aiMentorSessionsTable).values({
      userId,
      sessionType,
      skillLevel: ctx.skill?.skillLevel ?? "Beginner",
      mainFocus: composed.mainFocus,
      mentorMessage: composed.mentorMessage,
      recommendedAction: composed.recommendedAction,
      relatedTradeId: b.relatedTradeId ?? composed.relatedTradeId ?? null,
      relatedStrategyId: composed.relatedStrategyId ?? null,
    }).returning();
    const session = ins[0]!;

    const items: typeof mentorActionItemsTable.$inferSelect[] = [];
    for (const a of composed.actions) {
      const r = await db.insert(mentorActionItemsTable).values({
        userId,
        mentorSessionId: session.id,
        actionTitle: a.title, actionDescription: a.description,
      }).returning();
      items.push(r[0]!);
    }

    await vaultMentor(`MENTOR_${sessionType}`,
      sessionType === "RISK_WARNING" || sessionType === "DISCIPLINE_CHECK" ? "WARN" : "INFO",
      { sessionId: session.id, level: session.skillLevel, actions: items.length });

    ok(res, { session, actionItems: items });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /mentor/sessions failed");
    fail(res, 500, "Failed to generate mentor session");
  }
});

// ── GET /mentor/sessions/latest ────────────────────────────────────────────
router.get("/mentor/sessions/latest", requireUser, async (req, res): Promise<void> => {
  const userId = uid(req);
  const session = (await db.select().from(aiMentorSessionsTable)
    .where(eq(aiMentorSessionsTable.userId, userId))
    .orderBy(desc(aiMentorSessionsTable.createdAt)).limit(1))[0] ?? null;
  if (!session) { ok(res, { session: null, actionItems: [] }); return; }
  const items = await db.select().from(mentorActionItemsTable)
    .where(and(
      eq(mentorActionItemsTable.mentorSessionId, session.id),
      eq(mentorActionItemsTable.userId, userId),
    ));
  ok(res, { session, actionItems: items });
});

// ── GET /mentor/sessions ───────────────────────────────────────────────────
router.get("/mentor/sessions", requireUser, async (req, res): Promise<void> => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 100)) : 25;
  const rows = await db.select().from(aiMentorSessionsTable)
    .where(eq(aiMentorSessionsTable.userId, uid(req)))
    .orderBy(desc(aiMentorSessionsTable.createdAt)).limit(limit);
  ok(res, { sessions: rows });
});

// ── GET /mentor/action-items ───────────────────────────────────────────────
router.get("/mentor/action-items", requireUser, async (req, res): Promise<void> => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : null;
  const all = await db.select().from(mentorActionItemsTable)
    .where(eq(mentorActionItemsTable.userId, uid(req)))
    .orderBy(desc(mentorActionItemsTable.createdAt)).limit(200);
  ok(res, { actionItems: status ? all.filter((a) => a.status === status) : all });
});

// ── PATCH /mentor/action-items/:id ─────────────────────────────────────────
const PatchBody = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "SKIPPED"]),
});
router.patch("/mentor/action-items/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const body = PatchBody.parse(req.body ?? {});
    // Ownership is part of the WHERE clause: a foreign action-item id updates
    // zero rows and answers 404.
    const upd = await db.update(mentorActionItemsTable)
      .set({ status: body.status, updatedAt: new Date() })
      .where(and(
        eq(mentorActionItemsTable.id, id),
        eq(mentorActionItemsTable.userId, uid(req)),
      ))
      .returning();
    if (upd.length === 0) { fail(res, 404, "Not found"); return; }
    await vaultMentor("MENTOR_ACTION_STATUS",
      body.status === "SKIPPED" ? "WARN" : "INFO",
      { actionItemId: id, newStatus: body.status });
    ok(res, { actionItem: upd[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /mentor/action-items/:id failed");
    fail(res, 500, "Failed to update action item");
  }
});

export default router;
