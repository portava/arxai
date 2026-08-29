// Admin — Risk Templates CRUD
//
// Routes:
//   GET    /api/admin/risk-templates              — list
//   POST   /api/admin/risk-templates              — create
//   PUT    /api/admin/risk-templates/:id          — update
//   POST   /api/admin/risk-templates/:id/archive  — soft-delete
//
// SAFETY:
//   - Every handler is requireAdmin.
//   - Template payload CANNOT contain `liveTradingApproved` or
//     `sharedBridgeApproved`. Those two flags are intentionally not
//     part of the payload type — they are granted per-user with typed
//     confirmation on the dedicated endpoints.
//   - Mutations are audited via `admin_action_audit_log`.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  riskTemplatesTable,
  adminActionAuditLogTable,
  type RiskTemplatePayload,
} from "@workspace/db";
import { requireLifecycleRole } from "../lib/security/lifecycleRoleGate.js";

const router: IRouter = Router();
router.use(express.json());

// Capability #51 — risk-template mutations are the RISK_APPROVER's act. Once
// separation-of-duties is configured (any lifecycle grant exists), only a
// RISK_APPROVER grant-holder may create/update/archive templates; until then
// the gate logs a loud pass-through and requireAdmin below still applies.

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
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

async function tryAudit(req: Request, args: {
  adminId: number; adminRole: string; action: string;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
  targetUserId?: number | null;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.adminId,
      adminRole: args.adminRole,
      action: args.action,
      targetUserId: args.targetUserId ?? null,
      beforeState: (args.before ?? {}) as Record<string, unknown>,
      afterState: (args.after ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    (req as Request & { log?: { warn: (o: unknown, m?: string) => void } }).log?.warn(
      { err: (err as Error).message, action: args.action },
      "admin_risk_templates_audit_write_failed",
    );
  }
}

// Payload validator — explicitly does NOT include liveTradingApproved or
// sharedBridgeApproved. Anyone trying to push those through will get a
// 400 from this Zod schema.
const payloadSchema = z.object({
  maxLotSize: z.number().positive().nullable().optional(),
  maxDailyLossUsd: z.number().nonnegative().nullable().optional(),
  maxOpenTrades: z.number().int().min(1).max(1000).nullable().optional(),
  maxExposurePerSymbolLots: z.number().positive().nullable().optional(),
  minRewardRiskRatio: z.number().positive().nullable().optional(),
  allowedSymbols: z.array(z.string().max(32)).max(100).optional(),
  blockedSymbols: z.array(z.string().max(32)).max(100).optional(),
  stopLossRequired: z.boolean().optional(),
  takeProfitRequired: z.boolean().optional(),
  oneClickTradingEnabled: z.boolean().optional(),
  aiTradingEnabled: z.boolean().optional(),
  aiAutoCloseEnabled: z.boolean().optional(),
  rubyVoiceEnabled: z.boolean().optional(),
  newsIntelligenceEnabled: z.boolean().optional(),
  historicalBacktestEnabled: z.boolean().optional(),
  scannerLiveEnabled: z.boolean().optional(),
  adminMemo: z.string().max(2000).optional(),
}).strict();

const createBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  payload: payloadSchema.default({}),
});
const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  payload: payloadSchema.optional(),
});

router.get("/admin/risk-templates", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const includeArchived = String(req.query.includeArchived ?? "false") === "true";
  const rows = await db.select().from(riskTemplatesTable)
    .orderBy(desc(riskTemplatesTable.updatedAt));
  return res.json({
    ok: true,
    templates: includeArchived ? rows : rows.filter((r) => !r.isArchived),
  });
});

router.post("/admin/risk-templates", requireLifecycleRole("RISK_APPROVER"), async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = createBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }
  try {
    const [row] = await db.insert(riskTemplatesTable).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      payload: parsed.data.payload as RiskTemplatePayload,
      createdBy: admin.id,
    }).returning();
    await tryAudit(req, {
      adminId: admin.id, adminRole: admin.role,
      action: "RISK_TEMPLATE_CREATED",
      after: { id: row!.id, name: row!.name, payload: row!.payload as Record<string, unknown> },
    });
    return res.json({ ok: true, template: row });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("risk_templates_name_uq") || msg.includes("duplicate")) {
      return res.status(409).json({ ok: false, error: "NAME_TAKEN" });
    }
    throw err;
  }
});

router.put("/admin/risk-templates/:id", requireLifecycleRole("RISK_APPROVER"), async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_ID" });
  }
  const parsed = updateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }
  const before = (await db.select().from(riskTemplatesTable).where(eq(riskTemplatesTable.id, id)).limit(1))[0];
  if (!before) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const patch: Partial<typeof riskTemplatesTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description;
  if (parsed.data.payload !== undefined) patch.payload = parsed.data.payload as RiskTemplatePayload;

  const [after] = await db.update(riskTemplatesTable)
    .set(patch).where(eq(riskTemplatesTable.id, id)).returning();
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: "RISK_TEMPLATE_UPDATED",
    before: { id: before.id, name: before.name, payload: before.payload as Record<string, unknown> },
    after: { id: after!.id, name: after!.name, payload: after!.payload as Record<string, unknown> },
  });
  return res.json({ ok: true, template: after });
});

router.post("/admin/risk-templates/:id/archive", requireLifecycleRole("RISK_APPROVER"), async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_ID" });
  }
  const [after] = await db.update(riskTemplatesTable)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(eq(riskTemplatesTable.id, id)).returning();
  if (!after) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: "RISK_TEMPLATE_ARCHIVED",
    after: { id: after.id, name: after.name },
  });
  return res.json({ ok: true, template: after });
});

export default router;
