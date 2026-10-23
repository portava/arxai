// (U) Build U — AI Post-Trade Debrief routes.
//
// One debrief per closed paper trade. ISOLATION: reads paper_orders only;
// never references trades/livePositions/mt5_*/safetyCore/canPlaceTrades.
// AI feedback is deterministic + heuristic from stored fields — no external
// LLM call. No guaranteed-profit claims; coaching tone, not punitive.

import { Router } from "express";
import {
  db, postTradeDebriefsTable, paperOrdersTable, vaultEventsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();
const DEBRIEF_DISCLAIMER =
  "Post-trade debriefs are reflective coaching aids. They do not predict future results or guarantee profitability.";

// Envelope flag is namespaced ("system") so it cannot collide with a "debrief"
// row key in the body.
function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "debrief", disclaimer: DEBRIEF_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "debrief", disclaimer: DEBRIEF_DISCLAIMER });
}
async function vaultDebrief(kind: string, severity: "INFO"|"WARN", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, debrief: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Canonical 7-question debrief checklist ─────────────────────────────────
export const DEBRIEF_QUESTIONS: ReadonlyArray<{ id: string; q: string }> = [
  { id: "followed_plan",     q: "Did you follow your trade plan?" },
  { id: "respected_stop",    q: "Did you respect your stop loss?" },
  { id: "exited_per_plan",   q: "Did you exit according to plan?" },
  { id: "patient_entry",     q: "Was the entry patient (not rushed)?" },
  { id: "emotion_free",      q: "Were you emotion-free during the trade?" },
  { id: "would_repeat",      q: "Is there something you would repeat?" },
  { id: "would_change",      q: "Is there something you would change?" },
];

const ChecklistItem = z.object({
  id: z.string(),
  answer: z.enum(["YES", "NO", "UNSURE"]),
  note: z.string().max(280).optional(),
});

const EMOTIONS = ["CALM","FRUSTRATED","RELIEVED","EUPHORIC","NEUTRAL","ANXIOUS","DISAPPOINTED"] as const;

const CreateBody = z.object({
  tradeId: z.number().int().positive(),
  checklist: z.array(ChecklistItem).max(20).default([]),
  traderEmotionAfter: z.enum(EMOTIONS).optional(),
  biggestMistake:  z.string().max(500).optional(),
  biggestStrength: z.string().max(500).optional(),
  lessonLearned:   z.string().max(500).optional(),
});
const UpdateBody = CreateBody.partial().omit({ tradeId: true });

// ── Helpers ────────────────────────────────────────────────────────────────
function classifyResult(pnl: number): "WIN"|"LOSS"|"BREAKEVEN" {
  if (pnl > 0.0001)  return "WIN";
  if (pnl < -0.0001) return "LOSS";
  return "BREAKEVEN";
}
function answersById(checklist: Array<z.infer<typeof ChecklistItem>>): Record<string, "YES"|"NO"|"UNSURE"> {
  const m: Record<string, "YES"|"NO"|"UNSURE"> = {};
  for (const c of checklist) m[c.id] = c.answer;
  return m;
}
function followedPlanFlag(checklist: Array<z.infer<typeof ChecklistItem>>): 0 | 1 {
  const a = answersById(checklist);
  return a["followed_plan"] === "YES" && a["respected_stop"] === "YES" && a["exited_per_plan"] === "YES" ? 1 : 0;
}

interface TradeLike {
  symbol: string; direction: string; profitLoss: number;
  entryPrice: number; exitPrice: number | null;
  stopLoss: number | null; takeProfit: number | null;
}
function generateAiFeedback(
  trade: TradeLike,
  result: "WIN"|"LOSS"|"BREAKEVEN",
  checklist: Array<z.infer<typeof ChecklistItem>>,
  emotion: string | null,
): { feedback: string; drill: string } {
  const a = answersById(checklist);
  const lines: string[] = [];
  // Result framing — coaching tone, no guarantees.
  if (result === "WIN") {
    lines.push(`Win on ${trade.symbol} ${trade.direction} (${trade.profitLoss.toFixed(2)}). A win is feedback, not proof of skill — examine process before celebrating.`);
  } else if (result === "LOSS") {
    lines.push(`Loss on ${trade.symbol} ${trade.direction} (${trade.profitLoss.toFixed(2)}). Losses are tuition. The question is whether the loss was earned by the plan or by deviation.`);
  } else {
    lines.push(`Breakeven on ${trade.symbol} ${trade.direction}. Often the most useful trade to study — was the setup wrong or was management right?`);
  }
  // Process critique — independent of outcome.
  if (a["followed_plan"] === "NO")     lines.push("You did not follow the plan. The single most important fix this week is reducing plan deviation.");
  if (a["respected_stop"] === "NO")    lines.push("Stop loss was not respected. This is the highest-leverage habit in trading; rebuild it before increasing size.");
  if (a["exited_per_plan"] === "NO")   lines.push("Exit deviated from plan. Note whether you exited too early on a winner or too late on a loser — they require different drills.");
  if (a["patient_entry"]  === "NO")    lines.push("Entry was rushed. Practice waiting for confirmation; consider a mandatory 30-second pause before sending the order.");
  if (a["emotion_free"]   === "NO")    lines.push(`Emotion was present (${emotion ?? "self-reported"}). Emotion is data — log the trigger before acting on the next setup.`);
  if (a["would_repeat"]   === "YES" && (result === "WIN" || result === "BREAKEVEN"))
    lines.push("Identifying what to repeat is half the work of building consistency.");
  if (a["would_change"]   === "YES")
    lines.push("Naming what to change is more valuable than the trade's P&L.");
  // Geometry observations from stored fields (no external data).
  if (trade.stopLoss != null && trade.takeProfit != null && trade.exitPrice != null) {
    const reward = Math.abs(trade.takeProfit - trade.entryPrice);
    const risk   = Math.abs(trade.entryPrice - trade.stopLoss);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < 1)  lines.push(`Plan R:R was ${rr.toFixed(2)} — sub-1:1 setups need an above-average win rate to break even. Reconsider this geometry.`);
    if (rr >= 2 && result === "LOSS") lines.push(`R:R was ${rr.toFixed(2)} — losing this is acceptable if the entry was valid. A losing 2R trade is not the same as a mistake.`);
  }
  // Drill recommendation — derived from the dominant weakness.
  let drill = "";
  if (a["respected_stop"] === "NO")        drill = "Replay 5 historical setups and force-exit at the original stop with no exceptions.";
  else if (a["patient_entry"] === "NO")    drill = "Replay 10 candles before each entry — only mark trades you would still take after the wait.";
  else if (a["exited_per_plan"] === "NO")  drill = "Replay 5 of your winners — practice exiting exactly at the planned target, no trailing.";
  else if (a["followed_plan"] === "NO")    drill = "Pre-write 3 plans tomorrow morning and grade each closed trade against its written plan.";
  else if (a["emotion_free"] === "NO")     drill = "Replay your last 3 emotional trades and journal the trigger before each entry.";
  else if (result === "WIN")               drill = "Replay this exact setup back-to-back to imprint the pattern.";
  else                                     drill = "Replay 3 similar setups and journal what would have changed your decision.";
  return { feedback: lines.join(" "), drill };
}

