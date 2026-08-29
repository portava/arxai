// Smart Help routes. Read-only educational content + explainers.
//
// RANK 4 (critical) — the response envelope was a hard-coded lie.
//
//   function envelope(payload) {
//     return scrub({ system: "help",
//       appMode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
//       mode: "PAPER_ONLY", canPlaceLiveTrade: false, ... });
//   }
//
// Every help response — topic list, single topic, per-page topics, the
// explainer, and the "why am I blocked?" drawer — was stamped with those four
// constants. On a build where lib/live/liveCommandPipeline.ts dispatches real
// broker orders, the product's own help system told every user, with authority,
// that live trading was structurally impossible.
//
// The envelope now reports the caller's REAL mode, composed from the same
// read-only helpers /api/me/account-mode uses:
//   * computeAccountShell(userId)               — meAccountShell.ts
//   * getMyArming(userId)                       — lib/live/liveArming.ts
//   * resolveLiveBrokerExecutionEnabledAsync()  — lib/live/phaseBConfig.ts
// A read that fails degrades to `appMode: null` with a machine-readable
// `appModeUnavailableReason` — never back to a reassuring "PAPER_ONLY".
//
// Every route is `requireUser` now. It has to be: the answer to "can I trade
// live?" is per-user, and an anonymous caller has no mode to report.
//
// SAFETY: still strictly read-only. Nothing here places a trade, changes an
// arming record, or touches a gate. Responses remain scrubbed.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { HELP_TOPICS, findTopic, topicsForRoute } from "../lib/onboarding/help.js";
import { explainBlockedAction, explainTopic, type BlockedAction } from "../lib/onboarding/whyBlocked.js";
import { scrub } from "../lib/security/redact.js";
import { requireUser } from "../lib/auth/middleware.js";
import { computeAccountShell } from "./meAccountShell.js";
import { getMyArming } from "../lib/live/liveArming.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "../lib/live/phaseBConfig.js";

const router: IRouter = Router();
const DISCLAIMER =
  "Smart Help — education only. Nothing on this surface places, modifies or closes a trade, and nothing here can arm live execution or change a safety gate.";

export interface HelpModeEnvelope {
  /** The caller's real trading mode, or null when it could not be read. */
  appMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE" | null;
  appModeUnavailableReason: string | null;
  /** True only when this user could actually get an order to a live broker. */
  liveExecutionPossible: boolean | null;
  /** Whether THIS user has armed their own account for live. */
  liveArmed: boolean | null;
}

/**
 * The caller's real mode. Never guesses: every field is null with a reason when
 * the underlying read fails, because "I could not determine your mode" and
 * "you cannot trade live" are different answers and only one of them is safe to
 * fabricate — neither.
 */
async function resolveMode(req: Request): Promise<HelpModeEnvelope> {
  const userId = req.authUser?.id;
  if (typeof userId !== "number") {
    return { appMode: null, appModeUnavailableReason: "NO_AUTHENTICATED_USER", liveExecutionPossible: null, liveArmed: null };
  }
  try {
    const [shell, arming, brokerExecutionEnabled] = await Promise.all([
      computeAccountShell(userId),
      getMyArming(userId).catch(() => null),
      resolveLiveBrokerExecutionEnabledAsync().catch(() => null),
    ]);
    const liveArmed = arming === null ? null : arming?.isArmed === true;
    const liveExecutionPossible =
      brokerExecutionEnabled === null || liveArmed === null
        ? null
        : brokerExecutionEnabled && liveArmed && shell.tradingMode === "LIVE";
    return {
      appMode: shell.tradingMode,
      appModeUnavailableReason: null,
      liveExecutionPossible,
      liveArmed,
    };
  } catch {
    return {
      appMode: null,
      appModeUnavailableReason: "MODE_READ_FAILED",
      liveExecutionPossible: null,
      liveArmed: null,
    };
  }
}

async function envelope(req: Request, payload: Record<string, unknown>) {
  const mode = await resolveMode(req);
  return scrub({
    system: "help",
    ...mode,
    disclaimer: DISCLAIMER,
    ...payload,
  }) as Record<string, unknown>;
}

router.get("/help/topics", requireUser, async (req, res) => {
  const categories = [...new Set(HELP_TOPICS.map(t => t.category))];
  res.json(await envelope(req, { topics: HELP_TOPICS, categories, total: HELP_TOPICS.length }));
});

router.get("/help/topic/:key", requireUser, async (req, res) => {
  const t = findTopic(String(req.params.key));
  if (!t) { res.status(404).json(await envelope(req, { error: "TOPIC_NOT_FOUND" })); return; }
  res.json(await envelope(req, { topic: t }));
});

router.get("/help/page", requireUser, async (req, res) => {
  const route = String(req.query.route ?? "");
  if (!route) { res.status(400).json(await envelope(req, { error: "MISSING_ROUTE" })); return; }
  const topics = topicsForRoute(route);
  res.json(await envelope(req, { route, topics, total: topics.length }));
});

const ExplainBody = z.object({ topic: z.string().min(1).max(200) });
router.post("/help/explain", requireUser, async (req, res) => {
  const p = ExplainBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(await envelope(req, { error: "INVALID_BODY" })); return; }
  const result = await explainTopic(p.data.topic, req.authUser!.id);
  res.json(await envelope(req, { result: result as unknown as Record<string, unknown> }));
});

// The wire names are unchanged (WhyBlockedDrawer already renders the two
// PAPER_* ones as DEMO_* labels); renaming them here would break that client
// for no gain. What changed is the ANSWER these actions get — see whyBlocked.ts.
const BLOCKED_ACTIONS = ["START_PAPER_SESSION", "START_AUTOPILOT", "OPEN_PAPER_TRADE", "ENABLE_LIVE_TRADING", "USE_BROKER_EXECUTION"] as const;
const WhyBody = z.object({ blockedAction: z.enum(BLOCKED_ACTIONS as unknown as [BlockedAction, ...BlockedAction[]]) });
router.post("/help/why-blocked", requireUser, async (req, res) => {
  const p = WhyBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(await envelope(req, { error: "INVALID_BLOCKED_ACTION", allowed: BLOCKED_ACTIONS })); return; }
  const explanation = await explainBlockedAction(p.data.blockedAction, req.authUser!.id);
  res.json(await envelope(req, { explanation: explanation as unknown as Record<string, unknown> }));
});

export default router;
