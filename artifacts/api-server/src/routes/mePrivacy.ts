// Privacy + Global Learning routes
//
// Routes:
//   GET  /api/me/privacy                — get current privacy settings
//   POST /api/me/privacy/contribute     — opt in/out of global learning
//   POST /api/me/privacy/insights       — toggle receiving global insights
//   GET  /api/me/global-insights/:sym   — get anonymized platform insights
//   POST /api/admin/global-learning/run — manually trigger aggregation (admin)
//
// SAFETY: requireUser on all /me/* routes. requireAdmin on /admin/* routes.
// No user data ever written to global tables.

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  getPrivacySettings,
  setContributionOptIn,
  setReceiveInsights,
  getGlobalInsightSummary,
  runGlobalAggregation,
} from "../lib/globalLearning.js";
import { getAssistantDisplayName } from "../lib/assistant/assistantName.js";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  const role = req.authUser?.role;
  if (role !== "ADMIN" && role !== "OWNER") {
    return res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
  }
  next();
}

// ── GET /api/me/privacy ───────────────────────────────────────────────────────
router.get("/me/privacy", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const settings = await getPrivacySettings(userId);
    const assistant = await getAssistantDisplayName(userId);
    return res.json({
      ok: true,
      contributeToGlobalLearning: settings.contributeToGlobalLearning,
      receiveGlobalInsights:      settings.receiveGlobalInsights,
      contributionOptedInAt:      settings.contributionOptedInAt ?? null,
      contributionOptedOutAt:     settings.contributionOptedOutAt ?? null,
      explanation: {
        contribute: `When enabled, your anonymized trade outcomes (win/loss rates only — no amounts, no account data) help improve platform-wide scanner scoring and ${assistant} insights for all users.`,
        insights:   `When enabled, ${assistant} can share anonymized platform-wide patterns to help you understand how similar setups have performed across the platform.`,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PRIVACY_FETCH_FAILED" });
  }
});

// ── POST /api/me/privacy/contribute ──────────────────────────────────────────
const ContributeBody = z.object({ optIn: z.boolean() });

router.post("/me/privacy/contribute", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = ContributeBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  try {
    await setContributionOptIn(userId, parsed.data.optIn);
    return res.json({
      ok: true,
      contributeToGlobalLearning: parsed.data.optIn,
      message: parsed.data.optIn
        ? "Thank you. Your anonymized trade outcomes will contribute to platform-wide learning. No personal data, amounts, or account details are shared."
        : "You have opted out. Your data will no longer contribute to global learning.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PRIVACY_UPDATE_FAILED" });
  }
});

// ── POST /api/me/privacy/insights ─────────────────────────────────────────────
const InsightsBody = z.object({ receive: z.boolean() });

router.post("/me/privacy/insights", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = InsightsBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  try {
    await setReceiveInsights(userId, parsed.data.receive);
    return res.json({ ok: true, receiveGlobalInsights: parsed.data.receive });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PRIVACY_UPDATE_FAILED" });
  }
});

// ── GET /api/me/global-insights/:symbol ──────────────────────────────────────
router.get("/me/global-insights/:symbol", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const symbol  = String(req.params.symbol ?? "").toUpperCase();
  const session = String(req.query.session ?? "any").toLowerCase();

  if (!symbol) return res.status(400).json({ ok: false, error: "SYMBOL_REQUIRED" });

  try {
    // Check user wants insights
    const privacy = await getPrivacySettings(userId);
    if (!privacy.receiveGlobalInsights) {
      return res.json({ ok: true, available: false, reason: "insights_disabled_by_user" });
    }

    const { buy, sell } = await getGlobalInsightSummary(symbol, session);

    if (!buy && !sell) {
      return res.json({
        ok: true,
        available: false,
        reason: "insufficient_platform_data",
        message: "Not enough platform data yet for this symbol/session combination.",
      });
    }

    return res.json({
      ok: true,
      available: true,
      symbol,
      session,
      buy: buy ? {
        sampleCount:    buy.sampleCount,
        contributorCount: buy.contributorCount,
        winRate:        buy.winRate,
        avgRMultiple:   buy.avgRMultiple,
        confidenceAdj:  buy.confidenceAdjustment,
      } : null,
      sell: sell ? {
        sampleCount:    sell.sampleCount,
        contributorCount: sell.contributorCount,
        winRate:        sell.winRate,
        avgRMultiple:   sell.avgRMultiple,
        confidenceAdj:  sell.confidenceAdjustment,
      } : null,
      disclaimer: "Based on anonymized data from opted-in platform users. Past performance does not guarantee future results.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "INSIGHTS_FETCH_FAILED" });
  }
});

// ── POST /api/admin/global-learning/run ──────────────────────────────────────
router.post("/admin/global-learning/run", requireAdmin, async (req, res) => {
  try {
    const result = await runGlobalAggregation();
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "AGGREGATION_FAILED", message: (e as Error).message });
  }
});

export default router;
