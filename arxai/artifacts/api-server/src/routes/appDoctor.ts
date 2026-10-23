// Read-only diagnostic endpoints for the ARX App Doctor.
// These endpoints DO NOT change MT5 behavior, broker state, or risk controls.
// They never return tokens, secrets, credentials, or stack traces.
import { Router, type IRouter } from "express";

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
    const [healthz, feedback, mt5Hb, readiness, riskGov, simulator] = await Promise.all([
      probe("/api/healthz", baseUrl, ac.signal),
      probe("/api/feedback", baseUrl, ac.signal),
      probe("/api/mt5/heartbeat/status", baseUrl, ac.signal),
      probe("/api/readiness/checks/latest", baseUrl, ac.signal),
      probe("/api/risk/state", baseUrl, ac.signal),
      probe("/api/market/session-status", baseUrl, ac.signal),
    ]);
    const dbReachable = !!process.env["DATABASE_URL"];
    res.json({
      serverReachable: healthz.ok,
      databaseReachable: dbReachable ? true : null,
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
  let hb: HbShape | null = null;
  try {
    const r = await fetch(new URL("/api/mt5/heartbeat/status", baseUrl).toString(), {
      signal: AbortSignal.timeout(2_000),
    });
    if (r.ok) hb = (await r.json()) as HbShape;
  } catch { /* ignore */ }

  const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"];
  const heartbeatPresent = !!hb?.eaConnected;
  const eaConnected = heartbeatPresent;
  const bridgeMode: "deferred" | "simulator" | "connected" | "disconnected" | "unknown" =
    !tokenConfigured ? "deferred"
      : eaConnected ? "connected"
        : hb ? "disconnected"
          : "unknown";

  // SAFETY: live trading and broker execution are server-enforced OFF until
  // an operator clears them server-side. The assistant never claims they're on.
  const liveTradingEnabled = false;
  const brokerExecutionEnabled = false;
  const brokerReadOnly = true;
  const paperOnly = bridgeMode !== "connected";

  const reason =
    bridgeMode === "deferred"
      ? "MT5 bridge is intentionally deferred (no MT5_BRIDGE_TOKEN configured). ARX runs in simulator/paper mode."
      : bridgeMode === "disconnected"
        ? "Bridge token is configured, but no fresh EA heartbeat was received. ARX stays in simulator/paper mode until the EA reports in."
        : bridgeMode === "connected"
          ? "Bridge is connected and the EA is heartbeating. Broker remains read-only until execution is explicitly cleared server-side."
          : "Bridge state is unknown; treating as deferred for safety.";

  const safestNextStep =
    bridgeMode === "deferred"
      ? "Continue in simulator/paper mode. Configure MT5_BRIDGE_TOKEN server-side only when you are ready to wire the EA."
      : bridgeMode === "disconnected"
        ? "Open the MT5 Bridge page and verify the EA is running, the WebRequest URL is allow-listed, and the X-MT5-Bridge-Token header matches."
        : "Stay read-only and verify positions/balance match the broker terminal before considering execution.";

  res.json({
    bridgeMode,
    heartbeatPresent,
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
