// Capability #50 — Admin org / legal-entity structure surface.
//
// Routes (ADMIN/OWNER only):
//   GET  /api/admin/org-structure                        — hierarchy + links
//   POST /api/admin/org-structure/organizations          — create an org node
//   POST /api/admin/org-structure/links                  — link a layer object
//   POST /api/admin/org-structure/ownership-edges        — record ownership
//   GET  /api/admin/org-structure/consolidated-exposure  — the roll-up read
//   GET  /api/admin/org-structure/organizations/:id/owners — effective owners
//
// SAFETY / HONESTY:
//   * Structure only — nothing here reaches any execution, dispatch, or gate
//     surface. The consolidated-exposure endpoint is a READ.
//   * Vocabulary-validated: entityKind / layerKind / ownerKind / controlKind
//     must be in the closed sets from the schema; strangers are 400s.
//   * Cycles cannot be persisted through this surface: a NEW org with an
//     existing parent can never create one, and RE-PARENTING is deliberately
//     not offered (it would need the pure cycle check before write). The
//     read path still runs buildOrgHierarchy and refuses (409) if persisted
//     data is ever found cyclic — a cyclic hierarchy has no truthful roll-up.
//   * Mutations audited via admin_action_audit_log.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  organizationsTable,
  orgEntityLinksTable,
  beneficialOwnershipEdgesTable,
  adminActionAuditLogTable,
  ORG_ENTITY_KINDS,
  ORG_LINK_LAYER_KINDS,
  OWNERSHIP_OWNER_KINDS,
  OWNERSHIP_CONTROL_KINDS,
} from "@workspace/db";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import {
  getConsolidatedExposureView,
  getEffectiveOwnersOfOrg,
  getOrgHierarchy,
} from "../lib/institutional/consolidatedExposure.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: string } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = normalizeProductRole(sess.role);
  if (!isAdminProductRole(role)) {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

async function tryAudit(args: {
  adminId: number; adminRole: string; action: string;
  after?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.adminId,
      adminRole: args.adminRole,
      action: args.action,
      targetUserId: null,
      beforeState: {},
      afterState: (args.after ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err, action: args.action }, "admin_org_structure_audit_write_failed");
  }
}

// GET /api/admin/org-structure
router.get("/admin/org-structure", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const { hierarchy, readFailed } = await getOrgHierarchy();
  if (readFailed || hierarchy == null) {
    res.status(500).json({ ok: false, error: "HIERARCHY_READ_FAILED" });
    return;
  }
  if (!hierarchy.ok) {
    // Persisted data became invalid (should be prevented by the write path) —
    // reported honestly rather than rendered as an empty tree.
    res.status(409).json({ ok: false, error: "HIERARCHY_INVALID", detail: hierarchy });
    return;
  }
  res.json({
    ok: true,
    rootOrgIds: hierarchy.rootOrgIds,
    nodes: [...hierarchy.nodes.values()],
    danglingLinks: hierarchy.danglingLinks,
    vocab: {
      entityKinds: ORG_ENTITY_KINDS,
      layerKinds: ORG_LINK_LAYER_KINDS,
      ownerKinds: OWNERSHIP_OWNER_KINDS,
      controlKinds: OWNERSHIP_CONTROL_KINDS,
    },
  });
});

const createOrgSchema = z.object({
  name: z.string().min(1).max(256),
  entityKind: z.enum(ORG_ENTITY_KINDS),
  jurisdiction: z.string().min(1).max(64).nullable().optional(),
  registrationRef: z.string().min(1).max(128).nullable().optional(),
  parentOrgId: z.number().int().positive().nullable().optional(),
});

// POST /api/admin/org-structure/organizations
router.post("/admin/org-structure/organizations", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_ORG", detail: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  try {
    if (body.parentOrgId != null) {
      const [parent] = await db.select({ id: organizationsTable.id })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, body.parentOrgId)).limit(1);
      if (!parent) {
        res.status(422).json({ ok: false, error: "PARENT_ORG_NOT_FOUND" });
        return;
      }
      // A NEW node with an existing parent can never create a cycle (it has
      // no children yet); re-parenting an existing node would need the pure
      // cycle check — that mutation is intentionally not offered yet.
    }
    const [row] = await db.insert(organizationsTable).values({
      publicId: `org_${randomUUID()}`,
      name: body.name,
      entityKind: body.entityKind,
      jurisdiction: body.jurisdiction ?? null,
      registrationRef: body.registrationRef ?? null,
      parentOrgId: body.parentOrgId ?? null,
      createdByAdminId: admin.id,
    }).returning();
    await tryAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "ORG_STRUCTURE_CREATE_ORG",
      after: { orgId: row.id, name: row.name, entityKind: row.entityKind, parentOrgId: row.parentOrgId },
    });
    res.json({ ok: true, organization: row });
  } catch (err) {
    logger.warn({ err }, "admin_org_structure_create_org_failed");
    res.status(500).json({ ok: false, error: "ORG_WRITE_FAILED" });
  }
});

