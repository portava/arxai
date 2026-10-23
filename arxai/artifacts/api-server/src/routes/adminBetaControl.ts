// Phase Private-Beta-10 / Registration Key Shield — Admin Beta Control Center API.
// All endpoints are ADMIN/OWNER only. Per-user-isolation N/A (admin surface).
// Registration Key endpoints: /admin/registration-keys/*
// Legacy beta invite endpoints: /admin/beta/* (preserved)
// No secrets returned. No live-trading surface touched.

import { Router, type Request, type Response } from "express";
import { betaInvitesRepo, joinRequestsRepo } from "@workspace/db";
type RegistrationKeyRoleGrant = "USER" | "INVESTOR" | "ADMIN";
const {
  MAX_COHORT_SIZE,
  countActiveInvites,
  createInvite,
  createRegistrationKey,
  createRegistrationKeys,
  listInvites,
  listRegistrationKeys,
  revokeInvite,
  revokeUnusedKey,
  updateUnusedKeyExpiry,
  sweepExpiredPendingKeys,
  pauseInvite,
  resumeInvite,
  toPublicInvite,
  isBetaInviteGateEnabled,
  isRegistrationKeyPepperConfigured,
  getRecentBlockedAttempts,
  maskArxKey,
  listExpiringPendingKeys,
  daysUntilExpiry,
} = betaInvitesRepo;
type JoinRequestStatus = "PENDING" | "APPROVED" | "DECLINED";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { enforceSensitiveAction } from "../lib/security/handshake.js";
import { runExpiringKeysDigest, WINDOW_DAYS } from "../lib/registrationKeys/expiringKeysDigestWorker.js";

const router = Router();

// ── Auth guard ────────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  const role = String(u.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin or Owner role required." });
    return null;
  }
  return { id: u.id, role: role as "ADMIN" | "OWNER" };
}

// ── Audit helper ──────────────────────────────────────────────────────────

async function safeAudit(req: Request, eventType: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const eventId = randomBytes(12).toString("hex");
    const ts = new Date().toISOString();
    const body = JSON.stringify({ source: "admin-beta-control", eventType, payload, ts });
    const checksum = createHash("sha256").update(body).digest("hex");
    await db.execute(sql`
      INSERT INTO audit_events (event_id, timestamp, event_type, source, severity, payload, checksum, schema_version)
      VALUES (${eventId}, ${ts}, ${eventType}, 'admin-beta-control', 'INFO', ${JSON.stringify(payload)}::jsonb, ${checksum}, 1)
    `);
  } catch (e) {
    (req as unknown as { log?: { warn?: (o: object, m: string) => void } }).log?.warn?.({ err: String(e) }, "beta-control audit log failed");
  }
}

// ── Legacy cohort endpoint ────────────────────────────────────────────────

router.get("/admin/beta/cohort", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const [invites, active, blockedAttempts] = await Promise.all([
    listInvites(),
    countActiveInvites(),
    getRecentBlockedAttempts(20),
  ]);
  const byStatus: Record<string, number> = {};
  let expiredCount = 0;
  const now = Date.now();
  for (const r of invites) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.expiresAt && r.expiresAt.getTime() < now && r.status === "PENDING") expiredCount += 1;
  }
  const lastAccepted = invites
    .filter((r) => r.acceptedAt)
    .sort((a, b) => (b.acceptedAt!.getTime() - a.acceptedAt!.getTime()))[0];
  res.json({
    cohort: "ARX_PRIVATE_BETA_10",
    maxCohortSize: MAX_COHORT_SIZE,
    activeCount: active,
    seatsRemaining: Math.max(0, MAX_COHORT_SIZE - active),
    waitlistActive: active >= MAX_COHORT_SIZE,
    byStatus,
    expiredPendingCount: expiredCount,
    inviteGateEnabled: isBetaInviteGateEnabled(),
    registrationKeyPepperConfigured: isRegistrationKeyPepperConfigured(),
    lastAcceptedAt: lastAccepted?.acceptedAt ?? null,
    lastAcceptedEmail: lastAccepted?.email ?? null,
    arxLiveCommandsCount: 0,
    blockedAttempts,
    invites: invites.map(toPublicInvite),
  });
});

