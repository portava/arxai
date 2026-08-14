// Owner / Tester session layer.
//
// SAFETY: Dev-friendly cookie session. Stores only { role, sessionId }
// in an HttpOnly signed cookie. Never stores secrets or tokens.
// Maps spec roles (OWNER/ADMIN/TESTER/VIEWER/LOCKED) onto the existing
// DB-backed role set (OWNER/ADMIN/TRADER/VIEWER/SYSTEM) for permission
// resolution. LOCKED denies everything.

import type { Request, Response, NextFunction } from "express";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { auditEvent } from "../systemHealth/audit.js";
import { findUserBySessionToken, USER_SESSION_COOKIE } from "../auth/userSessions.js";

export type AuthRole = "OWNER" | "ADMIN" | "TESTER" | "VIEWER" | "LOCKED";
export const AUTH_ROLES: readonly AuthRole[] = ["OWNER", "ADMIN", "TESTER", "VIEWER", "LOCKED"];

const COOKIE_NAME = "hr_session";
export const IS_PROD = process.env["NODE_ENV"] === "production";
export const ALLOW_DEV_AUTH = process.env["ALLOW_DEV_AUTH"] === "true";

// In production, SESSION_SECRET MUST be set explicitly. The fallback below is
// only used in dev/test (NODE_ENV !== production) so the workflow keeps
// running without a configured secret. A misconfigured prod will hard-fail at
// the first encode/decode call.
const RAW_SECRET = process.env["SESSION_SECRET"];
if (IS_PROD && (!RAW_SECRET || RAW_SECRET.length < 16)) {
  throw new Error("SESSION_SECRET must be set (>=16 chars) in production. Refusing to start with a fallback secret.");
}
const SECRET = RAW_SECRET ?? "dev-fallback-secret-do-not-use-in-prod";

// `uid` is present only on cookies minted by a real user login (/auth/login).
// Such a cookie is honored only while that user still has a live
// `arx_user_session` (see requireRole) — so a password reset, which destroys
// all of a user's sessions, immediately revokes their role cookie too. Cookies
// without `uid` (dev-owner-login, x-security-role header, anon default) are not
// subject to that binding.
export interface SessionPayload { sid: string; role: AuthRole; ts: number; uid?: number; }

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function encodeSession(p: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeSession(raw: string | undefined | null): SessionPayload | null {
  if (!raw || !raw.includes(".")) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  try {
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!p || typeof p !== "object" || !AUTH_ROLES.includes(p.role)) return null;
    // Drop a malformed uid rather than trust it.
    if (p.uid !== undefined && (typeof p.uid !== "number" || !Number.isInteger(p.uid))) delete p.uid;
    return p;
  } catch { return null; }
}

// Map spec role → role used for DB permission resolution.
export function dbRoleFor(role: AuthRole): "OWNER" | "ADMIN" | "TRADER" | "VIEWER" | "SYSTEM" {
  switch (role) {
    case "OWNER": return "OWNER";
    case "ADMIN": return "ADMIN";
    case "TESTER": return "TRADER";
    case "VIEWER": return "VIEWER";
    case "LOCKED": return "VIEWER";
  }
}

export function getSessionFromReq(req: Request): SessionPayload {
  // 1. Signed cookie (preferred — the only trustable source in production).
  const cookieRaw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  const fromCookie = decodeSession(cookieRaw);
  if (fromCookie) return fromCookie;

  // 2. x-security-role header — DEV ONLY back-compat. Many existing tester
  //    pages send this header to satisfy admin-gated reads. In production it
  //    is rejected so it cannot be used as an auth-bypass channel.
  if (!IS_PROD || ALLOW_DEV_AUTH) {
    const headerRole = String(req.header("x-security-role") ?? "").toUpperCase();
    if ((AUTH_ROLES as readonly string[]).includes(headerRole)) {
      return { sid: "header", role: headerRole as AuthRole, ts: Date.now() };
    }
  }

  // 3. Default: dev/test → implicit OWNER (so the workflow is never
  //    accidentally locked out). Production → VIEWER (read-only safe default).
  return { sid: "anon", role: !IS_PROD ? "OWNER" : "VIEWER", ts: Date.now() };
}

