// Admin — Claude Backend Fix Agent (Task #705)
//
// ADMIN-ONLY, ADVISORY / DIAGNOSTIC. Diagnoses backend errors and proposes
// DRY-RUN patches for a human to review. It is NEVER an execution path:
//   - never places/approves/modifies/cancels a trade,
//   - never mutates MT5/bridge state or arms execution,
//   - never overrides/weakens a risk gate or the kill switch,
//   - never marks anything broker-confirmed, and
//   - never applies a patch (no APPLY path exists; dryRun=true, applied=false).
//
// A CI import-boundary guard (check-fix-agent-import-boundary) fails the build if
// this file or anything under lib/ai/ imports an execution/bridge/risk/live
// module or names a runtime require.
//
// Routes (mounted under /api):
//   GET  /admin/ai/fix-agent/health        — enablement + provider config
//   POST /admin/ai/fix-agent/diagnose      — structured diagnosis
//   POST /admin/ai/fix-agent/propose-patch — DRY-RUN patch proposal
//   GET  /admin/ai/fix-agent/runs          — recent run ledger (redacted summary)
//
// SAFETY:
//   - Every handler is requireAdmin (admin-previewing-as-user is rejected via
//     the effective-role check, consistent with other operator endpoints).
//   - Disabled => 409 FIX_AGENT_DISABLED. Provider not configured => 409.
//   - Each call persists a run row + an admin audit row in ONE transaction
//     (fail-closed). A provider failure persists a status="failed" row and
//     returns a safe error — the raw provider error never reaches the client.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { desc } from "drizzle-orm";
import { db, aiFixAgentRunsTable, adminActionAuditLogTable } from "@workspace/db";
import { getFixAgentConfig } from "../lib/ai/fixAgentConfig.js";
import { getAIProvider } from "../lib/ai/providers/factory.js";
import {
  diagnose,
  proposePatch,
  type FixAgentInput,
  type FixAgentCallMeta,
} from "../lib/ai/backendFixAgent.js";
import { readRecentPerf, type PerfRow } from "../lib/perf/perfRecorder.js";

const router: IRouter = Router();
router.use(express.json({ limit: "256kb" }));

type AdminSession = { id: number; role: "ADMIN" | "OWNER" };

function requireAdmin(req: Request, res: Response): AdminSession | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

function logError(req: Request, obj: Record<string, unknown>, msg: string): void {
  (req as Request & { log?: { error: (o: unknown, m?: string) => void } }).log?.error(obj, msg);
}

function parseBody(req: Request): FixAgentInput | null {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const errorText = typeof b.errorText === "string" ? b.errorText : "";
  if (!errorText.trim()) return null;
  return {
    errorText,
    area: typeof b.area === "string" ? b.area : undefined,
    contextText: typeof b.contextText === "string" ? b.contextText : undefined,
    logsText: typeof b.logsText === "string" ? b.logsText : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
  };
}

// Persist a run row + an admin audit row in ONE transaction (fail-closed).
async function persistRun(args: {
  admin: AdminSession;
  mode: "diagnose" | "propose_patch";
  area: string;
  provider: string;
  model: string;
  status: "completed" | "failed";
  inputRedacted: unknown;
  output: unknown;
  errorReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}): Promise<number> {
  let runId = 0;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(aiFixAgentRunsTable)
      .values({
        adminId: args.admin.id,
        adminRole: args.admin.role,
        mode: args.mode,
        area: args.area,
        provider: args.provider,
        model: args.model,
        dryRun: true,
        applied: false,
        status: args.status,
        inputRedacted: (args.inputRedacted ?? {}) as object,
        output: (args.output ?? null) as object | null,
        errorReason: args.errorReason,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        latencyMs: args.latencyMs,
      })
      .returning({ id: aiFixAgentRunsTable.id });
    runId = row.id;
    await tx.insert(adminActionAuditLogTable).values({
      adminId: args.admin.id,
      adminRole: args.admin.role,
      action: "AI_FIX_AGENT_RUN",
      beforeState: {},
      afterState: {
        runId,
        mode: args.mode,
        area: args.area,
        provider: args.provider,
        model: args.model,
        status: args.status,
        dryRun: true,
        applied: false,
      },
    });
  });
  return runId;
}

// GET /admin/ai/fix-agent/health
router.get("/admin/ai/fix-agent/health", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const cfg = getFixAgentConfig();
  let providerConfigured = false;
  try {
    providerConfigured = getAIProvider(cfg.provider).isConfigured();
  } catch {
    providerConfigured = false;
  }
  res.json({
    ok: true,
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    provider: cfg.provider,
    model: cfg.model,
    providerConfigured,
  });
});

type Runner =
  | { mode: "diagnose"; run: typeof diagnose }
  | { mode: "propose_patch"; run: typeof proposePatch };