// ── Legacy invite creation (email required, cap enforced) ─────────────────

router.post("/admin/beta/invites", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("ISSUE_INVITE", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ error: hs.reasonCode, message: hs.userMessage }); return; }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const accountMode = (req.body?.accountMode ?? "DEMO_TESTER") as "DEMO_TESTER" | "PERSONAL_MT5" | "SHARED_MASTER_REVIEW";
  const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "INVALID_EMAIL" }); return;
  }
  if (!["DEMO_TESTER", "PERSONAL_MT5", "SHARED_MASTER_REVIEW"].includes(accountMode)) {
    res.status(400).json({ error: "INVALID_ACCOUNT_MODE" }); return;
  }
  // Fail closed BEFORE issuing: validation (validateInviteForRegistration /
  // acceptInviteTx) refuses every code with PEPPER_MISSING when the pepper is
  // absent, so issuing here would hand out a credential that can never be
  // redeemed. Mirror the registration-key generator's refusal instead.
  if (!isRegistrationKeyPepperConfigured()) {
    res.status(503).json({
      error: "PEPPER_MISSING",
      message: "REGISTRATION_KEY_PEPPER is not configured. Set this environment variable to enable invite creation.",
    });
    return;
  }
  const result = await createInvite({ email, accountMode, invitedByUserId: admin.id, notes });
  if (!result.ok) {
    await safeAudit(req, "beta_invite_blocked", { email, reason: result.error, activeCount: result.activeCount, adminId: admin.id });
    res.status(409).json({ error: result.error, activeCount: result.activeCount, maxCohortSize: MAX_COHORT_SIZE });
    return;
  }
  await safeAudit(req, "beta_invite_created", { email, accountMode, inviteId: result.invite.id, adminId: admin.id });
  res.status(201).json({
    invite: toPublicInvite(result.invite),
    rawCode: result.rawCode,
    rawCodeNotice: "This code is shown ONCE. Copy it now — it cannot be recovered later.",
  });
});

router.post("/admin/beta/invites/:id/revoke", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }
  const row = await revokeInvite(id, admin.id);
  if (!row) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  await safeAudit(req, "beta_invite_revoked", { inviteId: id, adminId: admin.id });
  res.json({ invite: toPublicInvite(row) });
});

router.post("/admin/beta/invites/:id/pause", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }
  const row = await pauseInvite(id);
  // Only an ACCEPTED invite may be paused (see pauseInvite). A bare NOT_FOUND
  // would hide that the row exists but is REVOKED/EXPIRED/PENDING, which is the
  // exact case an admin needs to see.
  if (!row) { res.status(404).json({ error: "NOT_FOUND_OR_NOT_ACCEPTED" }); return; }
  await safeAudit(req, "beta_invite_paused", { inviteId: id, adminId: admin.id });
  res.json({ invite: toPublicInvite(row) });
});

router.post("/admin/beta/invites/:id/resume", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }
  const row = await resumeInvite(id);
  if (!row) { res.status(404).json({ error: "NOT_FOUND_OR_NOT_PAUSED" }); return; }
  await safeAudit(req, "beta_invite_resumed", { inviteId: id, adminId: admin.id });
  res.json({ invite: toPublicInvite(row) });
});

// ── Registration Keys endpoints ────────────────────────────────────────────

const VALID_ROLE_GRANTS: RegistrationKeyRoleGrant[] = ["USER", "INVESTOR", "ADMIN"];

