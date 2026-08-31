// Build RR — Onboarding routes. Read/write onboarding state ONLY.
// SAFETY: Acknowledgements never unlock live trading. ALL responses scrubbed.
//
// HONESTY: this envelope used to stamp appMode:"PAPER_ONLY" /
// liveTradingStatus:"DISABLED" / canPlaceLiveTrade:false on EVERY response as
// compile-time constants — on a build where live dispatch really exists and is
// operator/admin-gated. Those fabricated fields are gone. /onboarding/status
// now reports the caller's REAL account-level live status through the same
// chain the Help Center uses (readLiveReadiness), degrading to UNKNOWN with a
// reason when a read fails — never to a confident "DISABLED".

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  getStatus, startOnboarding, completeStep, skipStep, completeOnboarding,
  resetOnboarding, acknowledge, listEvents,
} from "../lib/onboarding/state.js";
import { ONBOARDING_STEPS, REQUIRED_ACK_KEYS, type AckKey } from "../lib/onboarding/steps.js";
import { readLiveReadiness } from "../lib/onboarding/whyBlocked.js";
import { scrub } from "../lib/security/redact.js";
import { requireUser } from "../lib/auth/middleware.js";

const router: IRouter = Router();

/** Authenticated caller id — `requireUser` gates every stateful route below. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}
const DISCLAIMER = "Build RR — Guided Onboarding + Smart Help. Education only. Onboarding never places trades, never changes your trading mode, never calls MT5, never modifies canPlaceTrades, never exposes secrets. Live trading is possible on this platform but default-deny and operator/admin-gated; acknowledgements never unlock it.";

function envelope(payload: Record<string, unknown>) {
  return scrub({
    system: "onboarding",
    disclaimer: DISCLAIMER,
    ...payload,
  }) as Record<string, unknown>;
}

router.get("/onboarding/status", requireUser, async (req, res) => {
  const status = await getStatus(uid(req));
  // The caller's REAL account-level live status ("ALLOWED"|"BLOCKED"|"UNKNOWN")
  // via the same chain whyBlocked/help use. A failed read is UNKNOWN with the
  // reason — never downgraded to a fabricated "DISABLED".
  const live = await readLiveReadiness(uid(req)).catch(() => null);
  res.json(envelope({
    status: status as unknown as Record<string, unknown>,
    liveTrading: live
      ? { status: live.status, reasons: live.plain }
      : { status: "UNKNOWN", reasons: ["Live-trading status could not be read. Treat it as unknown, not as safe."] },
  }));
});

// Static catalogue only — the same step list for every caller, no state read.
router.get("/onboarding/steps", requireUser, (_req, res) => {
  res.json(envelope({ steps: ONBOARDING_STEPS, totalSteps: ONBOARDING_STEPS.length, requiredAcks: REQUIRED_ACK_KEYS }));
});

router.post("/onboarding/start", requireUser, async (req, res) => {
  const row = await startOnboarding(uid(req));
  res.json(envelope({ result: { ok: true, status: row.status, currentStep: row.currentStep, onboardingId: row.onboardingId } }));
});

const StepBody = z.object({ stepId: z.string().min(1) });
router.post("/onboarding/complete-step", requireUser, async (req, res) => {
  const p = StepBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY" })); return; }
  try {
    const row = await completeStep(uid(req), p.data.stepId);
    res.json(envelope({ result: { ok: true, stepId: p.data.stepId, status: row.status, currentStep: row.currentStep, completedSteps: row.completedSteps } }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/skip-step", requireUser, async (req, res) => {
  const p = StepBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY" })); return; }
  try {
    const row = await skipStep(uid(req), p.data.stepId);
    res.json(envelope({ result: { ok: true, stepId: p.data.stepId, status: row.status, currentStep: row.currentStep, skippedSteps: row.skippedSteps } }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/complete", requireUser, async (req, res) => {
  const row = await completeOnboarding(uid(req));
  res.json(envelope({ result: { ok: true, status: row.status, walkthroughCompleted: row.walkthroughCompleted } }));
});

router.post("/onboarding/reset", requireUser, async (req, res) => {
  const row = await resetOnboarding(uid(req));
  res.json(envelope({ result: { ok: true, status: row.status } }));
});

const AckBody = z.object({ key: z.enum(REQUIRED_ACK_KEYS as unknown as [AckKey, ...AckKey[]]) });
router.post("/onboarding/acknowledge", requireUser, async (req, res) => {
  const p = AckBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_ACK_KEY", allowed: REQUIRED_ACK_KEYS })); return; }
  try {
    const row = await acknowledge(uid(req), p.data.key);
    res.json(envelope({
      result: {
        ok: true, key: p.data.key,
        paperOnlyAcknowledged: row.paperOnlyAcknowledged,
        liveDisabledAcknowledged: row.liveDisabledAcknowledged,
        riskDisclaimerAcknowledged: row.riskDisclaimerAcknowledged,
        replaySimulationAcknowledged: row.replaySimulationAcknowledged,
        brokerReadonlyAcknowledged: row.brokerReadonlyAcknowledged,
        note: "Acknowledgement recorded. Acknowledgements never change your trading mode — live trading stays operator/admin-gated.",
      },
    }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/demo", requireUser, async (_req, res) => {
  res.json(envelope({
    demo: {
      flow: ["start", "ack-live-disabled", "safety-header", "readiness-check", "preflight", "complete"],
      requiredAcks: REQUIRED_ACK_KEYS,
      note: "Demo only — does not modify state and does not place any trade.",
    },
  }));
});

router.get("/onboarding/events", requireUser, async (req, res) => {
  const events = await listEvents(uid(req), 50);
  res.json(envelope({ events: events as unknown as Record<string, unknown>[] }));
});

export default router;
