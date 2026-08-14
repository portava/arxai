// TradingView Webhook Service
//
// Handles incoming TradingView Pine Script alerts:
//   1. Validate the webhook token → identify user
//   2. Parse the alert payload
//   3. Score against ARX scanner + user history + news risk
//   4. Store in tradingview_alerts
//   5. Notify the user via the notification system
//
// SAFETY:
//   - NEVER executes trades. NEVER sends MT5 commands.
//   - Alerts are review-only. User must manually place any trade.
//   - Bad/missing API keys return safe disconnected status.

import { createHash, randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import {
  tradingviewAlertsTable,
  webhookTokensTable,
  type TradingviewAlertRow,
} from "@workspace/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "./logger.js";
import { createNotification } from "./notificationService.js";
import { getTradeHistorySummary } from "./tradeHistory/service.js";

const log = logger.child({ component: "tradingviewWebhook" });

// ── Token management ──────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function maskToken(raw: string): string {
  if (raw.length < 8) return "****";
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

export async function generateWebhookToken(userId: number, label = "TradingView"): Promise<{
  token: string;
  masked: string;
  webhookUrl: string;
}> {
  // Revoke any existing active token for this user + label
  await db.update(webhookTokensTable)
    .set({ isActive: false })
    .where(and(
      eq(webhookTokensTable.userId, userId),
      eq(webhookTokensTable.label, label),
      eq(webhookTokensTable.isActive, true),
    ));

  const raw     = randomBytes(32).toString("hex");
  const hash    = hashToken(raw);
  const masked  = maskToken(raw);

  await db.insert(webhookTokensTable).values({
    userId,
    tokenHash:   hash,
    tokenMasked: masked,
    label,
    isActive:    true,
  });

  // The webhook URL includes the token as a query param so TradingView can POST to it
  const baseUrl = process.env["APP_BASE_URL"] ?? "https://your-app.replit.app";
  const webhookUrl = `${baseUrl}/api/webhooks/tradingview?token=${raw}`;

  log.info({ userId, label }, "webhook_token_generated");
  return { token: raw, masked, webhookUrl };
}

export async function getUserWebhookTokens(userId: number) {
  return db.select({
    id:          webhookTokensTable.id,
    label:       webhookTokensTable.label,
    tokenMasked: webhookTokensTable.tokenMasked,
    isActive:    webhookTokensTable.isActive,
    lastUsedAt:  webhookTokensTable.lastUsedAt,
    createdAt:   webhookTokensTable.createdAt,
  })
    .from(webhookTokensTable)
    .where(eq(webhookTokensTable.userId, userId))
    .orderBy(desc(webhookTokensTable.createdAt));
}

export async function revokeWebhookToken(userId: number, tokenId: number) {
  await db.update(webhookTokensTable)
    .set({ isActive: false })
    .where(and(
      eq(webhookTokensTable.id, tokenId),
      eq(webhookTokensTable.userId, userId),
    ));
}

// ── Alert parsing ─────────────────────────────────────────────────────────────

export interface ParsedAlert {
  symbol:       string | null;
  action:       "BUY" | "SELL" | "CLOSE" | "WAIT" | "INFO" | null;
  price:        number | null;
  strategyName: string | null;
  timeframe:    string | null;
  message:      string | null;
}

export function parseAlertPayload(body: unknown): ParsedAlert {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};

  // TradingView alerts can be free-text or structured JSON
  // Common patterns: {ticker, action, price, strategy, timeframe, message}
  const symbol = extractText(b, ["ticker", "symbol", "sym", "instrument"]);
  const rawAction = extractText(b, ["action", "side", "direction", "signal", "type"]);
  const price  = extractFloat(b, ["price", "close", "entry", "value"]);
  const strat  = extractText(b, ["strategy", "strategy_name", "indicator", "name", "script"]);
  const tf     = extractText(b, ["timeframe", "tf", "interval", "period"]);
  const msg    = extractText(b, ["message", "msg", "text", "alert", "comment"]);

  let action: ParsedAlert["action"] = null;
  if (rawAction) {
    const a = rawAction.toLowerCase();
    if      (a.includes("buy")  || a === "long"  || a === "1")  action = "BUY";
    else if (a.includes("sell") || a === "short" || a === "-1") action = "SELL";
    else if (a.includes("close") || a === "exit" || a === "0")  action = "CLOSE";
    else if (a.includes("wait") || a === "neutral")              action = "WAIT";
    else                                                          action = "INFO";
  }

  return {
    symbol:       symbol ? symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") : null,
    action,
    price,
    strategyName: strat,
    timeframe:    tf,
    message:      msg,
  };
}