/** GET /admin/registration-keys — list with optional filters. Never returns raw keys or hashes. */
router.get("/admin/registration-keys", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const statusParam = String(req.query["status"] ?? "").toUpperCase();
  const status = (["PENDING", "ACCEPTED", "REVOKED", "PAUSED", "EXPIRED"].includes(statusParam) ? statusParam : undefined) as betaInvitesRepo.InviteStatus | undefined;
  const assignedEmail = req.query["email"] ? String(req.query["email"]).trim().toLowerCase() : undefined;
  const search = req.query["search"] ? String(req.query["search"]).trim().slice(0, 100) : undefined;
  const createdByUserId = req.query["createdBy"] ? Number(req.query["createdBy"]) : undefined;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const offset = Math.max(Number(req.query["offset"] ?? 0), 0);

  const keys = await listRegistrationKeys({ status, assignedEmail, search, createdByUserId, limit, offset });
  // Count by status for UI summary
  const countRows = await db.execute(sql`SELECT status, COUNT(*)::int AS c FROM beta_invites GROUP BY status`);
  const countData = ((countRows as unknown as { rows?: Array<{ status: string; c: number }> }).rows
    ?? (countRows as unknown as Array<{ status: string; c: number }>)) ?? [];
  const byStatus: Record<string, number> = {};
  for (const r of countData) byStatus[r.status] = Number(r.c);

  res.json({
    keys: keys.map(toPublicInvite),
    byStatus,
    total: keys.length,
    pepperConfigured: isRegistrationKeyPepperConfigured(),
  });
});

/** POST /admin/registration-keys/generate — generate one or many ARX-format keys. */
router.post("/admin/registration-keys/generate", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("ISSUE_INVITE", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ error: hs.reasonCode, message: hs.userMessage }); return; }

  if (!isRegistrationKeyPepperConfigured()) {
    res.status(503).json({
      error: "PEPPER_MISSING",
      message: "REGISTRATION_KEY_PEPPER is not configured. Set this environment variable to enable key generation.",
    });
    return;
  }

  const rawCount = req.body?.count;
  const count = rawCount === undefined ? 1 : Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    res.status(400).json({ error: "INVALID_COUNT", message: "count must be an integer between 1 and 100." });
    return;
  }

  const emailRaw = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    res.status(400).json({ error: "INVALID_EMAIL" }); return;
  }

  const roleGrantRaw = req.body?.roleGrant ? String(req.body.roleGrant).toUpperCase() : null;
  if (roleGrantRaw && !VALID_ROLE_GRANTS.includes(roleGrantRaw as RegistrationKeyRoleGrant)) {
    res.status(400).json({ error: "INVALID_ROLE_GRANT", message: `roleGrant must be one of: ${VALID_ROLE_GRANTS.join(", ")}` });
    return;
  }
  // ADMIN cannot grant ADMIN
  if (roleGrantRaw === "ADMIN" && admin.role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Only OWNER may grant the ADMIN role via a registration key." });
    return;
  }

  const roleGrant = roleGrantRaw as RegistrationKeyRoleGrant | null;
  const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;
  const expiresInDays = req.body?.expiresInDays !== undefined
    ? (req.body.expiresInDays === null ? null : Number(req.body.expiresInDays))
    : null;
  if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
    res.status(400).json({ error: "INVALID_EXPIRY", message: "expiresInDays must be 1–3650 or null (no expiry)." });
    return;
  }

  const result = await createRegistrationKeys({
    count,
    email: emailRaw,
    roleGrant,
    invitedByUserId: admin.id,
    invitedByRole: admin.role,
    notes,
    expiresInDays,
  });

  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  await safeAudit(req, "registration_keys_generated", {
    count,
    email: emailRaw ?? null,
    roleGrant: roleGrant ?? null,
    notes: notes ?? null,
    expiresInDays: expiresInDays ?? null,
    adminId: admin.id,
    keyIds: result.keys.map((k) => k.id),
  });

  res.status(201).json({
    // rawKeys shown EXACTLY ONCE. Not stored; cannot be recovered.
    keys: result.keys.map((k) => ({
      id: k.id,
      rawKey: k.rawKey,
      keyPrefix: k.keyPrefix,
      maskedKey: maskArxKey(k.keyPrefix),
    })),
    rawKeyNotice: "Raw registration keys are shown ONCE. Save them now — they cannot be recovered later.",
    count: result.keys.length,
    email: emailRaw ?? null,
    roleGrant: roleGrant ?? "USER",
    expiresInDays: expiresInDays ?? null,
  });
});

