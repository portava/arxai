// Row-ownership filter for tables that carry a nullable user_id.
//
// A trader sees only rows they own. Legacy rows with user_id IS NULL came from
// the single server-wide MT5 connection and the pre-tenant builds; they belong
// to the operator, so only ADMIN/OWNER sessions can see or act on them.
// Callers answer 404 when the filter matches nothing, so another user's row
// looks exactly like a row that does not exist.

import type { NextFunction, Request, Response } from "express";
import { eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { User } from "@workspace/db";
import { isAdminProductRole, resolveProductRole } from "./productRole.js";

export function canSeeLegacyRows(authUser: (User & { realRole?: string }) | undefined | null): boolean {
  return isAdminProductRole(resolveProductRole(authUser));
}

export function ownerScope(
  userIdColumn: PgColumn,
  authUser: (User & { realRole?: string }) | undefined | null,
): SQL {
  if (!authUser) return sql`false`; // unreachable behind requireUser; matches nothing
  const own = eq(userIdColumn, authUser.id);
  return canSeeLegacyRows(authUser) ? (or(own, isNull(userIdColumn)) as SQL) : own;
}

// Guard for server-wide singletons (the shared MT5 feed, the paper autopilot
// loop): one instance serves the whole install, so only an operator drives it.
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) { res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." }); return; }
  if (!canSeeLegacyRows(req.authUser)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Operator access required." });
    return;
  }
  next();
}
