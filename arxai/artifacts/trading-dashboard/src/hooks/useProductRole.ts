import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  normalizeProductRole,
  isAdminRole,
  productRoleHomePath,
  type ProductRole,
} from "@/lib/productRole";

// Single source of truth for the caller's product role on the client. Reads
// the real role from /api/me (which always reflects the REAL role, never a
// view-mode downgrade). While identity is resolving, `isLoading` is true and
// callers must NOT make a containment decision yet.
export function useProductRole(): {
  role: ProductRole;
  isAdmin: boolean;
  isInvestor: boolean;
  isTrader: boolean;
  isLoading: boolean;
  homePath: string;
} {
  const { user, isLoading } = useCurrentUser();
  const role = normalizeProductRole(user?.role);
  return {
    role,
    isAdmin: isAdminRole(role),
    isInvestor: role === "INVESTOR",
    isTrader: role === "USER",
    isLoading,
    homePath: productRoleHomePath(role),
  };
}
