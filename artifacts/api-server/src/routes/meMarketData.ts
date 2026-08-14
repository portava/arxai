// Phase: Market Data Freshness — per-user market-data status + refresh.
//
// SAFETY:
//   - 100% read-only with respect to trading. These endpoints never place,
//     modify, cancel, or close any trade. They never mutate safetyCore,
//     bridge tokens, vault credentials, or per-user trading settings.
//   - Live trading remains BLOCKED, auto-close remains ALERT_ONLY, shared
//     MT5 routing remains BLOCKED, MT5 commands remain force-BLOCKED.
//   - requireUser auth — scoped per user. Refresh attempts are
//     rate-limited per user (5s minimum) so the provider's free-tier
//     budget is preserved.
//   - No secrets returned. No fake/simulator data. If the provider is not
//     configured, status returns connected:false with an honest reason
//     and refresh returns ok:false / reason:"provider_not_connected".

import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  getMarketStatus,
  refreshMarketProvider,
  getCurrentEventsFromProvider,
} from "../lib/assistant/marketProvider.js";
import { mapLegacyBridgeMode, applyHeartbeatStaleness, type CanonicalBridgeMode } from "@workspace/domain/safety-contracts/bridgeMode";

const router: Router = Router();

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

// Probe symbols + rate-limit chosen to stay well inside the TwelveData
// free-tier budget (8 req/min). 2 probes per refresh × max 4 refresh/min/user
// (15s interval) = worst case 8 req/min from a single user. Real-world users
// won't refresh that fast, leaving budget for the scanner's own scans.
const REFRESH_PROBE_SYMBOLS = ["EURUSD", "XAUUSD"] as const;
const REFRESH_MIN_INTERVAL_MS = 15_000;
// Bounded LRU-ish map for per-user last-refresh timestamps. Hard-capped
// to prevent unbounded memory growth under high user cardinality (or a
// flood of fake IDs from a misconfigured caller). When the cap is hit
// we drop the oldest half — cheap, simple, no external dep.
const REFRESH_MAP_MAX = 5_000;
const lastRefreshByUser = new Map<number, number>();
function noteRefresh(userId: number, at: number): void {
  if (lastRefreshByUser.size >= REFRESH_MAP_MAX) {
    const sorted = Array.from(lastRefreshByUser.entries()).sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, Math.floor(REFRESH_MAP_MAX / 2));
    for (const [k] of drop) lastRefreshByUser.delete(k);
  }
  lastRefreshByUser.set(userId, at);
}

// Cleanup phase A — canonical MT5 bridge mode for the status payload.
// The MT5 bridge is not wired today (live force-BLOCKED; paper-only by
// construction), so the canonical mode is OFFLINE. If/when a real
// heartbeat source is connected, swap this for a real lookup and the
// mapper + staleness rule will produce the correct canonical literal.
function deriveCanonicalBridgeMode(): { canonical: CanonicalBridgeMode; legacy: string; heartbeatStale: boolean; note: string } {
  const tokenConfigured = Boolean(process.env.MT5_BRIDGE_TOKEN);
  const legacy = tokenConfigured ? "unknown" : "disconnected";
  const heartbeatStale = true; // no real heartbeat source wired
  const canonical = applyHeartbeatStaleness(mapLegacyBridgeMode(legacy), heartbeatStale);
  return {
    canonical,
    legacy,
    heartbeatStale,
    note: tokenConfigured
      ? "MT5_BRIDGE_TOKEN is configured but no real heartbeat is being tracked yet. Defaulting to OFFLINE per the contract."
      : "MT5 bridge is not configured. Defaulting to OFFLINE.",
  };
}

// Cleanup phase D — command-execution gate is force-BLOCKED system-wide
// (live trading + shared MT5 routing both locked). This field is the
// machine-readable source for the dashboard's "Command Execution Disabled"
// badge — `allowed:false` is informational, not an error condition.
const COMMAND_EXECUTION_LOCKED = {
  allowed: false as const,
  reason: "Live trading is BLOCKED system-wide; shared MT5 routing is BLOCKED; MT5 commands are force-BLOCKED. Paper-only by construction.",
  intentional: true as const,
};

// GET /api/me/market-data/status — full honest provider status.
router.get("/me/market-data/status", requireUser, async (req, res) => {
  const status = getMarketStatus();
  // Cleanup phase C — discrete current-events channel state. Surfaces
  // `connected:false` honestly so the dashboard can render a dedicated
  // "Current Events Unavailable" badge (separate from market news).
  const ce = await getCurrentEventsFromProvider(1);
  const currentEvents = {
    connected: ce.connected,
    provider: ce.provider,
    reason: ce.connected ? null : (ce.reason ?? "Current-events channel unavailable."),
  };
  const bridge = deriveCanonicalBridgeMode();
  req.log?.info(
    {
      event: "market_data_status_read",
      userId: req.authUser!.id,
      provider: status.provider,
      connected: status.connected,
      stale: status.stale,
      freshnessState: status.freshnessState,
      rateLimited: status.rateLimitStatus?.limited === true,
      currentEventsConnected: currentEvents.connected,
      bridgeCanonicalMode: bridge.canonical,
    },
    "market_data status read",
  );
  res.json({
    status,
    currentEvents,
    commandExecution: COMMAND_EXECUTION_LOCKED,
    bridge,
    safetyEnvelope: SAFETY_ENVELOPE,
  });
});

// POST /api/me/market-data/refresh — force a real provider probe and
// return the updated status. Never executes trades.
router.post("/me/market-data/refresh", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const now = Date.now();
  const last = lastRefreshByUser.get(userId) ?? 0;
  const since = now - last;
  if (since < REFRESH_MIN_INTERVAL_MS) {
    req.log?.warn(
      { event: "market_data_refresh_rate_limited", userId, sinceMs: since },
      "market data refresh rate-limited",
    );
    res.status(429).json({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: REFRESH_MIN_INTERVAL_MS - since,
      status: getMarketStatus(),
      safetyEnvelope: SAFETY_ENVELOPE,
    });
    return;
  }
  noteRefresh(userId, now);

  const previousStatus = getMarketStatus();
  if (!previousStatus.connected) {
    req.log?.warn(
      {
        event: "market_data_refresh_skipped",
        userId,
        provider: previousStatus.provider,
        reason: "provider_not_connected",
      },
      "market data refresh skipped — provider not connected",
    );
    res.json({
      ok: false,
      reason: "provider_not_connected",
      attempts: [],
      previousStatus,
      status: previousStatus,
      safetyEnvelope: SAFETY_ENVELOPE,
    });
    return;
  }

  const result = await refreshMarketProvider(REFRESH_PROBE_SYMBOLS);
  const status = getMarketStatus();
  const ok = result.probes.some((p) => p.ok);
  req.log?.info(
    {
      event: "market_data_refresh",
      userId,
      provider: result.provider,
      ok,
      previousFreshnessState: previousStatus.freshnessState,
      newFreshnessState: status.freshnessState,
      probes: result.probes,
    },
    "market data refresh completed",
  );
  res.json({
    ok,
    reason: ok ? "ok" : "no_probe_succeeded",
    attempts: result.probes,
    previousStatus,
    status,
    safetyEnvelope: SAFETY_ENVELOPE,
  });
});

export default router;