export function setSessionCookie(res: Response, role: AuthRole, uid?: number): SessionPayload {
  const p: SessionPayload = { sid: randomUUID(), role, ts: Date.now(), ...(uid !== undefined ? { uid } : {}) };
  res.cookie(COOKIE_NAME, encodeSession(p), {
    httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/", maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return p;
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// ── Permission matrix (spec shape) ────────────────────────────────────────
export interface PermissionMatrixEntry {
  role: AuthRole;
  fullTesterAccess: boolean;
  canViewAllRoutes: boolean;
  canUseSimulator: boolean;
  canUseLiveTesterWorkflows: boolean;
  canSubmitLiveIntent: boolean;
  canExecuteRealBrokerOrder: false; // hard-locked false for everyone until MT5 bridge connects.
  canConfigureMT5: boolean;
  canEditRiskSettings: boolean;
  canClearTestData: boolean;
  canExportReports: boolean;
  canRunBacktesting: boolean;
  canRunShadowMode: boolean;
  canRunAiAutopilotSimulator: boolean;
  mt5Connected: false;
  mt5Deferred: true;
}

export function buildMatrix(role: AuthRole): PermissionMatrixEntry {
  const F = false as const, T = true as const;
  const base: PermissionMatrixEntry = {
    role,
    fullTesterAccess: F, canViewAllRoutes: F, canUseSimulator: F, canUseLiveTesterWorkflows: F,
    canSubmitLiveIntent: F, canExecuteRealBrokerOrder: false, canConfigureMT5: F,
    canEditRiskSettings: F, canClearTestData: F, canExportReports: F,
    canRunBacktesting: F, canRunShadowMode: F, canRunAiAutopilotSimulator: F,
    mt5Connected: false, mt5Deferred: true,
  };
  switch (role) {
    case "OWNER":
      return { ...base, fullTesterAccess: T, canViewAllRoutes: T, canUseSimulator: T,
        canUseLiveTesterWorkflows: T, canSubmitLiveIntent: T, canConfigureMT5: T,
        canEditRiskSettings: T, canClearTestData: T, canExportReports: T,
        canRunBacktesting: T, canRunShadowMode: T, canRunAiAutopilotSimulator: T };
    case "ADMIN":
      return { ...base, fullTesterAccess: T, canViewAllRoutes: T, canUseSimulator: T,
        canUseLiveTesterWorkflows: T, canSubmitLiveIntent: T, canConfigureMT5: F,
        canEditRiskSettings: T, canClearTestData: F, canExportReports: T,
        canRunBacktesting: T, canRunShadowMode: T, canRunAiAutopilotSimulator: T };
    case "TESTER":
      return { ...base, fullTesterAccess: T, canViewAllRoutes: T, canUseSimulator: T,
        canUseLiveTesterWorkflows: T, canSubmitLiveIntent: T, canConfigureMT5: F,
        canEditRiskSettings: F, canClearTestData: F, canExportReports: T,
        canRunBacktesting: T, canRunShadowMode: T, canRunAiAutopilotSimulator: T };
    case "VIEWER":
      return { ...base, canViewAllRoutes: T, canExportReports: F };
    case "LOCKED":
      return base;
  }
}

// A login-minted role cookie carries `uid`. It is honored only while that user
// still has a live `arx_user_session` — destroying those sessions (logout or
// password reset) immediately revokes the role cookie on every device. Returns
// true when the cookie is still backed by a live session (or is not uid-bound).
async function roleCookieStillLive(req: Request, s: SessionPayload): Promise<boolean> {
  if (typeof s.uid !== "number") return true; // dev/header/anon — not uid-bound.
  const attached = (req as Request & { authUser?: { id: number } }).authUser;
  if (attached) return attached.id === s.uid;
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[USER_SESSION_COOKIE];
  if (!raw) return false;
  try {
    const user = await findUserBySessionToken(raw);
    return !!user && user.id === s.uid;
  } catch {
    return false; // fail-closed: a uid-bound cookie with no resolvable session is not trusted.
  }
}

export function requireRole(...allowed: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const s = getSessionFromReq(req);
    const denyAndAudit = (reason: string) => {
      void auditEvent({
        eventType: "PERMISSION_DENIED", severity: "WARNING", actor: "USER",
        action: `denied ${req.method} ${req.path}`, sourceService: "auth",
        metadata: { role: s.role, sessionId: s.sid, requiredAnyOf: allowed, reason },
        ipAddress: req.ip ?? null,
      }).catch(() => {});
      res.status(403).json({ allowed: false, reason, requiredAnyOf: allowed });
    };
    if (s.role === "LOCKED") { denyAndAudit("Account is LOCKED."); return; }
    if (allowed.length !== 0 && !allowed.includes(s.role)) {
      denyAndAudit(`Permission denied for role ${s.role}.`);
      return;
    }
    // Passed role check — now confirm a login-minted cookie hasn't been revoked.
    roleCookieStillLive(req, s)
      .then((live) => {
        if (!live) { denyAndAudit("Session revoked — sign in again."); return; }
        next();
      })
      .catch(() => denyAndAudit("Session revoked — sign in again."));
  };
}
