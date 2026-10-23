// Build RR — Onboarding routes. Read/write onboarding state ONLY.
// SAFETY: Acknowledgements never unlock live trading. ALL responses scrubbed.

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  getStatus, startOnboarding, completeStep, skipStep, completeOnboarding,
  resetOnboarding, acknowledge, listEvents,
} from "../lib/onboarding/state.js";
import { ONBOARDING_STEPS, REQUIRED_ACK_KEYS, type AckKey } from "../lib/onboarding/steps.js";
import { scrub } from "../lib/security/redact.js";

const router: IRouter = Router();
const DISCLAIMER = "Build RR — Guided Onboarding + Smart Help. Education only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

function envelope(payload: Record<string, unknown>) {
  return scrub({
    system: "onboarding",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false,
    disclaimer: DISCLAIMER,
    ...payload,
  }) as Record<string, unknown>;
}

router.get("/onboarding/status", async (_req, res) => {
  const status = await getStatus();
  res.json(envelope({ status: status as unknown as Record<string, unknown> }));
});

router.get("/onboarding/steps", (_req, res) => {
  res.json(envelope({ steps: ONBOARDING_STEPS, totalSteps: ONBOARDING_STEPS.length, requiredAcks: REQUIRED_ACK_KEYS }));
});

router.post("/onboarding/start", async (_req, res) => {
  const row = await startOnboarding();
  res.json(envelope({ result: { ok: true, status: row.status, currentStep: row.currentStep, onboardingId: row.onboardingId } }));
});

const StepBody = z.object({ stepId: z.string().min(1) });
router.post("/onboarding/complete-step", async (req, res) => {
  const p = StepBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY" })); return; }
  try {
    const row = await completeStep(p.data.stepId);
    res.json(envelope({ result: { ok: true, stepId: p.data.stepId, status: row.status, currentStep: row.currentStep, completedSteps: row.completedSteps } }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/skip-step", async (req, res) => {
  const p = StepBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_BODY" })); return; }
  try {
    const row = await skipStep(p.data.stepId);
    res.json(envelope({ result: { ok: true, stepId: p.data.stepId, status: row.status, currentStep: row.currentStep, skippedSteps: row.skippedSteps } }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/complete", async (_req, res) => {
  const row = await completeOnboarding();
  res.json(envelope({ result: { ok: true, status: row.status, walkthroughCompleted: row.walkthroughCompleted } }));
});

router.post("/onboarding/reset", async (_req, res) => {
  const row = await resetOnboarding();
  res.json(envelope({ result: { ok: true, status: row.status } }));
});

const AckBody = z.object({ key: z.enum(REQUIRED_ACK_KEYS as unknown as [AckKey, ...AckKey[]]) });
router.post("/onboarding/acknowledge", async (req, res) => {
  const p = AckBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ error: "INVALID_ACK_KEY", allowed: REQUIRED_ACK_KEYS })); return; }
  try {
    const row = await acknowledge(p.data.key);
    res.json(envelope({
      result: {
        ok: true, key: p.data.key,
        paperOnlyAcknowledged: row.paperOnlyAcknowledged,
        liveDisabledAcknowledged: row.liveDisabledAcknowledged,
        riskDisclaimerAcknowledged: row.riskDisclaimerAcknowledged,
        replaySimulationAcknowledged: row.replaySimulationAcknowledged,
        brokerReadonlyAcknowledged: row.brokerReadonlyAcknowledged,
        liveTradingStatus: "DISABLED",
        canPlaceLiveTrade: false,
        note: "Acknowledgement recorded. Live trading remains DISABLED.",
      },
    }));
  } catch (e) {
    res.status(400).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/onboarding/demo", async (_req, res) => {
  res.json(envelope({
    demo: {
      flow: ["start", "ack-live-disabled", "safety-header", "readiness-check", "preflight", "complete"],
      requiredAcks: REQUIRED_ACK_KEYS,
      note: "Demo only — does not modify state and does not place any trade.",
    },
  }));
});

router.get("/onboarding/events", async (_req, res) => {
  const events = await listEvents(50);
  res.json(envelope({ events: events as unknown as Record<string, unknown>[] }));
});

export default router;
