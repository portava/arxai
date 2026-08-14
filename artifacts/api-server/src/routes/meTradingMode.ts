// Per-user trading-mode + risk-disclosure endpoints.
//
// SAFETY: read-only for status; the accept-disclosure endpoint inserts a
// new row into the append-only live_risk_disclosure_acceptances table.
// Disclosure acceptance alone does NOT unlock live trading — admin
// approval, a verified live broker account, and global LIVE mode are still
// required by the envelope.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { liveRiskDisclosureAcceptancesTable, userTradingPermissionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { tradingModeGate } from "@workspace/db/repositories";
import { z } from "zod/v4";
import { getEnvelope } from "../lib/adminTrading/safetyEnvelope.js";

const router: IRouter = Router();

const DISCLOSURE_VERSION = "v1.2026-05-16" as const;
const DISCLOSURE_TEXT =
  "I understand that live trading uses my real money, that past results do not guarantee future returns, " +
  "that ARX AI provides decision support only, that I am solely responsible for every order placed under my " +
  "account, and that I can disable live trading at any time from this app or by contacting the platform admin.";

router.get("/me/trading/mode", async (req, res) => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const envelope = await getEnvelope(userId);
  const perm = (await db.select({
    tradingMode: userTradingPermissionsTable.tradingMode,
    previousTradingMode: userTradingPermissionsTable.previousTradingMode,
    tradingModeUpdatedAt: userTradingPermissionsTable.tradingModeUpdatedAt,
    tradingModeChangeReason: userTradingPermissionsTable.tradingModeChangeReason,
  }).from(userTradingPermissionsTable)
    .where(eq(userTradingPermissionsTable.userId, userId)).limit(1))[0] ?? null;
  const mode = String(perm?.tradingMode ?? "DISABLED").toUpperCase();
  res.json({
    ok: true,
    envelope,
    perUserTradingMode: {
      mode,
      label: tradingModeGate.tradingModeLabel(mode),
      previousMode: perm?.previousTradingMode ?? null,
      updatedAt: perm?.tradingModeUpdatedAt
        ? new Date(perm.tradingModeUpdatedAt).toISOString() : null,
      changeReason: perm?.tradingModeChangeReason ?? null,
    },
    disclosure: { version: DISCLOSURE_VERSION, text: DISCLOSURE_TEXT },
  });
});

const acceptSchema = z.object({
  version: z.string().min(1),
  acceptedText: z.string().min(20),
});

router.post("/me/trading/accept-risk-disclosure", async (req, res) => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY" }); return; }
  const ipAddress = req.ip ?? null;
  const userAgent = String(req.header("user-agent") ?? "").slice(0, 500);

  await db.insert(liveRiskDisclosureAcceptancesTable).values({
    userId,
    disclosureVersion: parsed.data.version,
    acceptedText: parsed.data.acceptedText.slice(0, 4000),
    ipAddress,
    userAgent,
  });
  res.json({ ok: true, version: parsed.data.version, acceptedAt: new Date().toISOString() });
});

export default router;