/** POST /admin/registration-keys/:id/revoke — revoke an unused key. Used/expired cannot be revoked. */
router.post("/admin/registration-keys/:id/revoke", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("REVOKE_KEY", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ error: hs.reasonCode, message: hs.userMessage }); return; }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }

  const result = await revokeUnusedKey(id, admin.id);
  if (!result.ok) {
    const status = result.error === "NOT_FOUND" ? 404 : 409;
    res.status(status).json({ error: result.error });
    return;
  }
  await safeAudit(req, "registration_key_revoked", { inviteId: id, adminId: admin.id });
  res.json({ key: toPublicInvite(result.row) });
});

/** POST /admin/registration-keys/:id/expiry — set, extend, or clear the expiry on an
 *  unused key. Body: { expiresInDays: number(1–3650) | null }. null clears (no expiry).
 *  ACCEPTED/REVOKED/PAUSED/expired keys are refused. No secrets returned; audited. */
router.post("/admin/registration-keys/:id/expiry", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("UPDATE_KEY_EXPIRY", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ error: hs.reasonCode, message: hs.userMessage }); return; }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }

  if (req.body?.expiresInDays === undefined) {
    res.status(400).json({ error: "INVALID_EXPIRY", message: "expiresInDays is required: an integer 1–3650, or null to clear (no expiry)." });
    return;
  }
  const expiresInDays = req.body.expiresInDays === null ? null : Number(req.body.expiresInDays);
  if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
    res.status(400).json({ error: "INVALID_EXPIRY", message: "expiresInDays must be an integer 1–3650 or null (no expiry)." });
    return;
  }
  const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const result = await updateUnusedKeyExpiry(id, expiresAt, admin.id);
  if (!result.ok) {
    const status = result.error === "NOT_FOUND" ? 404 : 409;
    res.status(status).json({ error: result.error });
    return;
  }
  await safeAudit(req, "registration_key_expiry_updated", {
    inviteId: id, adminId: admin.id,
    expiresInDays: expiresInDays ?? null,
    newExpiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
  res.json({ key: toPublicInvite(result.row) });
});

/** POST /admin/registration-keys/sweep-expired — manually run the expired-key
 *  sweep. The scheduled worker also runs this hourly; this endpoint lets an admin
 *  force it on demand. Idempotent (a no-op when nothing has lapsed) and audited
 *  (the repository writes its own evidence row; this records the admin actor). */
router.post("/admin/registration-keys/sweep-expired", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const result = await sweepExpiredPendingKeys();
  await safeAudit(req, "registration_keys_expired_swept_manual", {
    adminId: admin.id, marked: result.marked, scanned: result.scanned, ids: result.ids,
  });
  res.json({ marked: result.marked, scanned: result.scanned });
});

/** GET /admin/registration-keys/expiring-soon — the in-app twin of the email
 *  digest. Reuses the SAME query (`listExpiringPendingKeys`), window
 *  (`WINDOW_DAYS`), masking (`maskArxKey`) and whole-days math
 *  (`daysUntilExpiry`) the scheduled digest uses, so the dashboard list and the
 *  emailed digest are always in exact parity. PENDING keys only, soonest-first,
 *  masked. Never returns raw keys or hashes. */
router.get("/admin/registration-keys/expiring-soon", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const now = new Date();
  const keys = await listExpiringPendingKeys(WINDOW_DAYS, now);
  const items = keys.map((k) => ({
    id: k.id,
    maskedKey: maskArxKey(k.keyPrefix),
    daysLeft: daysUntilExpiry(k.expiresAt, now),
    assignedEmail: k.email,
    roleGrant: k.roleGrant ?? null,
    expiresAt: k.expiresAt.toISOString(),
  }));
  res.json({ windowDays: WINDOW_DAYS, total: items.length, items });
});

/** POST /admin/registration-keys/send-digest — admin-triggered "send digest
 *  now". Runs the SAME worker entrypoint the scheduler uses
 *  (`runExpiringKeysDigest`) with force=true so it bypasses the hour/per-day
 *  gates but still honours the no-noise rule (sends nothing when nothing is
 *  expiring). Audited. Returns the structured worker result. */
