// Build RR — Smart Help routes. Read-only educational content + explainers.
// SAFETY: Never recommends live trading. Never exposes secrets. ALL responses scrubbed.
//
// The envelope's appMode / liveTradingStatus / mode / canPlaceLiveTrade
// constants describe this help service (it can never place a trade or enable
// live trading); they are not whether live trading is on. Each response says
// so (liveTradingStatusScope) and carries the platform live-execution switch
// as read for the response (livePosture). A why-blocked explanation also
// carries the caller's own account posture (explanation.livePosture).

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { HELP_TOPICS, findTopic, topicsForRoute } from "../lib/onboarding/help.js";
import { explainBlockedAction, explainTopic, type BlockedAction } from "../lib/onboarding/whyBlocked.js";
import { scrub } from "../lib/security/redact.js";
import { readPlatformLivePosture } from "../lib/systemHealth/platformLivePosture.js";

const router: IRouter = Router();
const DISCLAIMER = "Build RR — Smart Help. Education only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

const LIVE_STATUS_SCOPE =
  "appMode, liveTradingStatus, mode and canPlaceLiveTrade describe this help service, which can never place a trade or enable live trading. They are not whether live trading is on: livePosture is the platform's live-execution switch, and each account's status is on its Trading Permission card.";

async function envelope(payload: Record<string, unknown>) {
  return scrub({
    system: "help",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false,
    liveTradingStatusScope: LIVE_STATUS_SCOPE,
    livePosture: await readPlatformLivePosture(),
    disclaimer: DISCLAIMER,
    ...payload,
  }) as Record<string, unknown>;
}

router.get("/help/topics", async (_req, res) => {
  const categories = [...new Set(HELP_TOPICS.map(t => t.category))];
  res.json(await envelope({ topics: HELP_TOPICS, categories, total: HELP_TOPICS.length }));
});

router.get("/help/topic/:key", async (req, res) => {
  const t = findTopic(req.params.key);
  if (!t) { res.status(404).json(await envelope({ error: "TOPIC_NOT_FOUND" })); return; }
  res.json(await envelope({ topic: t }));
});

router.get("/help/page", async (req, res) => {
  const route = String(req.query.route ?? "");
  if (!route) { res.status(400).json(await envelope({ error: "MISSING_ROUTE" })); return; }
  const topics = topicsForRoute(route);
  res.json(await envelope({ route, topics, total: topics.length }));
});

const ExplainBody = z.object({ topic: z.string().min(1).max(200) });
router.post("/help/explain", async (req, res) => {
  const p = ExplainBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(await envelope({ error: "INVALID_BODY" })); return; }
  const result = await explainTopic(p.data.topic, req.authUser!.id);
  res.json(await envelope({ result: result as unknown as Record<string, unknown> }));
});

const BLOCKED_ACTIONS = ["START_PAPER_SESSION", "START_AUTOPILOT", "OPEN_PAPER_TRADE", "ENABLE_LIVE_TRADING", "USE_BROKER_EXECUTION"] as const;
const WhyBody = z.object({ blockedAction: z.enum(BLOCKED_ACTIONS as unknown as [BlockedAction, ...BlockedAction[]]) });
router.post("/help/why-blocked", async (req, res) => {
  const p = WhyBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(await envelope({ error: "INVALID_BLOCKED_ACTION", allowed: BLOCKED_ACTIONS })); return; }
  const explanation = await explainBlockedAction(p.data.blockedAction, req.authUser!.id);
  res.json(await envelope({ explanation: explanation as unknown as Record<string, unknown> }));
});

router.post("/help/demo", async (_req, res) => {
  res.json(await envelope({
    demo: {
      sampleTopics: HELP_TOPICS.slice(0, 4).map(t => t.help_key),
      sampleBlockedActions: BLOCKED_ACTIONS,
      note: "Demo only — does not modify state and does not place any trade.",
    },
  }));
});

export default router;