async function handleRun(req: Request, res: Response, runner: Runner): Promise<void> {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const cfg = getFixAgentConfig();
  if (!cfg.enabled) {
    res.status(409).json({ ok: false, error: "FIX_AGENT_DISABLED" });
    return;
  }

  const input = parseBody(req);
  if (!input) {
    res.status(400).json({ ok: false, error: "errorText is required" });
    return;
  }

  // Provider availability is a 409 (config) not a 500 (runtime).
  let providerConfigured = false;
  try {
    providerConfigured = getAIProvider(cfg.provider).isConfigured();
  } catch {
    providerConfigured = false;
  }
  if (!providerConfigured) {
    res.status(409).json({ ok: false, error: "PROVIDER_NOT_CONFIGURED" });
    return;
  }

  let result: unknown;
  let meta: FixAgentCallMeta;
  try {
    const out = runner.mode === "diagnose" ? await runner.run(input) : await runner.run(input);
    result = out.result;
    meta = out.meta;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "PROVIDER_ERROR";
    logError(req, { err: reason, mode: runner.mode }, "ai_fix_agent_run_failed");
    // Fail-closed: a provider failure MUST still record a status="failed" run +
    // audit row. If that persistence itself fails we cannot leave the failure
    // unrecorded, so we surface a 500 (persist failure) rather than masking it
    // behind the provider-error 502.
    try {
      await persistRun({
        admin,
        mode: runner.mode,
        area: input.area && input.area.length ? input.area : "other",
        provider: cfg.provider,
        model: cfg.model,
        status: "failed",
        inputRedacted: { area: input.area ?? "other" },
        output: null,
        errorReason: reason.slice(0, 500),
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
      });
    } catch (persistErr) {
      logError(req, { err: (persistErr as Error).message }, "ai_fix_agent_failed_persist_error");
      res.status(500).json({ ok: false, error: "FIX_AGENT_PERSIST_FAILED" });
      return;
    }
    res.status(502).json({ ok: false, error: "FIX_AGENT_PROVIDER_ERROR" });
    return;
  }

  let runId = 0;
  try {
    runId = await persistRun({
      admin,
      mode: runner.mode,
      area: meta.sanitized.area,
      provider: meta.provider,
      model: meta.model,
      status: "completed",
      inputRedacted: meta.sanitized,
      output: result,
      errorReason: null,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      latencyMs: meta.latencyMs,
    });
  } catch (persistErr) {
    // Fail-closed: if we cannot record the run + audit, do not return the result.
    logError(req, { err: (persistErr as Error).message }, "ai_fix_agent_persist_error");
    res.status(500).json({ ok: false, error: "FIX_AGENT_PERSIST_FAILED" });
    return;
  }

  res.json({
    ok: true,
    runId,
    mode: runner.mode,
    provider: meta.provider,
    model: meta.model,
    dryRun: true,
    result,
    usage: {
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      latencyMs: meta.latencyMs,
    },
  });
}

// POST /admin/ai/fix-agent/diagnose
router.post("/admin/ai/fix-agent/diagnose", (req, res) => {
  void handleRun(req, res, { mode: "diagnose", run: diagnose });
});

// POST /admin/ai/fix-agent/propose-patch
router.post("/admin/ai/fix-agent/propose-patch", (req, res) => {
  void handleRun(req, res, { mode: "propose_patch", run: proposePatch });
});

// Backend-area enum mirrored from the OpenAPI FixAgentRecentError.area enum.
type FixAgentArea =
  | "mt5_bridge"
  | "live_pipeline"
  | "market_data"
  | "api_routes"
  | "database"
  | "auth"
  | "frontend"
  | "other";

// Best-effort area hint inferred from a route/action label. Purely advisory —
// the admin can change the area in the form before diagnosing.
function inferArea(action: string | null | undefined): FixAgentArea {
  const a = (action ?? "").toLowerCase();
  if (a.includes("/bridge") || a.includes("/mt5")) return "mt5_bridge";
  if (a.includes("/live")) return "live_pipeline";
  if (
    a.includes("/data/candles") ||
    a.includes("/market") ||
    a.includes("/chart") ||
    a.includes("/scanner")
  ) {
    return "market_data";
  }
  if (a.includes("/auth") || a.includes("/login") || a.includes("/session")) return "auth";
  if (a.includes("/api/")) return "api_routes";
  return "other";
}

// Build the pre-filled diagnose text for a failing request. Contains only the
// method/route/status/timing already captured in the perf ring buffer — no
// secrets, tokens, bodies, or identifiers beyond a numeric user id. The diagnose
// endpoint still re-runs server-side redaction on whatever is submitted.
function buildRecentErrorText(row: PerfRow): string {
  const method = row.method ? `${row.method} ` : "";
  const route = row.action ?? "(unknown route)";
  const when = new Date(row.recordedAt).toISOString();
  const status = typeof row.status === "number" ? row.status : "unknown";
  const userPart = typeof row.userId === "number" ? `, user #${row.userId}` : "";
  return `HTTP ${status} on ${method}${route} (${row.totalMs}ms${userPart}), recorded ${when}.`;
}

// GET /admin/ai/fix-agent/recent-errors
//
// Recent server-side requests that returned an error status (HTTP >= 400),
// read from the in-process perf ring buffer (newest first). Each entry carries
// a ready-to-diagnose errorText. Live in-memory signal only — does not persist
// across restarts and is NOT a full deployment-log archive.
router.get("/admin/ai/fix-agent/recent-errors", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
  // Read the whole buffer, then keep only failing server requests, newest first.
  const rows = readRecentPerf({ limit: 1024 });
  const errors = rows
    .filter((r) => r.source === "server" && typeof r.status === "number" && r.status >= 400)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      recordedAt: r.recordedAt,
      method: r.method ?? null,
      action: r.action ?? null,
      status: r.status as number,
      totalMs: r.totalMs,
      area: inferArea(r.action),
      errorText: buildRecentErrorText(r),
    }));
  res.json({ ok: true, count: errors.length, errors });
});

// GET /admin/ai/fix-agent/runs
router.get("/admin/ai/fix-agent/runs", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
  const rows = await db
    .select()
    .from(aiFixAgentRunsTable)
    .orderBy(desc(aiFixAgentRunsTable.id))
    .limit(limit);
  const runs = rows.map((r) => ({
    id: r.id,
    adminId: r.adminId,
    adminRole: r.adminRole,
    mode: r.mode,
    area: r.area,
    provider: r.provider,
    model: r.model,
    dryRun: r.dryRun,
    applied: r.applied,
    status: r.status,
    errorReason: r.errorReason,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  }));
  res.json({ ok: true, count: runs.length, runs });
});

export default router;
