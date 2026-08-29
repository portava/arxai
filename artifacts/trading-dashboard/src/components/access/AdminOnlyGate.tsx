// Shared UI states for admin/owner-only product surfaces.
//
// Several "Advanced AI & Strategy" pages (Shadow Mode, Strategy Tournament,
// Confidence Calibration, Strategy Promotion, AI Readiness, Shadow Journal)
// sit in the normal-user route allowlist but are backed entirely by
// admin/OWNER-only endpoints (requireAdmin in shadowMode.ts). Before Task #802
// they mounted, fired the gated calls, took a 403, and rendered blank /
// half-empty UI with no message for a non-admin trader.
//
// These helpers replicate the pattern established by the Autopilot Control
// Center (autopilot-control-center.tsx):
//   • roleLoading  → a neutral "Checking access…" shell (no containment
//                    decision yet — unresolved role ≠ denied)
//   • roleDenied   → an explicit access-denied card, and the page fires ZERO
//                    gated API calls
//   • server 403   → the same denied card as defense in depth (e.g. an admin
//                    whose effective role was downgraded server-side)
//
// This is a UX/containment layer only. The server-side requireAdmin guard on
// every gated route remains the authority.

import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

function GateHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {icon}
      <h1 className="text-2xl font-bold">{title}</h1>
    </div>
  );
}

/** Neutral shell while the caller's identity is still resolving. */
export function AccessCheckingShell({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="space-y-4">
      <GateHeader icon={icon} title={title} />
      <p className="text-sm text-muted-foreground">Checking access…</p>
    </div>
  );
}

/**
 * Explicit human-readable access-denied / load-error card. Used both for a
 * client-side role pre-check (roleDenied) and as defense in depth when a gated
 * endpoint returns 403/401.
 */
export function AccessDeniedCard({
  icon,
  title,
  message,
  note,
  onRetry,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  note?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="space-y-4">
      <GateHeader icon={icon} title={title} />
      <Card className="border-warning/40 bg-warning/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-warning mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-warning">{message}</p>
            {note && <p className="text-xs text-warning/70 mt-1">{note}</p>}
            {onRetry && (
              <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Standard denied copy for the SHADOW admin-only strategy surfaces. */
export const SHADOW_ADMIN_DENIED_NOTE =
  "These strategy-research surfaces are restricted to Admin and Owner sessions. " +
  "They observe SHADOW (non-live) data only — no simulator orders and no broker execution.";

export function shadowAdminDeniedMessage(surface: string): string {
  return `Access denied — Admin or Owner role required to view ${surface}.`;
}
