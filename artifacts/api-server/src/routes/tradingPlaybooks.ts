// (V) Build V — Personal Trading Playbook routes.
//
// ISOLATION: reads journal/debriefs/reviews to surface heuristic suggestions;
// never references trades/livePositions/mt5_*/safetyCore/canPlaceTrades and
// never mutates strategy or risk surfaces. Playbook is a guidance document.

import { Router } from "express";
import {
  db, tradingPlaybooksTable, playbookEntriesTable,
  tradeJournalTable, postTradeDebriefsTable,
  weeklyPerformanceReviewsTable as weeklyReviewsTable,
  vaultEventsTable,
} from "@workspace/db";
import { desc, eq, and, or, not, like, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { TESTER_SEED_STRATEGY_PREFIX } from "../lib/testerData/tags.js";

const router = Router();
const PLAYBOOK_DISCLAIMER =
  "Playbook entries are personal guidance derived from your own trading data. They are not predictive and do not guarantee profitable outcomes.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "playbook", disclaimer: PLAYBOOK_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "playbook", disclaimer: PLAYBOOK_DISCLAIMER });
}
async function vaultPlaybook(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, playbook: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

export const ENTRY_TYPES = [
  "BEST_SETUP","AVOID_SETUP","RULE","MISTAKE_PATTERN","STRENGTH_PATTERN",
  "MARKET_CONDITION","SESSION_NOTE","RISK_RULE","EXIT_RULE","ENTRY_RULE",
] as const;
const SOURCES = ["MANUAL","AI","JOURNAL","DEBRIEF","REVIEW"] as const;

const PlaybookCreate = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(""),
  isActive: z.boolean().optional().default(true),
});
const EntryCreate = z.object({
  playbookId: z.number().int().positive(),
  entryType: z.enum(ENTRY_TYPES),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(""),
  relatedStrategyId: z.number().int().positive().optional(),
  relatedTradeId:    z.number().int().positive().optional(),
  relatedReviewId:   z.number().int().positive().optional(),
  confidenceScore:   z.number().min(0).max(100).optional().default(70),
  source: z.enum(SOURCES).optional().default("MANUAL"),
});
const EntryPatch = z.object({
  entryType:        z.enum(ENTRY_TYPES).optional(),
  title:            z.string().min(1).max(200).optional(),
  description:      z.string().max(2000).optional(),
  confidenceScore:  z.number().min(0).max(100).optional(),
  isActive:         z.boolean().optional(),
}).strict();

// ── Playbooks ──────────────────────────────────────────────────────────────
router.post("/playbooks", async (req, res): Promise<void> => {
  try {
    const b = PlaybookCreate.parse(req.body ?? {});
    const ins = await db.insert(tradingPlaybooksTable).values({
      title: b.title, description: b.description ?? "",
      isActive: b.isActive ? 1 : 0,
    }).returning();
    await vaultPlaybook("PLAYBOOK_CREATED", { playbookId: ins[0]!.id, title: b.title });
    ok(res, { playbook: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /playbooks failed");
    fail(res, 500, "Failed to create playbook");
  }
});

router.get("/playbooks", async (_req, res): Promise<void> => {
  const rows = await db.select().from(tradingPlaybooksTable)
    .orderBy(desc(tradingPlaybooksTable.updatedAt));
  ok(res, { playbooks: rows });
});

router.get("/playbooks/active", async (_req, res): Promise<void> => {
  const r = (await db.select().from(tradingPlaybooksTable)
    .where(eq(tradingPlaybooksTable.isActive, 1))
    .orderBy(desc(tradingPlaybooksTable.updatedAt)).limit(1))[0];
  if (!r) { ok(res, { playbook: null }); return; }
  ok(res, { playbook: r });
});

router.patch("/playbooks/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      isActive: z.boolean().optional(),
    }).strict().parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title !== undefined)       patch["title"]       = b.title;
    if (b.description !== undefined) patch["description"] = b.description;
    if (b.isActive !== undefined)    patch["isActive"]    = b.isActive ? 1 : 0;
    await db.update(tradingPlaybooksTable).set(patch).where(eq(tradingPlaybooksTable.id, id));
    const r = (await db.select().from(tradingPlaybooksTable)
      .where(eq(tradingPlaybooksTable.id, id)).limit(1))[0];
    if (!r) { fail(res, 404, "Not found"); return; }
    ok(res, { playbook: r });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /playbooks/:id failed");
    fail(res, 500, "Failed to update playbook");
  }
});