const createLinkSchema = z.object({
  orgId: z.number().int().positive(),
  layerKind: z.enum(ORG_LINK_LAYER_KINDS),
  layerRefId: z.number().int().positive(),
  label: z.string().min(1).max(256).nullable().optional(),
});

// POST /api/admin/org-structure/links
router.post("/admin/org-structure/links", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = createLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_LINK", detail: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  try {
    const [org] = await db.select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, body.orgId)).limit(1);
    if (!org) {
      res.status(422).json({ ok: false, error: "ORG_NOT_FOUND" });
      return;
    }
    const [row] = await db.insert(orgEntityLinksTable).values({
      orgId: body.orgId,
      layerKind: body.layerKind,
      layerRefId: body.layerRefId,
      label: body.label ?? null,
      createdByAdminId: admin.id,
    }).returning();
    await tryAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "ORG_STRUCTURE_LINK_LAYER",
      after: { linkId: row.id, orgId: row.orgId, layerKind: row.layerKind, layerRefId: row.layerRefId },
    });
    res.json({ ok: true, link: row });
  } catch (err) {
    // The (layerKind, layerRefId) unique index refuses double-linking one
    // object to two orgs — surfaced as a conflict, not a 500.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("org_entity_links_layer_object_uq") || msg.includes("org_entity_links_org_layer_uq")) {
      res.status(409).json({ ok: false, error: "LAYER_ALREADY_LINKED" });
      return;
    }
    logger.warn({ err }, "admin_org_structure_create_link_failed");
    res.status(500).json({ ok: false, error: "LINK_WRITE_FAILED" });
  }
});

const createEdgeSchema = z.object({
  ownerKind: z.enum(OWNERSHIP_OWNER_KINDS),
  ownerRefId: z.number().int().positive(),
  ownedOrgId: z.number().int().positive(),
  ownershipPct: z.number().min(0).max(100).nullable().optional(),
  controlKind: z.enum(OWNERSHIP_CONTROL_KINDS),
});

// POST /api/admin/org-structure/ownership-edges
router.post("/admin/org-structure/ownership-edges", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = createEdgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_EDGE", detail: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  if (body.ownerKind === "ORG" && body.ownerRefId === body.ownedOrgId) {
    res.status(422).json({ ok: false, error: "SELF_OWNERSHIP_REFUSED" });
    return;
  }
  try {
    const [owned] = await db.select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, body.ownedOrgId)).limit(1);
    if (!owned) {
      res.status(422).json({ ok: false, error: "OWNED_ORG_NOT_FOUND" });
      return;
    }
    const [row] = await db.insert(beneficialOwnershipEdgesTable).values({
      ownerKind: body.ownerKind,
      ownerRefId: body.ownerRefId,
      ownedOrgId: body.ownedOrgId,
      ownershipPct: body.ownershipPct ?? null,
      controlKind: body.controlKind,
      attestedBy: admin.id,
      attestedAt: new Date(),
    }).returning();
    await tryAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "ORG_STRUCTURE_OWNERSHIP_EDGE",
      after: {
        edgeId: row.id, ownerKind: row.ownerKind, ownerRefId: row.ownerRefId,
        ownedOrgId: row.ownedOrgId, ownershipPct: row.ownershipPct, controlKind: row.controlKind,
      },
    });
    res.json({ ok: true, edge: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("beneficial_ownership_edge_uq")) {
      res.status(409).json({ ok: false, error: "EDGE_ALREADY_EXISTS" });
      return;
    }
    logger.warn({ err }, "admin_org_structure_create_edge_failed");
    res.status(500).json({ ok: false, error: "EDGE_WRITE_FAILED" });
  }
});

// GET /api/admin/org-structure/consolidated-exposure
router.get("/admin/org-structure/consolidated-exposure", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const view = await getConsolidatedExposureView();
  res.json({ ok: true, ...view });
});

// GET /api/admin/org-structure/organizations/:id/owners
router.get("/admin/org-structure/organizations/:id/owners", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const orgId = Number(req.params["id"]);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_ORG_ID" });
    return;
  }
  const { result, readFailed } = await getEffectiveOwnersOfOrg(orgId);
  if (readFailed || result == null) {
    res.status(500).json({ ok: false, error: "OWNERSHIP_READ_FAILED" });
    return;
  }
  // result carries its own ok discriminator: ok:false = OWNERSHIP_CYCLE,
  // reported as a conflict rather than rendered as an empty owner list.
  if (!result.ok) {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

export default router;
