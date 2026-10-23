// Frontend mirror of the backend product-role model (Task #71).
//
// Every account has exactly ONE active product role. This module normalizes the
// raw `users.role` string the same way the server does and decides the
// post-login landing surface for each role. It is a UX/containment helper —
// backend route guards remain authoritative for all data and trade actions.

export type ProductRole = "OWNER" | "ADMIN" | "USER" | "INVESTOR";

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

export function isAdminRole(role: ProductRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

// Where each role lands right after sign-in (and where cross-role redirects
// send a caller who strays outside their surfaces).
export function productRoleHomePath(role: ProductRole): string {
  if (isAdminRole(role)) return "/admin/operator-command-center";
  if (role === "INVESTOR") return "/investor";
  return "/";
}