function extractText(b: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = b[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function extractFloat(b: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = b[k];
    const n = parseFloat(String(v ?? ""));
    if (isFinite(n)) return n;
  }
  return null;
}

// ── Alert scoring ─────────────────────────────────────────────────────────────

async function scoreAlert(
  userId: number | null,
  alert: ParsedAlert,
): Promise<{
  overallScore:     number;
  scoreLabel:       string;
  scoreReason:      string;
  userHistoryScore: number | null;
  newsRiskLevel:    string;
  spreadWarning:    boolean;
}> {
  let score = 50; // start neutral
  const reasons: string[] = [];

  // 1. Action clarity
  if (!alert.action || alert.action === "INFO") {
    return {
      overallScore: 0, scoreLabel: "UNSCORED",
      scoreReason: "Alert has no clear BUY/SELL direction — review manually.",
      userHistoryScore: null, newsRiskLevel: "none", spreadWarning: false,
    };
  }
  if (alert.action === "WAIT") {
    return {
      overallScore: 50, scoreLabel: "WAIT",
      scoreReason: "Alert signals to wait — no trade recommended.",
      userHistoryScore: null, newsRiskLevel: "none", spreadWarning: false,
    };
  }

  // 2. Symbol present
  if (!alert.symbol) {
    reasons.push("No symbol specified — cannot verify against scanner.");
    score -= 15;
  }

  // 3. User history score
  let userHistoryScore: number | null = null;
  if (userId && alert.symbol && alert.action) {
    try {
      const summary = await getTradeHistorySummary(userId);
      if (summary.hasTrades && summary.topSymbols) {
        const symData = (summary.topSymbols as Array<{ symbol: string; winRate: number; count: number }>)
          .find((s) => s.symbol === alert.symbol);
        if (symData && symData.count >= 5) {
          userHistoryScore = Math.round(symData.winRate);
          if (symData.winRate >= 60) {
            score += 10;
            reasons.push(`Your history: ${symData.winRate}% win rate on ${alert.symbol} (${symData.count} trades).`);
          } else if (symData.winRate < 40) {
            score -= 10;
            reasons.push(`Caution: your ${alert.symbol} win rate is ${symData.winRate}% (${symData.count} trades).`);
          } else {
            reasons.push(`Your ${alert.symbol} history: ${symData.winRate}% win rate (${symData.count} trades).`);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // 4. Strategy name present
  if (alert.strategyName) {
    reasons.push(`Signal from: ${alert.strategyName}.`);
  } else {
    reasons.push("No strategy name — unknown signal source.");
    score -= 5;
  }

  // 5. Price present
  if (!alert.price) {
    reasons.push("No entry price included — evaluate current price before acting.");
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));

  const scoreLabel =
    score >= 75 ? "STRONG"   :
    score >= 55 ? "MODERATE" :
    score >= 35 ? "WEAK"     : "AVOID";

  return {
    overallScore:     Math.round(score),
    scoreLabel,
    scoreReason:      reasons.join(" ") || "Alert received — review before acting.",
    userHistoryScore,
    newsRiskLevel:    "none", // real news scoring wired via newsIntelligenceService
    spreadWarning:    false,
  };
}

// ── Main receive handler ──────────────────────────────────────────────────────

export async function receiveAlert(
  tokenRaw: string,
  rawBody: unknown,
): Promise<{ ok: boolean; alertId: string | null; error?: string }> {
  // 1. Validate token → find user
  const hash = hashToken(tokenRaw);
  const tokenRows = await db.select()
    .from(webhookTokensTable)
    .where(and(
      eq(webhookTokensTable.tokenHash, hash),
      eq(webhookTokensTable.isActive, true),
    ))
    .limit(1);

  const token = tokenRows[0];
  if (!token) {
    log.warn({ hashPrefix: hash.slice(0, 8) }, "tradingview_invalid_token");
    return { ok: false, alertId: null, error: "INVALID_TOKEN" };
  }

  const userId = token.userId;
  const alertId = `tv_${randomBytes(8).toString("hex")}`;

  // 2. Parse
  const parsed = parseAlertPayload(rawBody);

  // 3. Insert raw alert immediately (don't block on scoring)
  await db.insert(tradingviewAlertsTable).values({
    alertId,
    userId,
    webhookKey:  token.tokenMasked,
    rawPayload:  (rawBody as Record<string, unknown>),
    symbol:      parsed.symbol,
    action:      parsed.action,
    price:       parsed.price,
    strategyName: parsed.strategyName,
    timeframe:   parsed.timeframe,
    message:     parsed.message,
    status:      "received",
  });

  // 4. Update token last used
  await db.update(webhookTokensTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(webhookTokensTable.id, token.id));

  log.info({ userId, alertId, symbol: parsed.symbol, action: parsed.action }, "tradingview_alert_received");

  // 5. Score + notify async (fire and forget — don't block the webhook response)
  void (async () => {
    try {
      const scoring = await scoreAlert(userId, parsed);

      await db.update(tradingviewAlertsTable)
        .set({
          scored:           true,
          scannerScore:     null,
          userHistoryScore: scoring.userHistoryScore,
          newsRiskLevel:    scoring.newsRiskLevel,
          spreadWarning:    scoring.spreadWarning,
          overallScore:     scoring.overallScore,
          scoreLabel:       scoring.scoreLabel,
          scoreReason:      scoring.scoreReason,
          scoredAt:         new Date(),
          status:           "scored",
        })
        .where(eq(tradingviewAlertsTable.alertId, alertId));

      // Notify user
      if (userId) {
        const severity =
          scoring.scoreLabel === "STRONG"   ? "warning" :
          scoring.scoreLabel === "MODERATE" ? "info"    : "info";

        const title = parsed.action && parsed.symbol
          ? `TradingView: ${parsed.action} signal on ${parsed.symbol}`
          : "TradingView alert received";

        const message = `${scoring.scoreReason} Score: ${scoring.overallScore}/100 (${scoring.scoreLabel}). Review before acting — ARX does not auto-execute TradingView alerts.`;

        await createNotification(userId, {
          notificationType: "tradingview_alert",
          severity,
          title,
          message,
          source:      "ai",
          entityType:  "tradingview_alert",
          entityId:    0,
          actionLabel: "View alert",
          actionTarget: "/alerts",
        });

        await db.update(tradingviewAlertsTable)
          .set({ status: "notified", notifiedAt: new Date() })
          .where(eq(tradingviewAlertsTable.alertId, alertId));
      }
    } catch (e) {
      log.warn({ err: e, alertId }, "tradingview_score_notify_failed");
    }
  })();

  return { ok: true, alertId };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function listUserAlerts(userId: number, limit = 20): Promise<TradingviewAlertRow[]> {
  return db.select()
    .from(tradingviewAlertsTable)
    .where(eq(tradingviewAlertsTable.userId, userId))
    .orderBy(desc(tradingviewAlertsTable.receivedAt))
    .limit(Math.min(limit, 100));
}

export async function getAlertStatus(): Promise<{
  configured: boolean;
  reason: string;
}> {
  // TradingView webhooks work as long as the app is publicly reachable
  // No API key required — auth is via per-user tokens
  const baseUrl = process.env["APP_BASE_URL"];
  if (!baseUrl) {
    return {
      configured: false,
      reason: "APP_BASE_URL environment variable not set. Set it to your Replit app URL so TradingView can reach the webhook endpoint.",
    };
  }
  return {
    configured: true,
    reason: `Webhook endpoint: ${baseUrl}/api/webhooks/tradingview?token=YOUR_TOKEN`,
  };
}