// ── POST /post-trade-debriefs ──────────────────────────────────────────────
router.post("/post-trade-debriefs", async (req, res): Promise<void> => {
  try {
    const b = CreateBody.parse(req.body ?? {});
    const trade = (await db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.id, b.tradeId)).limit(1))[0];
    if (!trade) { fail(res, 404, "Trade not found"); return; }
    if (trade.status === "OPEN") { fail(res, 409, "Trade is still open — debrief after close"); return; }
    const existing = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.tradeId, b.tradeId)).limit(1))[0];
    if (existing) { fail(res, 409, "Debrief already exists for this trade", { debriefId: existing.id }); return; }

    const result = classifyResult(trade.profitLoss);
    const ai = generateAiFeedback(
      { symbol: trade.symbol, direction: trade.direction, profitLoss: trade.profitLoss,
        entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit },
      result, b.checklist, b.traderEmotionAfter ?? null,
    );

    const ins = await db.insert(postTradeDebriefsTable).values({
      tradeId: b.tradeId,
      result,
      checklist: b.checklist,
      followedPlan: followedPlanFlag(b.checklist),
      traderEmotionAfter: b.traderEmotionAfter ?? null,
      biggestMistake:  b.biggestMistake ?? null,
      biggestStrength: b.biggestStrength ?? null,
      lessonLearned:   b.lessonLearned ?? null,
      aiFeedback: ai.feedback,
      recommendedDrill: ai.drill,
    }).returning();

    const followed = followedPlanFlag(b.checklist) === 1;
    await vaultDebrief(`POST_TRADE_DEBRIEF_${result}`, followed ? "INFO" : "WARN", {
      debriefId: ins[0]!.id, tradeId: b.tradeId, result, followedPlan: followed,
    });
    ok(res, { debrief: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /post-trade-debriefs failed");
    fail(res, 500, "Failed to create debrief");
  }
});

