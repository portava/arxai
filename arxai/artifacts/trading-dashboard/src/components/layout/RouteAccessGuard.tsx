import React from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import {
  isNormalUserAllowedPath,
  isPendingTraderAllowedPath,
  isInvestorAllowedPath,
} from "@/lib/routeAccess";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";

export function RouteAccessGuard({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { realIsAdmin, effectiveIsAdmin, canToggle, setViewMode } = useViewMode();
  const { isLoading } = useCurrentUser();
  const { isInvestor } = useProductRole();
  const { isLoading: tierLoading, isApprovedTrader } = useTraderTier();
  const isAdminPath = location.startsWith("/admin");

  // While identity is still resolving, don't make an access decision. This
  // avoids two bad outcomes: (a) flashing a gated page to a normal user, and
  // (b) bouncing a real admin off a deep-linked URL before their role loads
  // (async role flags default to non-admin during the first /api/me query —
  // see .agents/memory/preview-as-user-loading-race.md). Render a neutral
  // skeleton until we know who the caller is.
  if (isLoading) {
    return (
      <div
        className="max-w-xl mx-auto mt-12 space-y-3"
        data-testid="routeaccess-loading"
        aria-busy="true"
      >
        <div className="h-8 w-1/3 rounded bg-muted animate-pulse" />
        <div className="h-32 w-full rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  // ── Investor containment (Task #71) ───────────────────────────────────
  // Investor accounts are view-only and confined to the Investor Portal +
  // universal account/help surfaces. Any other path (trading, scanner, admin)
  // redirects them back to /investor. Backend guards remain authoritative.
  if (isInvestor) {
    if (isInvestorAllowedPath(location)) return <>{children}</>;
    queueMicrotask(() => setLocation("/investor"));
    return (
      <div
        className="max-w-xl mx-auto mt-12 space-y-3"
        data-testid="routeaccess-investor-redirect"
        aria-busy="true"
      >
        <div className="h-8 w-1/3 rounded bg-muted animate-pulse" />
        <div className="h-32 w-full rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  // ── Non-/admin paths ──────────────────────────────────────────────────
  // Real admins/owners keep full access to every route (nav + direct URL).
  // Normal users are confined to the product allowlist; anything else (old
  // experiments, dev/QA pages, paper-trading surfaces, advanced power tools)
  // is contained here even when typed directly into the URL bar. Backend
  // route guards remain authoritative for data either way.
  if (!isAdminPath) {
    // Real admins/owners keep full access regardless of approval tier.
    if (realIsAdmin) return <>{children}</>;
    // TWO-TIER human-trader containment (Task #768). The reduced pending
    // allowlist (cockpit, onboarding, ARX status, school, account, settings,
    // help, emergency, notifications) is reachable by EVERY human trader, so we
    // allow it without waiting on the approval signal — this also keeps the
    // cockpit instantly reachable while approval resolves.
    if (isPendingTraderAllowedPath(location)) return <>{children}</>;
    // Beyond the pending set, the route is approved-only. While the approval
    // signal is still resolving, hold on a neutral skeleton rather than
    // bouncing an approved trader off a deep-linked execution URL (mirrors the
    // identity-loading race guard above).
    if (tierLoading) {
      return (
        <div
          className="max-w-xl mx-auto mt-12 space-y-3"
          data-testid="routeaccess-approval-loading"
          aria-busy="true"
        >
          <div className="h-8 w-1/3 rounded bg-muted animate-pulse" />
          <div className="h-32 w-full rounded-xl bg-muted/60 animate-pulse" />
        </div>
      );
    }
    // Approved (live / shared-bridge) traders get the full product allowlist.
    if (isApprovedTrader && isNormalUserAllowedPath(location)) return <>{children}</>;
    // Everyone else — a pending/unapproved trader on an execution surface, or
    // any trader on an admin/investor/experimental URL — is redirected home to
    // the cockpit (not shown a dead-end page). Backend route guards remain
    // authoritative for data either way.
    queueMicrotask(() => setLocation("/"));
    return (
      <div
        className="max-w-xl mx-auto mt-12 space-y-3"
        data-testid="routeaccess-nonproduct-redirect"
        aria-busy="true"
      >
        <div className="h-8 w-1/3 rounded bg-muted animate-pulse" />
        <div className="h-32 w-full rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  // ── /admin/* paths (unchanged behavior) ───────────────────────────────
  // Admin path + effective admin (real admin in admin-mode, or non-toggle admin): allow.
  if (effectiveIsAdmin) return <>{children}</>;

  // From here: caller is on an /admin/* URL but is NOT effective admin.
  // Two cases — render the right lock for each. Server APIs still enforce 403
  // regardless of what the frontend renders.
  const isRealAdminInUserMode = realIsAdmin && canToggle;

  if (isRealAdminInUserMode) {
    return (
      <div
        className="max-w-xl mx-auto mt-12 rounded-xl border border-border bg-card p-6 text-center space-y-4"
        data-testid="viewmode-admin-blocked"
      >
        <div className="text-base font-semibold">Admin tools require Admin mode</div>
        <p className="text-sm text-muted-foreground">
          You're previewing ARX AI as a regular user. Switch back to Admin mode to access admin controls.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => setViewMode("admin")}
            data-testid="button-viewmode-return-admin"
          >
            Switch to Admin mode
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLocation("/")}
            data-testid="button-viewmode-go-home"
          >
            Go to Cockpit
          </Button>
        </div>
      </div>
    );
  }

  // Real non-admin who typed an /admin/* URL directly. No toggle to offer.
  return (
    <div
      className="max-w-xl mx-auto mt-12 rounded-xl border border-border bg-card p-6 text-center space-y-4"
      data-testid="viewmode-nonadmin-blocked"
    >
      <div className="text-base font-semibold">This area is not available on your account</div>
      <p className="text-sm text-muted-foreground">
        Admin tools aren't part of your access. Head back to your cockpit to keep trading.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={() => setLocation("/")}
          data-testid="button-nonadmin-go-home"
        >
          Go to Cockpit
        </Button>
      </div>
    </div>
  );
}
