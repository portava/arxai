// Ruby Scalp Signals — per-user HTTP surface.
//
// Three endpoints, ONE shared engine behind them (lib/scalp):
//   POST /me/scalp/focus  -> evaluate the selected symbol (Focus card)
//   POST /me/scalp/rank   -> Best/Safer/Fastest + ranked list (Broad scan)
//   POST /me/scalp/build  -> target/risk driven best scalp (Ruby Builder)
//
// SAFETY: requireUser on every route; all reads scoped to req.authUser.id.
// Nothing here places, modifies, or closes a trade — it only produces a
// normalized read. DEMO/LIVE only; the engine returns an honest AWAITING_DATA
// state instead of fabricating anything when live data is missing.

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  evaluateScalpForSymbol,
  rankScalpsForUniverse,
  buildScalp,
  SCALP_MODES,
} from "../lib/scalp/scalpService.js";
import {
  getScalpBaskets,
  getAddOnCheck,
} from "../lib/scalp/scalpManageService.js";
import {
  getScalpJournal,
  getScalpAfterActionReviews,
  getSymbolPersonalities,
} from "../lib/scalp/scalpJournalService.js";
import { normalizeSymbol } from "../lib/scannerSelected/symbolNormalize.js";
import { buildRubyMarketEdgeForUser } from "../lib/signalIntelligence/signalIntelligenceService.js";
import { getCachedOpportunityMap } from "../lib/signalIntelligence/opportunityMapReadCache.js";
import { explainMarketRead } from "@workspace/domain/signal-intelligence";
import type { UniverseId } from "../lib/marketScanner.js";
import { getAssistantDisplayName } from "../lib/assistant/assistantName.js";

function isAdminSession(req: import("express").Request): boolean {
  const role = (req.authUser as { role?: string } | undefined)?.role;
  return role === "ADMIN" || role === "OWNER";
}

/**
 * Strip the admin-only runOnTrace from a ScalpResult before sending it to a
 * normal user. The trace contains internal engine scoring details (overlap,
 * wick ratios, timing tokens) that are ADMIN/OWNER-only diagnostics.
 * Shallow-clones the result and its flame; never mutates in place.
 */
function redactFlameTrace<
  T extends { flame: { runOnTrace?: unknown } },
>(result: T): T {
  if (!result.flame.runOnTrace) return result;
  return { ...result, flame: { ...result.flame, runOnTrace: undefined } };
}

/**
 * Apply redactFlameTrace to every ScalpResult embedded in a rank or build
 * response object. Returns a new object; safe to call on non-admin reads.
 * Uses `unknown` cast internally so it works with concrete typed results.
 */
