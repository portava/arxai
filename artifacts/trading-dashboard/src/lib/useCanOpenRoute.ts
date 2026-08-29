import { useCallback } from "react";
import { useViewMode } from "@/hooks/useViewMode";
import { useTraderTier } from "@/hooks/useTraderTier";
import { isHumanTraderAllowedPath } from "@/lib/routeAccess";

/**
 * RANK 51 / 76 — "can THIS viewer actually open this route?"
 *
 * RouteAccessGuard silently redirects a non-allowlisted path back to the
 * cockpit. Rendering a link to such a path produces a button that looks like it
 * works and quietly does nothing useful — the exact failure that made 9 of the
 * 10 Safe Setup wizard steps, every blocker card, and 100% of the Help Center's
 * "Open page" links un-followable for the new and pending traders they were
 * written for.
 *
 * Registries can only check the APPROVED (superset) allowlist, because they are
 * built without a session. This hook is the second half: it re-checks against
 * the VIEWER's own tier at render time so a link is shown only when it will
 * actually land. A route it refuses should render NO link — never a disabled-
 * looking one, and never a link that redirects.
 *
 * Admin/owner sessions bypass both trader tiers, exactly as RouteAccessGuard
 * does. `/admin/*` is treated as admin-only.
 */
export function useCanOpenRoute(): (route: string | null | undefined) => boolean {
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isApprovedTrader } = useTraderTier();
  return useCallback(
    (route: string | null | undefined): boolean => {
      if (typeof route !== "string" || !route.startsWith("/")) return false;
      const path = route.split("?")[0].split("#")[0];
      if (isAdmin) return true;
      if (path.startsWith("/admin/") || path === "/admin") return false;
      return isHumanTraderAllowedPath(path, { isApprovedTrader });
    },
    [isAdmin, isApprovedTrader],
  );
}
