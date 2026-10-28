// Read-only diagnostic endpoints for the ARX App Doctor.
// These endpoints DO NOT change MT5 behavior, broker state, or risk controls.
// They never return tokens, secrets, credentials, or stack traces.
import { Router, type IRouter } from "express";
import { getUserActiveConnection } from "../lib/brokerHub/connections.js";
import { isHeartbeatAgeMsFresh } from "../lib/brokerHub/freshness.js";
import { checkDatabaseReadiness } from "../lib/startup/databaseReadiness.js";

const router: IRouter = Router();

const BUILD_TIMESTAMP = process.env["BUILD_TIMESTAMP"] ?? null;

async function probe(path: string, baseUrl: string, signal: AbortSignal): Promise<{ ok: boolean; status: number | null }> {
  try {
    const r = await fetch(new URL(path, baseUrl).toString(), { signal });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: null };
  }
}

router.get("/app/health-summary", async (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const baseUrl = `${proto}://${host}`;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2_000);

  try {
    // databaseReachable comes from a real bounded `select 1` (the same probe
    // as /health/ready), never from DATABASE_URL merely being set.
    const [healthz, feedback, mt5Hb, readiness, riskGov, simulator, dbCheck] = await Promise.all([
      probe("/api/healthz", baseUrl, ac.signal),
      probe("/api/feedback", baseUrl, ac.signal),
      probe("/api/mt5/heartbeat/status", baseUrl, ac.signal),
      probe("/api/readiness/checks/latest", baseUrl, ac.signal),
      probe("/api/risk/state", baseUrl, ac.signal),
      probe("/api/market/session-status", baseUrl, ac.signal),
      checkDatabaseReadiness(),
    ]);
    res.json({
      serverReachable: healthz.ok,
      databaseReachable: dbCheck.status === "ready",
      databaseCheckedAt: dbCheck.checkedAt,
      authDetected: !!req.signedCookies && Object.keys(req.signedCookies).length > 0,
      // /api/feedback intentionally returns 403 for non-tester users; either is "healthy".
      feedbackHealthy: feedback.status === 200 || feedback.status === 403 || feedback.status === 401,
      mt5BridgeReachable: mt5Hb.ok,
      readinessReachable: readiness.ok,
      riskReachable: riskGov.ok,
      simulatorReachable: simulator.ok,
      recentSafeServerErrorCount: 0,
      buildTimestamp: BUILD_TIMESTAMP,
      healthLatencyMs: Date.now() - t0,
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
});

router.get("/mt5/diagnostic-summary", async (req, res) => {
  // Read existing safe diagnostic surface; never call broker or send orders.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const baseUrl = `${proto}://${host}`;
  type HbShape = {
    eaConnected?: boolean;
    lastHeartbeatAt?: string | null;
    heartbeatAgeSeconds?: number | null;
    bridgeTokenConfigured?: boolean;
  };
  // Heartbeat scope. A signed-in caller gets THEIR OWN EA connection's
  // heartbeat (mt5_connection, freshest non-revoked bridge). The platform
  // probe /api/mt5/heartbeat/status reads the platform-wide mt5_state
  // singleton — another user's EA — so it is used only for an anonymous
  // caller and is labelled "platform".
  let hb: HbShape | null = null;
  let heartbeatScope: "your_connection" | "no_connection" | "platform";
  const userId = req.authUser?.id ?? null;
  if (userId != null) {
    let conn: Awaited<ReturnType<typeof getUserActiveConnection>> = null;
    let readable = true;
    try { conn = await getUserActiveConnection(userId); } catch { readable = false; }
    if (!readable) {
      heartbeatScope = "your_connection";
      hb = null; // unreadable → bridgeMode "unknown", never "connected"
    } else if (!conn) {
      heartbeatScope = "no_connection";
      // No connection with an active token: this caller has no bridge token.
      hb = { eaConnected: false, lastHeartbeatAt: null, heartbeatAgeSeconds: null, bridgeTokenConfigured: false };
    } else {
      heartbeatScope = "your_connection";
      const at = conn.lastHeartbeat ? new Date(conn.lastHeartbeat) : null;
      const ageMs = at ? Math.max(0, Date.now() - at.getTime()) : null;
      hb = {
        eaConnected: isHeartbeatAgeMsFresh(ageMs),
        lastHeartbeatAt: at ? at.toISOString() : null,
        heartbeatAgeSeconds: ageMs != null ? Math.floor(ageMs / 1000) : null,
        // getUserActiveConnection returns only a connection with an active
        // bridge token (activeTokenOnly), so this caller has one: a stale
        // heartbeat is "disconnected" (the EA stopped), never "deferred".
        bridgeTokenConfigured: true,
      };
    }
  } else {
    heartbeatScope = "platform";
    try {
      const r = await fetch(new URL("/api/mt5/heartbeat/status", baseUrl).toString(), {
        signal: AbortSignal.timeout(2_000),
      });
      if (r.ok) hb = (await r.json()) as HbShape;
    } catch { /* ignore */ }
  }

  // Bridge state comes from the heartbeat authority, never from the legacy
  // MT5_BRIDGE_TOKEN env var: that env token is rejected on every EA
  // endpoint, so its absence is the normal production state. Per-user bridge
  // tokens are the only EA auth, and /mt5/heartbeat/status reports whether one
  // is active (bridgeTokenConfigured). A fresh accepted heartbeat proves the
  // bridge is wired whatever the token flag says. No readable status → unknown.
  const tokenConfigured: boolean | null = hb ? hb.bridgeTokenConfigured === true : null;
  const heartbeatPresent = !!hb?.eaConnected;
  const eaConnected = heartbeatPresent;
  const bridgeMode: "deferred" | "simulator" | "connected" | "disconnected" | "unknown" =
    !hb ? "unknown"
      : eaConnected ? "connected"
        : !tokenConfigured ? "deferred"
          : "disconnected";

  // SAFETY: live trading and broker execution are server-enforced OFF until
  // an operator clears them server-side. The assistant never claims they're on.
  const liveTradingEnabled = false;
  const brokerExecutionEnabled = false;
  const brokerReadOnly = true;
  const paperOnly = bridgeMode !== "connected";

  const reason =
    bridgeMode === "deferred" && heartbeatScope === "no_connection"
      ? "You have no MT5 EA connection of your own with an active bridge token, so no heartbeat is checked for your account. ARX stays in simulator/paper mode for you."
    : bridgeMode === "deferred"
      ? "No MT5 bridge token is active and no fresh EA heartbeat was received. ARX runs in simulator/paper mode."
      : bridgeMode === "disconnected"
        ? "A bridge token is active, but no fresh EA heartbeat was received. ARX stays in simulator/paper mode until the EA reports in."
        : bridgeMode === "connected"
          ? "Bridge is connected and the EA is heartbeating. Broker remains read-only until execution is explicitly cleared server-side."
          : "The bridge heartbeat status could not be read, so the bridge state is unknown; treating as deferred for safety.";

  const safestNextStep =
    bridgeMode === "deferred"
      ? "Continue in simulator/paper mode. Create a bridge token on the MT5 Bridge page when you are ready to wire the EA."
      : bridgeMode === "disconnected"
        ? "Open the MT5 Bridge page and verify the EA is running, the WebRequest URL is allow-listed, and the X-MT5-Bridge-Token header matches."
        : "Stay read-only and verify positions/balance match the broker terminal before considering execution.";

  res.json({
    bridgeMode,
    heartbeatPresent,
    heartbeatScope,
    lastHeartbeatAt: hb?.lastHeartbeatAt ?? null,
    heartbeatAgeSeconds: hb?.heartbeatAgeSeconds ?? null,
    brokerExecutionEnabled,
    brokerReadOnly,
    liveTradingEnabled,
    paperOnly,
    safestNextStep,
    reason,
    fetchedAt: new Date().toISOString(),
  });
});

export default router;
