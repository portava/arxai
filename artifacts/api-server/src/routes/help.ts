// Build RR — Smart Help routes. Read-only educational content + explainers.
// SAFETY: Never recommends live trading. Never exposes secrets. ALL responses scrubbed.

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { HELP_TOPICS, findTopic, topicsForRoute } from "../lib/onboarding/help.js";
import { explainBlockedAction, explainTopic, type BlockedAction } from "../lib/onboarding/whyBlocked.js";
import { scrub } from "../lib/security/redact.js";
import { requireUser } from "../lib/auth/middleware.js";

const router: IRouter = Router();
const DISCLAIMER = "Build RR — Smart Help. Education only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

function envelope(payload: Record<string, unknown>) {
  return scrub({
    system: "help",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false,
    disclaimer: DISCLAIMER,
    ...payload,
  }) as Record<string, unknown>;
}

router.get("/help/topics", (_req, res) => {
  const categories = [...new Set(HELP_TOPICS.map(t => t.category))];
  res.json(envelope({ topics: HELP_TOPICS, categories, total: HELP_TOPICS.length }));
});

router.get("/help/topic/:key", (req, res) => {
  const t = findTopic(req.params.key);
  if (!t) { res.status(404).json(envelope({ error: "TOPIC_NOT_FOUND" })); return; }
  res.json(envelope({ topic: t }));
});

router.get("/help/page", (req, res) => {
  const route = String(req.query.route ?? "");
  if (!route) { res.status(400).json(envelope({ error: "MISSING_ROUTE" })); return; }
  const topics = topicsForRoute(route);
  res.json(envelope({ route, topics, total: topics.length }));
});

const ExplainBody = z.object({ topic: z.string().min(1).max(200) });
router.post("/help/explain", requireUser, async (req, res) => {
  const p = ExplainBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY" })); return; }
  const result = await explainTopic(p.data.topic, req.authUser!.id);
  res.json(envelope({ result: result as unknown as Record<string, unknown> }));
});

const BLOCKED_ACTIONS = ["START_PAPER_SESSION", "START_AUTOPILOT", "OPEN_PAPER_TRADE", "ENABLE_LIVE_TRADING", "USE_BROKER_EXECUTION"] as const;
const WhyBody = z.object({ blockedAction: z.enum(BLOCKED_ACTIONS as unknown as [BlockedAction, ...BlockedAction[]]) });
router.post("/help/why-blocked", requireUser, async (req, res) => {
  const p = WhyBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BLOCKED_ACTION", allowed: BLOCKED_ACTIONS })); return; }
  // The explanation reads the caller's own session + governor state.
  const explanation = await explainBlockedAction(p.data.blockedAction, req.authUser!.id);
  res.json(envelope({ explanation: explanation as unknown as Record<string, unknown> }));
});

router.post("/help/demo", (_req, res) => {
  res.json(envelope({
    demo: {
      sampleTopics: HELP_TOPICS.slice(0, 4).map(t => t.help_key),
      sampleBlockedActions: BLOCKED_ACTIONS,
      note: "Demo only — does not modify state and does not place any trade.",
    },
  }));
});

export default router;
