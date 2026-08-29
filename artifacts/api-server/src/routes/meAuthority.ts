// Capability #37 — the unified authority surface (/api/me/authority/*).
//
// ONE place where scoped, expiring automation authority is declared and read:
//   GET  /me/authority                  — effective ceilings + the grant ledger
//   POST /me/authority/grants           — owner-press grant (mandatory expiry)
//   POST /me/authority/grants/:publicId/revoke — instant reduction
//
// Grants only govern the caller's OWN account (userId = req.authUser.id): the
// authenticated press IS the owner press for per-user automation. Expiry and
// reduction are automatic (read-time resolution + the expiry sweep worker);
// nothing here can raise a persisted ladder level — grants only permit a later
// explicit raise through the existing gated seams.

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  AUTHORITY_KINDS,
  AUTHORITY_SCOPES,
  AUTHORITY_BASELINES,
  AUTHORITY_LEVEL_MAX,
  MAX_GRANT_DURATION_MS,
  resolveAuthorityCeiling,
  isGrantActive,
  type AuthorityKind,
} from "@workspace/domain/safety-contracts/authorityGrants";
import {
  createAuthorityGrant,
  revokeAuthorityGrant,
  listAuthorityGrants,
} from "../lib/authority/authorityService.js";
import { shadowCaptureFAF } from "../lib/auditVault.js";

const router = Router();

function serializeGrant(g: {
  publicId: string; kind: string; scopeType: string; scopeRef: string | null;
  maxLevel: number; reason: string | null; grantedAt: Date; expiresAt: Date;
  revokedAt: Date | null;
}, now: Date) {
  return {
    publicId: g.publicId,
    kind: g.kind,
    scopeType: g.scopeType,
    scopeRef: g.scopeRef,
    maxLevel: g.maxLevel,
    reason: g.reason,
    grantedAt: g.grantedAt.toISOString(),
    expiresAt: g.expiresAt.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
    active: isGrantActive(g, now),
  };
}

// ── GET /me/authority ───────────────────────────────────────────────────────
router.get("/me/authority", requireUser, async (req, res) => {
  try {
    const now = new Date();
    const grants = await listAuthorityGrants(req.authUser!.id);
    const effective = (AUTHORITY_KINDS as readonly AuthorityKind[]).map((kind) => {
      const ceiling = resolveAuthorityCeiling({ kind, now, grants });
      return {
        kind,
        baseline: AUTHORITY_BASELINES[kind],
        ladderMax: AUTHORITY_LEVEL_MAX[kind],
        accountCeiling: ceiling.ceiling,
        source: ceiling.source,
        expiresAt: ceiling.expiresAt?.toISOString() ?? null,
        reasons: ceiling.reasons,
      };
    });
    res.json({
      effective,
      grants: grants.map((g) => serializeGrant(g, now)),
      maxGrantDurationMs: MAX_GRANT_DURATION_MS,
      scopes: AUTHORITY_SCOPES,
      note: "Grants only permit later explicit raises through the existing gated seams; expiry and revocation reduce automatically.",
    });
  } catch (err) {
    req.log.error(err);
    // Honest degraded read: the ledger being unreadable is reported, never
    // papered over with an empty-but-confident response.
    res.status(503).json({ error: "AUTHORITY_LEDGER_UNREADABLE" });
  }
});

// ── POST /me/authority/grants — the owner press ─────────────────────────────
const CreateGrantBody = z.object({
  kind: z.enum(AUTHORITY_KINDS),
  scopeType: z.enum(AUTHORITY_SCOPES),
  scopeRef: z.string().min(1).max(200).optional(),
  maxLevel: z.number().int(),
  expiresAt: z.string().datetime(),
  reason: z.string().max(500).optional(),
});

router.post("/me/authority/grants", requireUser, async (req, res) => {
  const parsed = CreateGrantBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_GRANT_REQUEST", issues: parsed.error.issues });
    return;
  }
  try {
    const now = new Date();
    const result = await createAuthorityGrant({
      userId: req.authUser!.id,
      grantedByUserId: req.authUser!.id,
      kind: parsed.data.kind,
      scopeType: parsed.data.scopeType,
      scopeRef: parsed.data.scopeRef ?? null,
      maxLevel: parsed.data.maxLevel,
      expiresAt: new Date(parsed.data.expiresAt),
      reason: parsed.data.reason ?? null,
      now,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    shadowCaptureFAF({
      eventType: "AUTHORITY_GRANT_CREATED",
      source: "authority-ledger",
      severity: "WARN", // an authority raise is always worth noticing
      systemMode: null,
      globalState: null,
      payload: {
        userId: req.authUser!.id,
        publicId: result.grant.publicId,
        kind: result.grant.kind,
        scopeType: result.grant.scopeType,
        scopeRef: result.grant.scopeRef,
        maxLevel: result.grant.maxLevel,
        expiresAt: result.grant.expiresAt.toISOString(),
      },
    });
    res.status(201).json({ grant: serializeGrant(result.grant, now) });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "AUTHORITY_LEDGER_UNREADABLE" });
  }
});

// ── POST /me/authority/grants/:publicId/revoke — instant reduction ──────────
router.post("/me/authority/grants/:publicId/revoke", requireUser, async (req, res) => {
  const publicId = String(req.params.publicId ?? "");
  if (!/^ag_[0-9a-f-]{36}$/.test(publicId)) {
    res.status(400).json({ error: "INVALID_GRANT_ID" });
    return;
  }
  try {
    const now = new Date();
    const result = await revokeAuthorityGrant({
      userId: req.authUser!.id,
      publicId,
      revokedByUserId: req.authUser!.id,
      now,
    });
    if (!result.ok) {
      res.status(result.reason === "NOT_FOUND" ? 404 : 409).json({ error: result.reason });
      return;
    }
    shadowCaptureFAF({
      eventType: "AUTHORITY_GRANT_REVOKED",
      source: "authority-ledger",
      severity: "INFO",
      systemMode: null,
      globalState: null,
      payload: { userId: req.authUser!.id, publicId },
    });
    res.json({ grant: serializeGrant(result.grant, now) });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "AUTHORITY_LEDGER_UNREADABLE" });
  }
});

export default router;