// ── Entries ────────────────────────────────────────────────────────────────
router.post("/playbook-entries", async (req, res): Promise<void> => {
  try {
    const b = EntryCreate.parse(req.body ?? {});
    const pb = (await db.select().from(tradingPlaybooksTable)
      .where(eq(tradingPlaybooksTable.id, b.playbookId)).limit(1))[0];
    if (!pb) { fail(res, 404, "Playbook not found"); return; }
    const ins = await db.insert(playbookEntriesTable).values({
      playbookId: b.playbookId,
      entryType: b.entryType,
      title: b.title,
      description: b.description ?? "",
      relatedStrategyId: b.relatedStrategyId ?? null,
      relatedTradeId:    b.relatedTradeId ?? null,
      relatedReviewId:   b.relatedReviewId ?? null,
      confidenceScore:   b.confidenceScore ?? 70,
      source: b.source ?? "MANUAL",
    }).returning();
    await vaultPlaybook("PLAYBOOK_ENTRY_CREATED", {
      entryId: ins[0]!.id, playbookId: b.playbookId, entryType: b.entryType, source: b.source,
    });
    ok(res, { entry: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /playbook-entries failed");
    fail(res, 500, "Failed to create entry");
  }
});

router.get("/playbook-entries", async (req, res): Promise<void> => {
  const playbookId = Number(req.query["playbookId"]);
  if (!Number.isFinite(playbookId)) { fail(res, 400, "playbookId required"); return; }
  const entryType = req.query["entryType"] as string | undefined;
  const cond = entryType
    ? and(eq(playbookEntriesTable.playbookId, playbookId), eq(playbookEntriesTable.entryType, entryType))
    : eq(playbookEntriesTable.playbookId, playbookId);
  const rows = await db.select().from(playbookEntriesTable)
    .where(cond).orderBy(desc(playbookEntriesTable.confidenceScore), desc(playbookEntriesTable.updatedAt));
  ok(res, { entries: rows });
});

router.patch("/playbook-entries/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = EntryPatch.parse(req.body ?? {});
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.entryType !== undefined)        patch["entryType"]       = b.entryType;
    if (b.title !== undefined)            patch["title"]           = b.title;
    if (b.description !== undefined)      patch["description"]     = b.description;
    if (b.confidenceScore !== undefined)  patch["confidenceScore"] = b.confidenceScore;
    if (b.isActive !== undefined)         patch["isActive"]        = b.isActive ? 1 : 0;
    await db.update(playbookEntriesTable).set(patch).where(eq(playbookEntriesTable.id, id));
    const r = (await db.select().from(playbookEntriesTable)
      .where(eq(playbookEntriesTable.id, id)).limit(1))[0];
    if (!r) { fail(res, 404, "Not found"); return; }
    ok(res, { entry: r });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /playbook-entries/:id failed");
    fail(res, 500, "Failed to update entry");
  }
});

// ── AI Suggestions ─────────────────────────────────────────────────────────
// Heuristic. Reads journal + debriefs + weekly reviews to mine recurring
// patterns. NEVER inserts entries automatically — returns a list of candidate
// entries the trader can accept/edit/reject. Confidence scaled by evidence.
interface Suggestion {
  entryType: typeof ENTRY_TYPES[number];
  title: string;
  description: string;
  confidenceScore: number;
  source: "AI";
  evidence: { tradeIds: number[]; debriefIds: number[]; reviewIds: number[] };
}
function bumpEvidence(map: Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>,
                     key: string, sample: string, opts: { trade?: number; debrief?: number; review?: number }) {
  const cur = map.get(key) ?? { count: 0, trades: new Set(), debriefs: new Set(), reviews: new Set(), sample };
  cur.count += 1;
  if (opts.trade)    cur.trades.add(opts.trade);
  if (opts.debrief)  cur.debriefs.add(opts.debrief);
  if (opts.review)   cur.reviews.add(opts.review);
  if (sample && !cur.sample) cur.sample = sample;
  map.set(key, cur);
}

