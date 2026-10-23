// Versioned feature announcements ("What's New" popups).
// SAFETY: Acknowledgements are educational only. They never unlock live trading,
// never modify canPlaceTrades, and never write to live tables.

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  listAnnouncements,
  acknowledgeAnnouncement,
  dismissAnnouncement,
  remindLater,
  resetAcknowledgements,
} from "../lib/featureAnnouncements/store.js";

const router: IRouter = Router();

const DISCLAIMER = "Feature announcement system. Educational only. Never enables live trading, never modifies canPlaceTrades, never places orders.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "feature-announcements",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    canPlaceLiveTrade: false,
    disclaimer: DISCLAIMER,
    ...payload,
  };
}

function userKeyFromReq(req: { header?: (n: string) => string | undefined }): string {
  return req.header?.("x-user-key") || "default";
}

router.get("/feature-announcements", async (req, res) => {
  try {
    const items = await listAnnouncements(userKeyFromReq(req));
    res.json(envelope({ announcements: items, count: items.length, unacknowledgedCount: items.filter(i => i.shouldShow).length }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

const KeyParam = z.object({ key: z.string().min(1) });
const VersionBody = z.object({ version: z.string().min(1).default("1") }).partial();

router.post("/feature-announcements/:key/acknowledge", async (req, res) => {
  const k = KeyParam.safeParse(req.params);
  const b = VersionBody.safeParse(req.body ?? {});
  if (!k.success) { res.status(400).json(envelope({ error: "INVALID_KEY" })); return; }
  const version = (b.success && b.data.version) || "1";
  try {
    await acknowledgeAnnouncement(k.data.key, version, userKeyFromReq(req));
    res.json(envelope({ result: { ok: true, action: "acknowledged", featureKey: k.data.key, version, note: "Acknowledgement recorded. Live trading remains DISABLED." } }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/feature-announcements/:key/dismiss", async (req, res) => {
  const k = KeyParam.safeParse(req.params);
  const b = VersionBody.safeParse(req.body ?? {});
  if (!k.success) { res.status(400).json(envelope({ error: "INVALID_KEY" })); return; }
  const version = (b.success && b.data.version) || "1";
  try {
    await dismissAnnouncement(k.data.key, version, userKeyFromReq(req));
    res.json(envelope({ result: { ok: true, action: "dismissed", featureKey: k.data.key, version } }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

const RemindBody = z.object({ version: z.string().min(1).default("1"), hours: z.number().min(1).max(720).default(24) }).partial();
router.post("/feature-announcements/:key/remind-later", async (req, res) => {
  const k = KeyParam.safeParse(req.params);
  const b = RemindBody.safeParse(req.body ?? {});
  if (!k.success) { res.status(400).json(envelope({ error: "INVALID_KEY" })); return; }
  const version = (b.success && b.data.version) || "1";
  const hours = (b.success && b.data.hours) || 24;
  try {
    const until = await remindLater(k.data.key, version, hours, userKeyFromReq(req));
    res.json(envelope({ result: { ok: true, action: "remind-later", featureKey: k.data.key, version, hours, until: until.toISOString() } }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

router.post("/feature-announcements/reset", async (req, res) => {
  try {
    const n = await resetAcknowledgements(userKeyFromReq(req));
    res.json(envelope({ result: { ok: true, deletedAcknowledgements: n } }));
  } catch (e) {
    res.status(500).json(envelope({ error: String((e as Error).message) }));
  }
});

export default router;