router.post("/admin/registration-keys/send-digest", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const result = await runExpiringKeysDigest({ force: true });
  await safeAudit(req, "registration_keys_digest_sent_manual", {
    adminId: admin.id,
    delivered: result.delivered,
    recipients: result.recipients,
    expiringCount: result.expiringCount,
    skipped: result.skipped ?? null,
  });
  res.json(result);
});

// ── Request-to-Join queue (ADMIN/OWNER only) ──────────────────────────────

router.get("/admin/join-requests", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const statusParam = String(req.query["status"] ?? "").toUpperCase();
  const status = (["PENDING", "APPROVED", "DECLINED"].includes(statusParam)
    ? statusParam
    : undefined) as JoinRequestStatus | undefined;
  const [requests, byStatus] = await Promise.all([
    joinRequestsRepo.listRequests(status),
    joinRequestsRepo.countByStatus(),
  ]);
  res.json({
    byStatus,
    pendingCount: byStatus["PENDING"] ?? 0,
    requests: requests.map(joinRequestsRepo.toPublicJoinRequest),
  });
});

router.post("/admin/join-requests/:id/approve", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("APPROVE_USER", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ error: hs.reasonCode, message: hs.userMessage }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }
  const accountMode = (req.body?.accountMode ?? "DEMO_TESTER") as "DEMO_TESTER" | "PERSONAL_MT5" | "SHARED_MASTER_REVIEW";
  if (!["DEMO_TESTER", "PERSONAL_MT5", "SHARED_MASTER_REVIEW"].includes(accountMode)) {
    res.status(400).json({ error: "INVALID_ACCOUNT_MODE" }); return;
  }
  const request = await joinRequestsRepo.getById(id);
  if (!request) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  if (request.status !== "PENDING") {
    res.status(409).json({ error: "NOT_PENDING", status: request.status }); return;
  }
  const invite = await createInvite({
    email: request.email,
    accountMode,
    invitedByUserId: admin.id,
    notes: request.note ? `Join request #${request.id}: ${request.note}`.slice(0, 500) : `Join request #${request.id}`,
  });
  if (!invite.ok) {
    await safeAudit(req, "join_request_approve_blocked", { requestId: id, reason: invite.error, adminId: admin.id });
    res.status(409).json({ error: invite.error, activeCount: invite.activeCount, maxCohortSize: MAX_COHORT_SIZE });
    return;
  }
  const approved = await joinRequestsRepo.markApproved({ id, decidedByUserId: admin.id, inviteId: invite.invite.id });
  if (!approved) {
    try {
      await revokeInvite(invite.invite.id, admin.id);
    } catch (revokeErr) {
      await safeAudit(req, "join_request_approve_orphan_invite", {
        requestId: id, inviteId: invite.invite.id, email: request.email, adminId: admin.id,
        reason: "CAS lost after createInvite; automatic revoke failed — manual revoke required",
        error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
      });
    }
    res.status(409).json({ error: "NOT_PENDING" });
    return;
  }
  await safeAudit(req, "join_request_approved", { requestId: id, inviteId: invite.invite.id, email: request.email, accountMode, adminId: admin.id });
  res.status(201).json({
    request: joinRequestsRepo.toPublicJoinRequest(approved),
    invite: toPublicInvite(invite.invite),
    rawCode: invite.rawCode,
    rawCodeNotice: "This code is shown ONCE. Copy it now — it cannot be recovered later.",
  });
});

router.post("/admin/join-requests/:id/decline", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "INVALID_ID" }); return; }
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ error: "REASON_REQUIRED", message: "A decline reason of at least 3 characters is required." }); return; }
  const declined = await joinRequestsRepo.markDeclined({ id, decidedByUserId: admin.id, reason });
  if (!declined) { res.status(409).json({ error: "NOT_FOUND_OR_NOT_PENDING" }); return; }
  await safeAudit(req, "join_request_declined", { requestId: id, reason, adminId: admin.id });
  res.json({ request: joinRequestsRepo.toPublicJoinRequest(declined) });
});

export default router;