router.post("/playbooks/:id/suggest", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const pb = (await db.select().from(tradingPlaybooksTable)
      .where(eq(tradingPlaybooksTable.id, id)).limit(1))[0];
    if (!pb) { fail(res, 404, "Playbook not found"); return; }

    // The suggestions are presented as "derived from your own trading data",
    // so the evidence must be this user's own rows — and never the fabricated
    // tester demo-seed journal rows (see lib/testerData/tags.ts).
    const notSeeded = or(
      isNull(tradeJournalTable.strategy),
      not(like(tradeJournalTable.strategy, `${TESTER_SEED_STRATEGY_PREFIX}%`)),
    );
    const [journals, debriefs, reviews, existing] = await Promise.all([
      db.select().from(tradeJournalTable)
        .where(and(eq(tradeJournalTable.userId, userId), notSeeded)).limit(500),
      db.select().from(postTradeDebriefsTable)
        .where(eq(postTradeDebriefsTable.userId, userId)).limit(500),
      db.select().from(weeklyReviewsTable)
        .where(eq(weeklyReviewsTable.userId, userId)).limit(50),
      db.select().from(playbookEntriesTable).where(eq(playbookEntriesTable.playbookId, id)),
    ]);
    const existingTitles = new Set(existing.map((e) => e.title.trim().toLowerCase()));

    const mistakes = new Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>();
    const strengths = new Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>();
    const bestSetups = new Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>();
    const avoidSetups = new Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>();

    // Journal entries: mistakeTag + winning strategy
    for (const j of journals) {
      if (j.mistakeTag) bumpEvidence(mistakes, j.mistakeTag.trim().toLowerCase(), j.mistakeTag,
        { trade: j.id });
      if (j.strategy && (j.pnl ?? 0) > 0) bumpEvidence(bestSetups, j.strategy.trim().toLowerCase(), j.strategy,
        { trade: j.id });
      if (j.strategy && (j.pnl ?? 0) < 0) bumpEvidence(avoidSetups, j.strategy.trim().toLowerCase(), j.strategy,
        { trade: j.id });
    }
    // Debriefs: biggestMistake / biggestStrength tallied
    for (const d of debriefs) {
      if (d.biggestMistake)  bumpEvidence(mistakes,  d.biggestMistake.trim().toLowerCase(),  d.biggestMistake,  { debrief: d.id });
      if (d.biggestStrength) bumpEvidence(strengths, d.biggestStrength.trim().toLowerCase(), d.biggestStrength, { debrief: d.id });
    }
    // Weekly reviews: feed `keyMistake` / `keyWin` if present
    for (const r of reviews) {
      const anyR = r as Record<string, unknown>;
      const km = typeof anyR["keyMistake"] === "string" ? anyR["keyMistake"] as string : null;
      const kw = typeof anyR["keyWin"]     === "string" ? anyR["keyWin"]     as string : null;
      if (km) bumpEvidence(mistakes,  km.trim().toLowerCase(), km, { review: r.id });
      if (kw) bumpEvidence(strengths, kw.trim().toLowerCase(), kw, { review: r.id });
    }

    const conf = (count: number) => Math.min(95, 50 + count * 8);
    const suggestions: Suggestion[] = [];
    const push = (entryType: Suggestion["entryType"], titlePrefix: string, descPrefix: string,
                  map: Map<string, { count: number; trades: Set<number>; debriefs: Set<number>; reviews: Set<number>; sample: string }>) => {
      for (const [key, ev] of map) {
        if (ev.count < 2) continue;       // need at least 2 occurrences
        const title = `${titlePrefix}: ${ev.sample}`;
        if (existingTitles.has(title.trim().toLowerCase())) continue;
        suggestions.push({
          entryType, title,
          description: `${descPrefix} (observed ${ev.count}× in your data: ${ev.trades.size} trade(s), ${ev.debriefs.size} debrief(s), ${ev.reviews.size} review(s)). Source key: "${key}".`,
          confidenceScore: conf(ev.count),
          source: "AI",
          evidence: { tradeIds: [...ev.trades], debriefIds: [...ev.debriefs], reviewIds: [...ev.reviews] },
        });
      }
    };
    push("MISTAKE_PATTERN", "Recurring mistake",  "A pattern your debriefs and journal flag as costly. Naming it is the first step to changing it.", mistakes);
    push("STRENGTH_PATTERN","Repeated strength",  "A behavior your own data credits with positive outcomes. Lean into this deliberately.",      strengths);
    push("BEST_SETUP",      "Best setup",         "A strategy that has been profitable in your history. Past performance is not a guarantee.",      bestSetups);
    push("AVOID_SETUP",     "Underperforming setup","A strategy that has lost on net in your data. Consider stricter filters or a paper-trading reset.", avoidSetups);

    suggestions.sort((a, b) => b.confidenceScore - a.confidenceScore);
    ok(res, { suggestions: suggestions.slice(0, 20), counts: { journals: journals.length, debriefs: debriefs.length, reviews: reviews.length, existing: existing.length } });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /playbooks/:id/suggest failed");
    fail(res, 500, "Failed to generate suggestions");
  }
});

export default router;
