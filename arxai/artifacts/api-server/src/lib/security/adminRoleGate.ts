// Task #743 Cluster D — single source of truth for "is this session an
// operator (ADMIN/OWNER)?".
//
// SAFETY: admin / live-control route guards (adminBridgeControl.requireAdmin,
// adminTrading.getAdminRole) funnel their role check through here so that an
// INVESTOR / USER / anonymous session is denied at the route level. Anything
// that is not exactly ADMIN or OWNER (case-insensitive) returns null → the
// caller responds 403 ADMIN_OR_OWNER_REQUIRED. Keeping this in one pure,
// unit-testable helper prevents drift between the route guards.

export type OperatorRole = "ADMIN" | "OWNER";

/**
 * Resolve a validated session role string to an operator role, or null when the
 * caller is not an operator. Pure (no I/O). INVESTOR, USER, "", null, undefined
 * and any other value all resolve to null (denied).
 */
export function operatorRoleFromSession(
  role: string | null | undefined,
): OperatorRole | null {
  const r = String(role ?? "").toUpperCase();
  return r === "ADMIN" || r === "OWNER" ? (r as OperatorRole) : null;
}
