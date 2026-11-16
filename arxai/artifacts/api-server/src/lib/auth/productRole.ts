// Central product-role resolver + guards.
//
// Every account has exactly ONE active product role, stored on `users.role`:
//   • OWNER    — kept in the security layer; behaves as ADMIN for product gates
//   • ADMIN    — full operator/admin surfaces
//   • USER     — trader (the default product role)
//   • INVESTOR — view-only investor (no trading-execution, no admin surfaces)
//
// This module is the single backend source of truth for that mapping so route
// guards never re-implement the normalization (which silently drifts). It adds
// NO new live/demo gate logic — it only decides whether a caller's product
// role is permitted to reach a surface at all. The 16-gate live pipeline, kill
// switch, and per-user live permission checks are untouched and still run.

import type { Request, Response, NextFunction } from "express";
import type { User } from "@workspace/db";

export type ProductRole = "OWNER" | "ADMIN" | "USER" | "INVESTOR";

// Normalize any stored/role string to a known product role. Unknown or empty
// values fall back to the safest non-privileged role (USER) — never ADMIN.
export function normalizeProductRole(raw: string | null | undefined): ProductRole {
  switch (String(raw ?? "").trim().toUpperCase()) {
    case "OWNER":
      return "OWNER";
    case "ADMIN":
      return "ADMIN";
    case "INVESTOR":
      return "INVESTOR";
    default:
      // USER, TESTER, VIEWER, unknown → trader/default.
      return "USER";
  }
}

// Resolve the REAL product role for a request's authenticated user. The
// view-mode middleware may stash the real role on `realRole` before
// downgrading `role` for admin-preview; we always resolve from the real role
// so a guard can never be weakened (nor strengthened) by view-mode preview.
export function resolveProductRole(
  authUser: (User & { realRole?: string }) | undefined | null,
): ProductRole {
  if (!authUser) return "USER";
  const stashed = (authUser as { realRole?: string }).realRole;
  return normalizeProductRole(stashed ?? authUser.role);
}

export function isAdminProductRole(role: ProductRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function authUserOf(req: Request): (User & { realRole?: string }) | undefined {
  return (req as Request & { authUser?: User & { realRole?: string } }).authUser;
}

// Admin namespaces (router-relative paths) that require an ADMIN/OWNER product
// role. Matched as a prefix against req.path INSIDE the /api router, where
// admin routes look like "/admin/..." or "/admin-control/...".
function isAdminNamespacePath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/admin-")
  );
}

// The ONLY state-changing requests an INVESTOR account may issue. This is a
// tightly-bounded allowlist of investor self-service writes — currently just
// submitting an intent-only allocation-preference request. It is intent only:
// it never reaches any execution/sizing path, the 16-gate live pipeline, or any
// admin/bridge/kill-switch surface. Keep this list minimal and exact-match.
const INVESTOR_SELF_SERVICE_WRITE_PATHS = new Set<string>([
  "/me/investor/allocation",
]);

// INVESTOR accounts are view-only. They may issue safe read requests, use the
// auth/session endpoints (so they can always sign out), and the single
// allow-listed self-service write above; every other state-changing request is
// refused. Because this denies ALL other mutations for an investor, it cannot
// be bypassed by a forgotten execution route.
function isInvestorReadOnlySafe(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const p = req.path || "/";
  if (p === "/auth" || p.startsWith("/auth/")) return true;
  if (method === "POST" && INVESTOR_SELF_SERVICE_WRITE_PATHS.has(p)) return true;
  return false;
}

// Central product-role access gate. Mounted ONCE, immediately after the global
// auth gate, so it sees a router-relative `req.path` and a populated
// `req.authUser` for every authenticated /api request. It enforces two
// single-role rules and adds NO trading-gate logic:
//   1. Admin namespaces require an ADMIN/OWNER product role (belt-and-braces —
//      the per-router requireAdmin checks still run downstream).
//   2. INVESTOR accounts are view-only — every mutation is refused.
// Anonymous callers fall through to the upstream auth gate / per-route
// requireUser. The 16-gate live pipeline, kill switch, and per-user live
// permission checks are untouched and still run.
export function enforceProductRoleAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = authUserOf(req);
  if (!user) {
    next();
    return;
  }
  const role = resolveProductRole(user);

  if (isAdminNamespacePath(req.path) && !isAdminProductRole(role)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin access required." });
    return;
  }

  if (role === "INVESTOR" && !isInvestorReadOnlySafe(req)) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Investor accounts are view-only and cannot place or manage trades.",
    });
    return;
  }

  next();
}

// Deny plain trader (USER) accounts from the investor portal read area
// (`/me/investor/*`). The investor portal is for INVESTOR accounts; ADMIN/OWNER
// pass through for support and preview-as-investor (their effective role becomes
// INVESTOR while previewing). Anonymous callers fall through to the downstream
// `requireUser` guard. Mount this PATH-SCOPED (`router.use("/me/investor", …)`)
// — never router-wide — so it only runs for investor-area paths. Per-user
// scoping already prevents any cross-tenant read; this additionally honours the
// product rule that traders have no access to the investor portal at all.
export function denyTraderInvestorArea(req: Request, res: Response, next: NextFunction): void {
  const user = authUserOf(req);
  if (user && resolveProductRole(user) === "USER") {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "The investor portal is not available on a trading account.",
    });
    return;
  }
  next();
}

// Deny INVESTOR accounts from any trading-execution surface. Traders, admins,
// and owners pass through unchanged — this is a thin additive pre-guard that
// runs BEFORE the existing execution handlers and does not alter any gate.
export function denyInvestorExecution(req: Request, res: Response, next: NextFunction): void {
  const user = authUserOf(req);
  // Anonymous callers are handled by the downstream requireUser guard; we only
  // veto a positively-identified investor here.
  if (user && resolveProductRole(user) === "INVESTOR") {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "Investor accounts cannot place or manage trades.",
    });
    return;
  }
  next();
}
