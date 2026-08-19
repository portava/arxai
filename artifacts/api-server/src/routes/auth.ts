// Auth + session endpoints.
//
// LAYER 1 — role cookie (`hr_session`) + dev `x-security-role` header. Drives
// OWNER/ADMIN/TESTER permission checks. Endpoints: /auth/session,
// /auth/permissions, /auth/roles, /auth/dev-owner-login, /auth/logout.
//
// LAYER 2 — per-user identity (`arx_user_session` cookie). Drives the new
// userId-scoped data isolation. Endpoints: /auth/register, /auth/login,
// /auth/user-logout, /me. Independent from LAYER 1 — they coexist.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, toPublicUser, betaInvitesRepo, joinRequestsRepo, passwordResetTokensRepo, passwordResetThrottleRepo } from "@workspace/db";
import { ForgotPasswordBody, ResetPasswordBody } from "@workspace/api-zod";
import { fireNotifyAdminsOfJoinRequest } from "../lib/joinRequests/notifyAdmins.js";
import { auditEvent } from "../lib/systemHealth/audit.js";
import {
  AUTH_ROLES, ALLOW_DEV_AUTH, IS_PROD, type AuthRole, buildMatrix, clearSessionCookie,
  getSessionFromReq, setSessionCookie,
} from "../lib/security/session.js";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import {
  createUserSession, destroyUserSession, destroyAllUserSessions, USER_SESSION_COOKIE,
} from "../lib/auth/userSessions.js";
import { requireUser } from "../lib/auth/middleware.js";
import { recordUserActivity } from "../lib/auth/activity.js";
import { sendPasswordResetEmail } from "../lib/email/passwordResetEmail.js";
import { isEmailNotConfiguredError } from "../lib/email/resend.js";
import { enforceSensitiveAction } from "../lib/security/handshake.js";
import { consumeRateLimit, hashScope } from "../lib/security/cooldowns.js";

const router = Router();

// Phase-7 durable cooldown helper. Counts ONE attempt against a public auth
// action keyed by source IP (hashed — never stored raw). Returns true when the
// caller is currently locked out. Fail-OPEN inside consumeRateLimit, so a DB
// blip never locks legitimate users out; this is defence-in-depth layered on
// top of the existing per-route protections (timing equalisation, throttle).
async function authCooldownTripped(
  req: import("express").Request,
  action: "LOGIN" | "FORGOT_PASSWORD" | "RESET_PASSWORD" | "REQUEST_ACCESS",
): Promise<boolean> {
  const decision = await consumeRateLimit(action, hashScope("ip", req.ip ?? "unknown"));
  return !decision.allowed;
}

// ── LAYER 1 (existing role cookie) ────────────────────────────────────────

router.get("/auth/session", (req, res) => {
  const s = getSessionFromReq(req);
  res.json({
    role: s.role, sessionId: s.sid, ts: s.ts,
    fullTesterAccess: s.role === "OWNER" || s.role === "ADMIN" || s.role === "TESTER",
    mt5Connected: false, mt5Deferred: true, realBrokerExecutionAvailable: false,
  });
});

router.get("/auth/permissions", (req, res) => {
  const s = getSessionFromReq(req);
  res.json(buildMatrix(s.role));
});

router.get("/auth/roles", (_req, res) => {
  res.json({
    roles: AUTH_ROLES.map((role) => ({ role, matrix: buildMatrix(role) })),
    note: "OWNER and ADMIN can activate full tester access. LOCKED denies all access. TESTER maps to DB-role TRADER for permission lookups.",
  });
});

