// TradingView Webhook Routes
//
// Public (token-authenticated):
//   POST /api/webhooks/tradingview        — receive alert from TradingView
//
// User-authenticated:
//   GET  /api/me/tradingview/status       — connector status + setup guide
//   GET  /api/me/tradingview/tokens       — list webhook tokens
//   POST /api/me/tradingview/tokens       — generate new token
//   DELETE /api/me/tradingview/tokens/:id — revoke token
//   GET  /api/me/tradingview/alerts       — list received alerts
//
// SAFETY: POST /api/webhooks/tradingview is public but token-authenticated.
// No trade execution. Alerts are review-only.

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  receiveAlert,
  generateWebhookToken,
  getUserWebhookTokens,
  revokeWebhookToken,
  listUserAlerts,
  getAlertStatus,
} from "../lib/tradingviewWebhook.js";

const router = Router();

// ── POST /api/webhooks/tradingview ────────────────────────────────────────────
// Public endpoint — TradingView posts alerts here.
// Auth is via ?token= query param (per-user secret).
// Returns 200 quickly — scoring happens async.

router.post("/webhooks/tradingview", async (req, res) => {
  const token = String(req.query.token ?? "").trim();

  if (!token) {
    // Return 200 so TradingView doesn't retry — log the miss
    req.log?.warn("tradingview_webhook_no_token");
    return res.status(200).json({ ok: false, error: "NO_TOKEN" });
  }

  try {
    const result = await receiveAlert(token, req.body ?? {});
    if (!result.ok) {
      // Return 200 so TradingView doesn't retry — invalid token just discards
      return res.status(200).json({ ok: false, error: result.error });
    }
    return res.status(200).json({ ok: true, alertId: result.alertId, received: true });
  } catch (e) {
    req.log?.error({ err: e }, "tradingview_webhook_failed");
    return res.status(200).json({ ok: false, error: "INTERNAL" });
  }
});

// ── GET /api/me/tradingview/status ────────────────────────────────────────────
router.get("/me/tradingview/status", requireUser, async (req, res) => {
  try {
    const status = await getAlertStatus();
    const tokens = await getUserWebhookTokens(req.authUser!.id);
    const activeTokens = tokens.filter((t) => t.isActive);

    return res.json({
      ok: true,
      ...status,
      hasActiveToken: activeTokens.length > 0,
      tokenCount:     activeTokens.length,
      setupGuide: {
        step1: "Generate a webhook token below.",
        step2: "In TradingView, open an alert on any chart.",
        step3: "Set the Webhook URL to your token URL.",
        step4: `Payload format (JSON): {"ticker": "{{ticker}}", "action": "{{strategy.order.action}}", "price": {{close}}, "strategy": "MyStrategy"}`,
        step5: "ARX will receive the alert, score it, and notify you. No trades are placed automatically.",
        note:  "TradingView alerts are scored against your personal history and the ARX scanner. Always review before acting.",
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "STATUS_FAILED" });
  }
});

// ── GET /api/me/tradingview/tokens ────────────────────────────────────────────
router.get("/me/tradingview/tokens", requireUser, async (req, res) => {
  try {
    const tokens = await getUserWebhookTokens(req.authUser!.id);
    return res.json({ ok: true, tokens });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "TOKENS_FETCH_FAILED" });
  }
});

// ── POST /api/me/tradingview/tokens ──────────────────────────────────────────
const GenerateBody = z.object({
  label: z.string().max(50).optional(),
});

router.post("/me/tradingview/tokens", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = GenerateBody.safeParse(req.body ?? {});
  const label  = parsed.success ? (parsed.data.label ?? "TradingView") : "TradingView";

  try {
    const result = await generateWebhookToken(userId, label);
    return res.json({
      ok: true,
      token:      result.token,  // shown ONCE — user must save it
      masked:     result.masked,
      webhookUrl: result.webhookUrl,
      warning:    "Save this token now. It will not be shown again. If lost, generate a new one.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "TOKEN_GENERATE_FAILED" });
  }
});

// ── DELETE /api/me/tradingview/tokens/:id ────────────────────────────────────
router.delete("/me/tradingview/tokens/:id", requireUser, async (req, res) => {
  const userId  = req.authUser!.id;
  const tokenId = parseInt(String(req.params.id ?? ""), 10);

  if (!Number.isFinite(tokenId)) {
    return res.status(400).json({ ok: false, error: "INVALID_ID" });
  }

  try {
    await revokeWebhookToken(userId, tokenId);
    return res.json({ ok: true, revoked: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "REVOKE_FAILED" });
  }
});

// ── GET /api/me/tradingview/alerts ────────────────────────────────────────────
router.get("/me/tradingview/alerts", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);

  try {
    const alerts = await listUserAlerts(userId, limit);
    return res.json({
      ok: true,
      alerts: alerts.map((a) => ({
        alertId:      a.alertId,
        symbol:       a.symbol,
        action:       a.action,
        price:        a.price,
        strategyName: a.strategyName,
        timeframe:    a.timeframe,
        message:      a.message,
        scored:       a.scored,
        overallScore: a.overallScore,
        scoreLabel:   a.scoreLabel,
        scoreReason:  a.scoreReason,
        newsRiskLevel: a.newsRiskLevel,
        status:       a.status,
        receivedAt:   a.receivedAt,
      })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "ALERTS_FETCH_FAILED" });
  }
});

export default router;