// ── GET /post-trade-debriefs ───────────────────────────────────────────────
router.get("/post-trade-debriefs", async (req, res): Promise<void> => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 200)) : 50;
  const rows = await db.select().from(postTradeDebriefsTable)
    .orderBy(desc(postTradeDebriefsTable.createdAt)).limit(limit);
  ok(res, { debriefs: rows, questions: DEBRIEF_QUESTIONS });
});

// ── GET /post-trade-debriefs/by-trade/:tradeId ─────────────────────────────
router.get("/post-trade-debriefs/by-trade/:tradeId", async (req, res): Promise<void> => {
  const tid = Number(req.params["tradeId"]);
  if (!Number.isFinite(tid)) { fail(res, 400, "Invalid tradeId"); return; }
  const r = (await db.select().from(postTradeDebriefsTable)
    .where(eq(postTradeDebriefsTable.tradeId, tid)).limit(1))[0];
  if (!r) { fail(res, 404, "No debrief for this trade"); return; }
  ok(res, { debrief: r });
});

// ── PATCH /post-trade-debriefs/:id ─────────────────────────────────────────
router.patch("/post-trade-debriefs/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = UpdateBody.parse(req.body ?? {});
    const cur = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.id, id)).limit(1))[0];
    if (!cur) { fail(res, 404, "Not found"); return; }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.checklist !== undefined) {
      patch["checklist"] = b.checklist;
      patch["followedPlan"] = followedPlanFlag(b.checklist);
    }
    if (b.traderEmotionAfter !== undefined) patch["traderEmotionAfter"] = b.traderEmotionAfter;
    if (b.biggestMistake !== undefined)     patch["biggestMistake"]     = b.biggestMistake;
    if (b.biggestStrength !== undefined)    patch["biggestStrength"]    = b.biggestStrength;
    if (b.lessonLearned !== undefined)      patch["lessonLearned"]      = b.lessonLearned;
    await db.update(postTradeDebriefsTable).set(patch).where(eq(postTradeDebriefsTable.id, id));
    const r = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.id, id)).limit(1))[0];
    ok(res, { debrief: r });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /post-trade-debriefs/:id failed");
    fail(res, 500, "Failed to update debrief");
  }
});

// ── POST /post-trade-debriefs/:id/regenerate ───────────────────────────────
// Regenerate AI feedback + drill from current debrief state (after a PATCH).
router.post("/post-trade-debriefs/:id/regenerate", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const cur = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.id, id)).limit(1))[0];
    if (!cur) { fail(res, 404, "Not found"); return; }
    const trade = (await db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.id, cur.tradeId)).limit(1))[0];
    if (!trade) { fail(res, 404, "Underlying trade not found"); return; }
    const ai = generateAiFeedback(
      { symbol: trade.symbol, direction: trade.direction, profitLoss: trade.profitLoss,
        entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit },
      cur.result as "WIN"|"LOSS"|"BREAKEVEN",
      Array.isArray(cur.checklist) ? (cur.checklist as Array<z.infer<typeof ChecklistItem>>) : [],
      cur.traderEmotionAfter,
    );
    await db.update(postTradeDebriefsTable)
      .set({ aiFeedback: ai.feedback, recommendedDrill: ai.drill, updatedAt: new Date() })
      .where(eq(postTradeDebriefsTable.id, id));
    const r = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.id, id)).limit(1))[0];
    ok(res, { debrief: r });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /post-trade-debriefs/:id/regenerate failed");
    fail(res, 500, "Failed to regenerate feedback");
  }
});

export default router;