router.post("/auth/dev-owner-login", async (req, res) => {
  if (IS_PROD && !ALLOW_DEV_AUTH) {
    await auditEvent({
      eventType: "AUTH_LOGIN_BLOCKED", severity: "HIGH", actor: "USER",
      action: "dev-owner-login blocked in production", sourceService: "auth",
      metadata: { reason: "ALLOW_DEV_AUTH not set" }, ipAddress: req.ip ?? null,
    }).catch(() => {});
    res.status(403).json({ allowed: false, reason: "dev-owner-login is disabled in production. Set ALLOW_DEV_AUTH=true to enable." });
    return;
  }
  const requested = String((req.body as { role?: string } | undefined)?.role ?? "OWNER").toUpperCase() as AuthRole;
  const role: AuthRole = (AUTH_ROLES as readonly string[]).includes(requested) ? requested : "OWNER";
  const s = setSessionCookie(res, role);
  await auditEvent({
    eventType: "AUTH_LOGIN", severity: "INFO", actor: "USER",
    action: `dev-owner-login as ${role}`, sourceService: "auth",
    metadata: { role, sessionId: s.sid }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json({ ok: true, role, sessionId: s.sid });
});

router.post("/auth/logout", async (req, res) => {
  const s = getSessionFromReq(req);
  clearSessionCookie(res);
  await auditEvent({
    eventType: "AUTH_LOGOUT", severity: "INFO", actor: "USER",
    action: "logout", sourceService: "auth", metadata: { previousRole: s.role },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json({ ok: true });
});

// ── LAYER 2 (per-user identity, Phase 1 isolation refactor) ───────────────

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
  // Legacy field (beta invite gate). Still accepted.
  inviteCode: z.string().min(1).max(64).optional(),
  // Registration Key Shield: ARX-XXXX-XXXX-XXXX format keys.
  // Required when ARX_BETA_INVITE_REQUIRED=true (handled at route level).
  registrationKey: z.string().min(1).max(80).optional(),
});

async function recordBetaGateAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { randomBytes, createHash } = await import("node:crypto");
    const eventId = randomBytes(12).toString("hex");
    const ts = new Date().toISOString();
    const body = JSON.stringify({ source: "beta-invite-gate", eventType, payload, ts });
    const checksum = createHash("sha256").update(body).digest("hex");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO audit_events (event_id, timestamp, event_type, source, severity, payload, checksum, schema_version)
      VALUES (${eventId}, ${ts}, ${eventType}, 'beta-invite-gate', 'INFO', ${JSON.stringify(payload)}::jsonb, ${checksum}, 1)
    `);
  } catch { /* never block registration on audit failure */ }
}

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

// Task #203 — public "request access" submission. Prospect asks to be invited.
// Creates a PENDING join_request (deduped by email), notifies admins in-app,
// and ALWAYS returns the same neutral confirmation — it never reveals whether
// the email is new, already pending, already invited, or already a user (no
// account enumeration). Submission NEVER creates an account or bypasses the
// invite gate. Public by virtue of the /auth/ allowlist prefix.
const requestAccessSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

const NEUTRAL_REQUEST_ACCESS_RESPONSE = {
  ok: true,
  status: "received" as const,
  message:
    "Thanks — your request has been received. If you're a fit, an operator will reach out with an invite.",
};

router.post("/auth/request-access", async (req, res) => {
  const parsed = requestAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    // Only the email-shape error is surfaced; everything else stays neutral.
    res.status(400).json({ error: "INVALID_EMAIL", message: "Enter a valid email address." });
    return;
  }
  if (await authCooldownTripped(req, "REQUEST_ACCESS")) {
    // Neutral, non-enumerating: a throttled caller learns nothing about the email.
    res.status(429).json({ ...NEUTRAL_REQUEST_ACCESS_RESPONSE, status: "received" });
    return;
  }
  const { email, name, note } = parsed.data;
  try {
    const result = await joinRequestsRepo.createRequest({ email, name, note });
    // Notify admins + audit only for a genuinely NEW pending request so a
    // re-submission of the same pending email doesn't spam the queue/audit.
    // Both are fire-and-forget (NOT awaited) so the response latency is
    // identical whether the request was newly created or a duplicate — the
    // created/duplicate branch must never be observable via a timing side
    // channel (non-enumeration contract).
    if (result.created) {
      fireNotifyAdminsOfJoinRequest({ requestId: result.request.id, email: result.request.email });
      void recordBetaGateAudit("join_request_received", {
        requestId: result.request.id,
        // email is the operator-facing identifier; safe in the admin audit log.
        email: result.request.email,
        source: result.request.source,
      }).catch(() => {
        // Best-effort audit; never leak storage details or alter response timing.
      });
    }
  } catch {
    // Never leak storage/enumeration details. The prospect always sees the
    // same neutral confirmation regardless of backend outcome.
  }
  res.status(202).json(NEUTRAL_REQUEST_ACCESS_RESPONSE);
});

// ── Task #202 — self-serve forgot/reset password ─────────────────────────
// Both endpoints are public via the /auth/ allowlist prefix. forgot-password
// NEVER reveals whether an email maps to an account (no enumeration): it always
// returns the same neutral 200, mirroring the login route's no-enumeration
// stance. Tokens are hashed + single-use + expiring; issuing a new one
// invalidates the user's older unused tokens (see passwordResetTokensRepo).

const NEUTRAL_FORGOT_MESSAGE =
  "If an account exists for that email, a password reset link has been sent.";

// Durable per-(ip+email) throttle (Task #210). Backed by a DB table
// (`password_reset_throttle`) instead of a process-local in-memory Map, so the
// limit survives API-server restarts and stays consistent across multiple
// server instances. Same neutral limits (5 / 15 min) and sliding-window
// semantics as before. Caps the reset-link issuance rate to blunt abuse/spam.
// Fails OPEN (does not throttle) if the throttle store is unavailable, so a
// storage outage never blocks a legitimate account recovery; the failure is
// logged for admin/developer visibility only.
async function forgotThrottled(req: import("express").Request, key: string): Promise<boolean> {
  try {
    return await passwordResetThrottleRepo.recordAttemptAndCheck(key);
  } catch (err) {
    req.log.error(
      { err: (err as Error).message },
      "password-reset throttle store unavailable — failing open (request allowed)",
    );
    return false;
  }
}

// Resolve the canonical public origin from TRUSTED config only. Request headers
// (Host / X-Forwarded-Host) are deliberately NOT used: trusting them would allow
// host-header poisoning — an attacker could forge a reset email pointing at their
// own domain carrying a victim's token. Precedence: explicit APP_PUBLIC_ORIGIN,
// then the platform-provided published/dev domains, then localhost for dev.
function resolvePublicOrigin(): string {
  const configured = process.env.APP_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const published = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (published) return `https://${published}`;
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "http://localhost";
}

function buildResetLink(rawToken: string): string {
  return `${resolvePublicOrigin()}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

router.post("/auth/forgot-password", async (req, res) => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_EMAIL", message: "Enter a valid email address." });
    return;
  }
  if (await authCooldownTripped(req, "FORGOT_PASSWORD")) {
    // Neutral 429 — identical body to the existing throttle path (no enumeration).
    res.status(429).json({ ok: true, message: NEUTRAL_FORGOT_MESSAGE });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const throttleKey = `${req.ip ?? "unknown"}:${email}`;
  if (await forgotThrottled(req, throttleKey)) {
    // Still neutral — a throttled caller cannot tell whether the email exists.
    res.status(429).json({ ok: true, message: NEUTRAL_FORGOT_MESSAGE });
    return;
  }
  let devResetLink: string | undefined;
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    const user = rows[0];
    if (user) {
      const { rawToken, expiresAt } = await passwordResetTokensRepo.createToken({
        userId: user.id,
        ipAddress: req.ip ?? null,
      });
      const link = buildResetLink(rawToken);
      // Deliver the reset link by email via Resend. Fire-and-forget on purpose:
      // (1) the neutral response must NOT depend on delivery success, and
      // (2) awaiting a network send only on the real-account branch would add a
      // timing oracle that re-enables account enumeration (the non-existent
      // branch only runs dummyWork). Failures are logged for admin/developer
      // visibility — never surfaced to the end user.
      void sendPasswordResetEmail({ to: user.email, resetLink: link, expiresAt })
        .then((result) => {
          req.log.info(
            { userId: user.id, emailId: result.id },
            "password reset email sent",
          );
        })
        .catch((err: unknown) => {
          if (isEmailNotConfiguredError(err)) {
            req.log.error(
              { userId: user.id, err: (err as Error).message },
              "password reset email NOT delivered — email provider not configured (connect the Resend integration)",
            );
          } else {
            req.log.error(
              { userId: user.id, err: (err as Error).message },
              "password reset email send failed",
            );
          }
        });
      if (!IS_PROD) {
        // Dev only: also surface the link via the server log AND the response so
        // the flow is testable without inspecting a mailbox. Strictly dev-gated.
        req.log.info({ userId: user.id, expiresAt, link }, "DEV password reset link issued");
        devResetLink = link;
      }
      void recordBetaGateAudit("password_reset_requested", { userId: user.id });
    } else {
      // Timing-equalization (anti-enumeration): a non-existent email must not be
      // distinguishable by latency. Run the same crypto + DB roundtrips the real
      // path performs, then discard. Mirrors the login route's DUMMY_HASH stance.
      await passwordResetTokensRepo.dummyWork();
    }
  } catch {
    // Never leak storage/enumeration details — always the neutral response.
  }
  res.status(200).json({
    ok: true,
    message: NEUTRAL_FORGOT_MESSAGE,
    ...(devResetLink ? { devResetLink } : {}),
  });
});

router.post("/auth/reset-password", async (req, res) => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "INVALID_INPUT",
      message: "A valid reset link and a new password (min 8 characters) are required.",
    });
    return;
  }
  if (await authCooldownTripped(req, "RESET_PASSWORD")) {
    res.status(429).json({ error: "RATE_LIMITED", message: "Too many attempts. Please try again later." });
    return;
  }
  const { token, password } = parsed.data;
  // Hash BEFORE consuming the token so a weak/invalid password doesn't burn it.
  let passwordHash: string;
  try {
    passwordHash = hashPassword(password);
  } catch (err) {
    res.status(400).json({ error: "WEAK_PASSWORD", message: (err as Error).message });
    return;
  }
  const consumed = await passwordResetTokensRepo.consumeToken(token);
  if (!consumed.ok) {
    res.status(400).json({
      error: "INVALID_TOKEN",
      message: "This reset link is invalid or has expired. Please request a new one.",
    });
    return;
  }
  // AACI Security handshake (Phase 2) — the valid one-time token is the
  // authenticated principal here. A non-admin action never BLOCKs an
  // authenticated caller; a posture degradation only records + alerts.
  const hs = await enforceSensitiveAction("RESET_PASSWORD", {
    userId: consumed.userId, authenticated: true,
  });
  if (!hs.ok) {
    res.status(403).json({ error: hs.reasonCode, message: hs.userMessage });
    return;
  }
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, consumed.userId));
  // Invalidate every existing session for this user — old cookies (on any
  // device) stop working immediately after a reset.
  const invalidated = await destroyAllUserSessions(consumed.userId);
  // Also clear any cookies on THIS response in case the requester was signed in.
  clearUserSessionCookie(res);
  clearSessionCookie(res);
  void recordBetaGateAudit("password_reset_completed", {
    userId: consumed.userId,
    sessionsInvalidated: invalidated,
  });
  res.status(200).json({
    ok: true,
    message: "Your password has been reset. You can now sign in with your new password.",
  });
});

function setUserSessionCookie(res: import("express").Response, rawToken: string): void {
  res.cookie(USER_SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearUserSessionCookie(res: import("express").Response): void {
  res.clearCookie(USER_SESSION_COOKIE, { path: "/" });
}

router.post("/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Email and password (min 8 chars) are required." });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "EMAIL_TAKEN", message: "An account with that email already exists." });
    return;
  }
  // Registration Key Shield (ARX_BETA_INVITE_REQUIRED=true). When off, behaviour is unchanged.
  // Accepts both: new registrationKey (ARX-XXXX-XXXX-XXXX format, peppered) and legacy inviteCode.
  // The effective code is whichever is provided (registrationKey takes precedence).
  let gatedInviteRow: { roleGrant: string | null } | null = null;
  if (betaInvitesRepo.isBetaInviteGateEnabled()) {
    // Phase-7: durable cooldown on repeated key attempts (anti brute-force).
    // Keyed by source IP; defence-in-depth on top of the one-time-code checks.
    const cd = await consumeRateLimit("INVITE_CODE_ATTEMPT", hashScope("ip", req.ip ?? "unknown"));
    if (!cd.allowed) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many attempts. Please try again later." });
      return;
    }
    // registrationKey takes precedence over legacy inviteCode.
    const code = (parsed.data.registrationKey ?? parsed.data.inviteCode ?? "").trim();
    if (!code) {
      await recordBetaGateAudit("registration_key_validation_failed", { email, error: "INVITE_REQUIRED" });
      res.status(403).json({
        error: "INVITE_REQUIRED",
        message: betaInvitesRepo.inviteErrorMessage("INVITE_REQUIRED"),
        field: "registrationKey",
      });
      return;
    }
    const v = await betaInvitesRepo.validateInviteForRegistration({ inviteCode: code, email });
    if (!v.ok) {
      await recordBetaGateAudit("registration_key_validation_failed", { email, error: v.error });
      res.status(betaInvitesRepo.inviteErrorStatus(v.error))
         .json({
           error: v.error,
           message: betaInvitesRepo.inviteErrorMessage(v.error),
           field: "registrationKey",
         });
      return;
    }
    gatedInviteRow = v.invite;
  }
  let passwordHash: string;
  try {
    passwordHash = hashPassword(parsed.data.password);
  } catch (err) {
    res.status(400).json({ error: "WEAK_PASSWORD", message: (err as Error).message });
    return;
  }
  // Atomic registration boundary: user insert + invite acceptance share a single tx.
  // If acceptInviteTx returns !ok we throw an internal sentinel to roll back everything.
  // role_grant from the key (if any) is applied inside the same tx; bounded to safe roles.
  type RegisterFailure = { kind: "INVITE_GATE"; error: betaInvitesRepo.InviteValidationError };
  let user: typeof usersTable.$inferSelect;
  const effectiveCode = (parsed.data.registrationKey ?? parsed.data.inviteCode ?? "").trim();
  try {
    user = await db.transaction(async (tx) => {
      // Determine role from gate (if any). Bounded to USER/INVESTOR/ADMIN; never OWNER.
      const safeRoleGrants = ["USER", "INVESTOR", "ADMIN"] as const;
      type SafeRole = typeof safeRoleGrants[number];
      const grantedRole: SafeRole = (
        gatedInviteRow?.roleGrant && safeRoleGrants.includes(gatedInviteRow.roleGrant as SafeRole)
          ? gatedInviteRow.roleGrant as SafeRole
          : "USER"
      );
      const inserted = await tx.insert(usersTable).values({
        email,
        name: parsed.data.name ?? null,
        passwordHash,
        role: grantedRole,
        lastLoginAt: new Date(),
      }).returning();
      const u = inserted[0]!;
      if (betaInvitesRepo.isBetaInviteGateEnabled() && effectiveCode) {
        const accepted = await betaInvitesRepo.acceptInviteTx(tx, {
          inviteCode: effectiveCode, email, userId: u.id,
        });
        if (!accepted.ok) {
          const failure: RegisterFailure = { kind: "INVITE_GATE", error: accepted.error };
          throw failure;
        }
      }
      return u;
    });
  } catch (err) {
    if (err && typeof err === "object" && (err as RegisterFailure).kind === "INVITE_GATE") {
      const f = err as RegisterFailure;
      await recordBetaGateAudit(
        f.error === "CAP_REACHED"
          ? "registration_key_cap_blocked_at_accept"
          : "registration_key_accept_failed_post_validation",
        { email, error: f.error },
      );
      res.status(betaInvitesRepo.inviteErrorStatus(f.error))
         .json({ error: f.error, message: betaInvitesRepo.inviteErrorMessage(f.error), field: "registrationKey" });
      return;
    }
    throw err;
  }
  const session = await createUserSession({
    userId: user.id,
    ipAddress: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
  });
  setUserSessionCookie(res, session.rawToken);
  await recordUserActivity(user.id, "USER_REGISTERED", { email });
  res.status(201).json({ user: toPublicUser(user) });
});

// Pre-computed dummy hash so login does the same scrypt work whether or not
// the email exists, blocking timing-based email enumeration. Generated once
// at module load.
const DUMMY_HASH = hashPassword("not-a-real-password-timing-decoy");

router.post("/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_INPUT", message: "Email and password are required." });
    return;
  }
  if (await authCooldownTripped(req, "LOGIN")) {
    res.status(429).json({ error: "RATE_LIMITED", message: "Too many sign-in attempts. Please try again later." });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  const user = rows[0];
  // Always run scrypt to keep the response time constant regardless of
  // whether the email exists — prevents user-enumeration via timing.
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const passwordOk = verifyPassword(parsed.data.password, hashToCheck);
  if (!user || !user.passwordHash || !passwordOk) {
    res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Invalid email or password." });
    return;
  }
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
  const session = await createUserSession({
    userId: user.id,
    ipAddress: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
  });
  setUserSessionCookie(res, session.rawToken);
  // Bridge LAYER-1 ↔ LAYER-2: mirror the user's DB role onto the
  // `hr_session` cookie that requireRole() reads. Without this, an
  // admin who logs in via /auth/login (LAYER 2) would still be
  // treated as anonymous by every requireRole()-guarded admin route.
  // Regular USER → VIEWER (read-only safe default), never OWNER/ADMIN.
  const dbRole = String(user.role ?? "USER").toUpperCase();
  const mirroredRole: AuthRole =
    dbRole === "OWNER" ? "OWNER" :
    dbRole === "ADMIN" ? "ADMIN" :
    dbRole === "TESTER" ? "TESTER" :
    "VIEWER";
  // Bind this role cookie to the user (uid) so it is revoked together with the
  // arx_user_session on logout / password reset (see requireRole).
  setSessionCookie(res, mirroredRole, user.id);
  await recordUserActivity(user.id, "USER_LOGGED_IN");
  res.json({ user: toPublicUser({ ...user, lastLoginAt: new Date() }) });
});

router.post("/auth/user-logout", async (req, res) => {
  const cookies = (req as import("express").Request & { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[USER_SESSION_COOKIE];
  const userId = req.authUser?.id;
  if (raw) await destroyUserSession(raw);
  clearUserSessionCookie(res);
  // Also clear the mirrored role cookie so a subsequent anon session
  // has no leftover ADMIN/OWNER role from the previous user.
  clearSessionCookie(res);
  if (userId) void recordUserActivity(userId, "USER_LOGGED_OUT");
  res.json({ ok: true });
});

router.get("/me", requireUser, (req, res) => {
  // Identity endpoint MUST always reflect the REAL role, never the
  // view-mode-downgraded role. Otherwise an admin in user-view would
  // get role=USER back from /api/me, and the frontend would conclude
  // they have no admin capability — stranding them in user mode with
  // no toggle. The view-mode middleware stashes the real role on
  // `authUser.realRole` before mutating; recover it here.
  const u = req.authUser!;
  const stashed = (u as { realRole?: string }).realRole;
  const realUser = stashed ? { ...u, role: stashed } : u;
  res.json({ user: toPublicUser(realUser) });
});

export default router;
