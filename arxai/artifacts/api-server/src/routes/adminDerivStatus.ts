// Admin-only Deriv provider health endpoint.
//
// GET /api/admin/deriv-status — returns full health with masked credentials.
// GET /api/admin/deriv-status/check — triggers an active connection check.
//
// SECURITY:
//   - Admin/Owner only.
//   - Never returns raw DERIV_APP_ID, DERIV_API_TOKEN, or OTP URLs.
//   - Only masked values (first 2 + last 2 chars).
//   - Sanitizes all error messages to strip any credential patterns.

import { Router, type Request, type Response } from "express";
import { getDerivFeedStatus, getDerivSymbolFeedStatus, DERIV_SYNTHETIC_SYMBOLS } from "../lib/data/providers/derivProvider.js";
import { getDerivFeedClient } from "../lib/data/providers/derivFeedClient.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return false; }
  const role = operatorRoleFromSession(u.role);
  if (!role) {
    res.status(403).json({ error: "FORBIDDEN" }); return false;
  }
  return true;
}

// Sanitize error messages to never leak credentials
function sanitizeError(msg: string | null): string | null {
  if (!msg) return null;
  // Redact anything that looks like a token or app id
  return msg
    .replace(/pat_[A-Za-z0-9_-]+/gi, "<token>")
    .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer <token>")
    .replace(/app_id=[^\s&"]+/gi, "app_id=<redacted>")
    .slice(0, 300);
}

router.get("/admin/deriv-status", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = getDerivFeedStatus();
  // Runtime-discovery visibility (audit G1) — read straight from the client.
  const client = getDerivFeedClient();
  const discovery = client.getLastDiscovery();
  const discoveryValidation = client.getLastDiscoveryValidation();

  // Friendly blocker reasons for admin
  const blockers: string[] = [];
  if (!status.configured) blockers.push("Public market data is disabled. Enable ARX_DERIV_PUBLIC_DATA_ENABLED in development configuration.");
  if (status.mode === "public" && status.activeSymbolsError) blockers.push("Public discovery has not completed.");
  if (status.errorMessage) blockers.push("The market-data connection is not ready; see the sanitized error below.");

  res.json({
    ok:            true,
    health:        status.healthSummary,
    mode:          status.mode,
    source:        status.source,
    authorized:    status.authorized,
    tradingAvailable: false,
    perSymbol: DERIV_SYNTHETIC_SYMBOLS.map(s => ({ symbol: s.symbol, ...getDerivSymbolFeedStatus(s.symbol) })),
    configured:    status.configured,
    connected:     status.connected,
    credentials: {
      appId:     { present: status.appIdConfigured,    masked: status.maskedAppId },
      token:     { present: status.apiTokenConfigured, masked: status.maskedToken },
      accountId: { present: status.accountIdConfigured },
    },
    otpLastResult:    sanitizeError(status.otpLastResult),
    errorMessage:     sanitizeError(status.errorMessage),
    lastTickAt:       status.lastTickAt,
    lastTickAgeMs:    status.lastTickAgeMs,
    hasRecentTick:    status.hasRecentTick,
    lastCandleAt:     status.lastCandleAt,
    connectedAt:      status.connectedAt,
    reconnectCount:   status.reconnectCount,
    subscribedSymbols: status.subscribedSymbols,
    knownSymbols:     status.knownSyntheticSymbolCount,
    activeSymbols:    status.activeSymbolCount,
    activeSymbolsLoaded:        status.activeSymbolsLoaded,
    activeSymbolsCachedCount:   status.activeSymbolsCachedCount,
    activeSymbolsLoadedAt:      status.activeSymbolsLoadedAt,
    activeSymbolsError:         sanitizeError(status.activeSymbolsError),
    eagerWarmupSymbols:         status.eagerWarmupSymbols,
    warmupAttemptedAt:          status.warmupAttemptedAt,
    warmupCompletedAt:          status.warmupCompletedAt,
    feedReadinessState:         status.feedReadinessState,
    // Additive: runtime symbol discovery freshness + report-only map diff.
    // `validation` is null until a non-empty discovery has completed; the
    // mismatch lists are reported verbatim, never auto-corrected.
    discovery: {
      loaded:      client.isActiveSymbolsLoaded(),
      fetchedAt:   discovery?.fetchedAt ?? null,
      ageMs:       client.getLastDiscoveryAgeMs(),
      symbolCount: discovery ? discovery.symbols.length : null,
      validation: discoveryValidation
        ? {
            matchedCount:     discoveryValidation.matched.length,
            missingFromVenue: discoveryValidation.missingFromVenue,
            unknownAtVenue:   discoveryValidation.unknownAtVenue,
          }
        : null,
    },
    message:          status.message,
    blockers,
    setupInstructions: !status.configured ? [
      "1. In the development workspace configuration, set ARX_DERIV_PUBLIC_DATA_ENABLED=true.",
      "2. Restart the development server, then test the connection here.",
      "Public quotes and candles need no app ID, token or account ID. This does not connect a trading account or enable orders.",
    ] : [],
  });
});

// Active connection check — triggers ensureConnection and waits briefly
router.post("/admin/deriv-status/check", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = getDerivFeedClient();
  client.ensureConnection();
  // Wait up to 3s for connection
  await new Promise(r => setTimeout(r, 3000));
  const status = getDerivFeedStatus();
  res.json({
    ok:        true,
    connected: status.connected,
    health:    status.healthSummary,
    error:     sanitizeError(status.errorMessage),
  });
});

// Active probe — runs `active_symbols` + `ticks_history(R_75, 60s, 5)`
// round trips against the live Deriv WS. Surfaces the real Deriv error
// for PAT/credential mismatches instead of a synthetic blocker message.
router.post("/admin/deriv-status/probe", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = getDerivFeedClient();
  const result = await client.probe();
  res.json({
    ok: true,
    connected:           result.connected,
    authorized:          result.authorized,
    activeSymbolsCount:  result.activeSymbolsCount,
    activeSymbolsError:  sanitizeError(result.activeSymbolsError),
    ticksHistoryCount:   result.ticksHistoryCount,
    lastCandleEpoch:     result.lastCandleEpoch,
    lastCandleAt:        result.lastCandleEpoch
      ? new Date(result.lastCandleEpoch * 1000).toISOString()
      : null,
    ticksHistoryError:   sanitizeError(result.ticksHistoryError),
  });
});

export default router;