function redactAllFlameTraces(obj: object): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "flame" in v) {
      out[k] = redactFlameTrace(v as { flame: { runOnTrace?: unknown } });
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" && "flame" in item
          ? redactFlameTrace(item as { flame: { runOnTrace?: unknown } })
          : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

const router = Router();

const ModeEnum = z.enum(SCALP_MODES as unknown as [string, ...string[]]);
const GroupEnum = z.enum(["all", "forex", "metals", "indices", "crypto", "synthetic"]);
const PersonalityEnum = z.enum(["CONSERVATIVE", "BALANCED", "AGGRESSIVE", "OWNER_ADMIN"]);

const FocusBody = z.object({
  symbol: z.string().min(1).max(64),
  mode: ModeEnum.optional(),
  riskAmount: z.number().positive().max(1_000_000).optional().nullable(),
  targetProfitAmount: z.number().positive().max(1_000_000).optional().nullable(),
  riskPersonality: PersonalityEnum.optional().nullable(),
});

const RankBody = z.object({
  marketGroup: GroupEnum.optional(),
  mode: ModeEnum.optional(),
  limit: z.number().int().min(1).max(20).optional(),
  riskPersonality: PersonalityEnum.optional().nullable(),
});

const BuildBody = z.object({
  targetProfitAmount: z.number().positive().max(1_000_000).optional().nullable(),
  riskAmount: z.number().positive().max(1_000_000).optional().nullable(),
  mode: ModeEnum.optional(),
  marketGroup: GroupEnum.optional(),
  riskPersonality: PersonalityEnum.optional().nullable(),
});

function logError(req: import("express").Request, msg: string, e: unknown) {
  try {
    (req as { log?: { error: (...a: unknown[]) => void } }).log?.error(
      { err: (e as Error)?.message }, msg,
    );
  } catch { /* noop */ }
}

router.post("/me/scalp/focus", requireUser, async (req, res) => {
  const parsed = FocusBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Please pick a market to read." });
  }
  const symbol = normalizeSymbol(parsed.data.symbol);
  if (!symbol) {
    return res.status(400).json({ error: "invalid_symbol", message: "That market is not recognized." });
  }
  try {
    const result = await evaluateScalpForSymbol(req.authUser!.id, {
      symbol,
      mode: (parsed.data.mode ?? "ANY") as never,
      riskAmount: parsed.data.riskAmount ?? null,
      targetProfitAmount: parsed.data.targetProfitAmount ?? null,
      riskPersonality: parsed.data.riskPersonality ?? null,
    });
    return res.json(isAdminSession(req) ? result : redactFlameTrace(result));
  } catch (e) {
    logError(req, "scalp_focus_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not read this market just now.` });
  }
});

router.post("/me/scalp/rank", requireUser, async (req, res) => {
  const parsed = RankBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Could not rank scalps with those options." });
  }
  try {
    const result = await rankScalpsForUniverse(req.authUser!.id, {
      marketGroup: (parsed.data.marketGroup ?? "all") as never,
      mode: (parsed.data.mode ?? "ANY") as never,
      limit: parsed.data.limit ?? 5,
      riskPersonality: parsed.data.riskPersonality ?? null,
    });
    return res.json(isAdminSession(req) ? result : redactAllFlameTraces(result));
  } catch (e) {
    logError(req, "scalp_rank_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not rank scalps just now.` });
  }
});

router.post("/me/scalp/build", requireUser, async (req, res) => {
  const parsed = BuildBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Could not build a scalp with those options." });
  }
  try {
    const result = await buildScalp(req.authUser!.id, {
      targetProfitAmount: parsed.data.targetProfitAmount ?? null,
      riskAmount: parsed.data.riskAmount ?? null,
      mode: (parsed.data.mode ?? "ANY") as never,
      marketGroup: (parsed.data.marketGroup ?? "all") as never,
      riskPersonality: parsed.data.riskPersonality ?? null,
    });
    return res.json(isAdminSession(req) ? result : redactAllFlameTraces(result));
  } catch (e) {
    logError(req, "scalp_build_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not build a scalp just now.` });
  }
});

const BasketsQuery = z.object({
  riskPersonality: PersonalityEnum.optional().nullable(),
});

router.get("/me/scalp/baskets", requireUser, async (req, res) => {
  const parsed = BasketsQuery.safeParse(req.query);
  const riskPersonality = parsed.success ? (parsed.data.riskPersonality ?? null) : null;
  const admin = isAdminSession(req);
  try {
    const result = await getScalpBaskets(req.authUser!.id, {
      isAdmin: admin,
      riskPersonality: riskPersonality as never,
    });
    if (admin) return res.json(result);
    // Strip admin-only runOnTrace from every basket flame before sending to user.
    return res.json({
      ...result,
      baskets: result.baskets.map((b) =>
        b.flame?.runOnTrace
          ? { ...b, flame: { ...b.flame, runOnTrace: undefined } }
          : b,
      ),
    });
  } catch (e) {
    logError(req, "scalp_baskets_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not read your open baskets just now.` });
  }
});

const AddOnCheckBody = z.object({
  symbol: z.string().min(1).max(64),
  direction: z.enum(["BUY", "SELL"]),
  mode: ModeEnum.optional(),
  riskPersonality: PersonalityEnum.optional().nullable(),
});

router.post("/me/scalp/add-on-check", requireUser, async (req, res) => {
  const parsed = AddOnCheckBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Pick a market and direction to check add-ons." });
  }
  const symbol = normalizeSymbol(parsed.data.symbol);
  if (!symbol) {
    return res.status(400).json({ error: "invalid_symbol", message: "That market is not recognized." });
  }
  const admin = isAdminSession(req);
  try {
    const result = await getAddOnCheck(req.authUser!.id, {
      symbol,
      direction: parsed.data.direction as never,
      riskPersonality: parsed.data.riskPersonality ?? null,
    }, { isAdmin: admin });
    if (admin) return res.json(result);
    // Strip admin-only runOnTrace from the top-level flame and from the basket flame.
    const stripped = {
      ...result,
      flame: result.flame?.runOnTrace
        ? { ...result.flame, runOnTrace: undefined }
        : result.flame,
      basket: result.basket && result.basket.flame?.runOnTrace
        ? { ...result.basket, flame: { ...result.basket.flame, runOnTrace: undefined } }
        : result.basket,
    };
    return res.json(stripped);
  } catch (e) {
    logError(req, "scalp_add_on_check_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not check add-ons just now.` });
  }
});

const LimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/me/scalp/journal", requireUser, async (req, res) => {
  const parsed = LimitQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  try {
    const result = await getScalpJournal(req.authUser!.id, { limit });
    return res.json(result);
  } catch (e) {
    logError(req, "scalp_journal_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not read your journal just now.` });
  }
});

router.get("/me/scalp/reviews", requireUser, async (req, res) => {
  const parsed = LimitQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  try {
    const result = await getScalpAfterActionReviews(req.authUser!.id, { limit });
    return res.json(result);
  } catch (e) {
    logError(req, "scalp_reviews_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not read your reviews just now.` });
  }
});

router.get("/me/scalp/personality", requireUser, async (req, res) => {
  const parsed = LimitQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  try {
    const result = await getSymbolPersonalities(req.authUser!.id, { limit });
    return res.json(result);
  } catch (e) {
    logError(req, "scalp_personality_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "scalp_failed", message: `${assistant} could not read what she has learned just now.` });
  }
});

const MarketEdgeQuery = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z.string().min(1).max(8).optional(),
});

router.get("/me/market-edge", requireUser, async (req, res) => {
  const parsed = MarketEdgeQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Please pick a market to read." });
  }
  const symbol = normalizeSymbol(parsed.data.symbol);
  if (!symbol) {
    return res.status(400).json({ error: "invalid_symbol", message: "That market is not recognized." });
  }
  try {
    const signal = await buildRubyMarketEdgeForUser(req.authUser!.id, {
      symbol,
      timeframe: parsed.data.timeframe ?? undefined,
    });
    const explanation = explainMarketRead(signal);
    return res.json({ signal, explanation });
  } catch (e) {
    logError(req, "market_edge_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "market_edge_failed", message: `${assistant} could not read this market just now.` });
  }
});

const OpportunityMapQuery = z.object({
  marketGroup: GroupEnum.optional(),
  selectedSymbol: z.string().min(1).max(64).optional(),
  timeframe: z.string().min(1).max(8).optional(),
});

router.get("/me/opportunity-map", requireUser, async (req, res) => {
  const parsed = OpportunityMapQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", message: "Please pick a market group to scan." });
  }
  const universe = (parsed.data.marketGroup ?? "all") as UniverseId;
  const selectedSymbol = parsed.data.selectedSymbol
    ? normalizeSymbol(parsed.data.selectedSymbol) || null
    : null;
  try {
    const result = await getCachedOpportunityMap({
      universe,
      selectedSymbol,
      timeframe: parsed.data.timeframe ?? undefined,
    });
    return res.json(result);
  } catch (e) {
    logError(req, "opportunity_map_failed", e);
    const assistant = await getAssistantDisplayName(req.authUser!.id);
    return res.status(500).json({ error: "opportunity_map_failed", message: `${assistant} could not scan the markets just now.` });
  }
});

export default router;
