import React from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertOctagon, AlertTriangle, Bell, CheckCircle2, Info } from "lucide-react";
import { isNormalUserAllowedPath } from "@/lib/routeAccess";
import type { UserAlert } from "./meAlerts";

interface Props {
  alert: UserAlert;
  onMarkRead: (id: number) => void | Promise<void>;
}

// RANK 76 (same class) — every "Open" target here used to be hand-written and
// several pointed at paths on NO trader allowlist (/portfolio, /learning,
// /mt5-bridge, /risk-settings, /scanner's old spelling). RouteAccessGuard
// silently redirects a non-allowlisted path home, so the button looked like it
// worked and quietly dumped the user back on the cockpit.
//
// Two changes:
//   1. the per-user store carries its own `actionTarget` (set by the code that
//      raised the alert), so that is preferred over any guess here;
//   2. every candidate — stored or mapped — is validated against
//      isNormalUserAllowedPath BEFORE the button renders. A target we cannot
//      guarantee is reachable produces NO button rather than a dead end.
// Pinned by inAppHrefAllowlist.test.ts.
const TYPE_ROUTES: Record<string, string> = {
  mt5_disconnected: "/mt5-setup",
  mt5_stale: "/mt5-setup",
  bridge_health: "/mt5-setup",
  risk_block: "/risk-command-center",
  risk_lock: "/risk-command-center",
  cooldown_started: "/risk-command-center",
  daily_loss_warning: "/risk-command-center",
  session_no_journal: "/journal",
  trade_no_review: "/trade-logs",
  playbook_missing: "/journal",
  checklist_failed: "/risk-command-center",
  coaching_updated: "/ai-coach",
  kill_switch_activated: "/emergency",
  execution_safety: "/emergency",
};

/** The destination for this alert, or null when we cannot promise it resolves. */
export function alertHref(a: Pick<UserAlert, "alertType" | "actionTarget">): string | null {
  const candidate = a.actionTarget?.trim() || TYPE_ROUTES[String(a.alertType).toLowerCase()] || null;
  if (!candidate || !candidate.startsWith("/")) return null;
  return isNormalUserAllowedPath(candidate) ? candidate : null;
}

function severityBadge(s: string) {
  switch (String(s).toLowerCase()) {
    case "critical": return <Badge variant="destructive" data-testid="badge-severity-critical">CRITICAL</Badge>;
    case "warning":  return <Badge className="bg-warning text-white" data-testid="badge-severity-warning">WARNING</Badge>;
    default:         return <Badge variant="outline" data-testid="badge-severity-info">INFO</Badge>;
  }
}

function icon(severity: string) {
  switch (String(severity).toLowerCase()) {
    case "critical": return <AlertOctagon className="h-4 w-4 text-danger" />;
    case "warning":  return <AlertTriangle className="h-4 w-4 text-warning" />;
    case "success":  return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "info":     return <Info className="h-4 w-4 text-primary" />;
    default:         return <Bell className="h-4 w-4 text-muted-foreground" />;
  }
}

export function AlertDetailCard({ alert, onMarkRead }: Props) {
  const href = alertHref(alert);
  const ts = alert.createdAt ? new Date(alert.createdAt).toLocaleString() : "";
  const isUnread = alert.status === "unread";
  return (
    <Card className={`p-3 ${isUnread ? "border-l-4 border-l-blue-500" : "opacity-70"}`} data-testid={`card-alert-${alert.id}`}>
      <div className="flex items-start gap-2">
        <div className="pt-0.5">{icon(alert.severity)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {severityBadge(alert.severity)}
            <Badge variant="outline" className="text-[10px]">{alert.alertType}</Badge>
            <span className="text-xs text-muted-foreground ml-auto">{ts}</span>
          </div>
          <div className="font-medium text-sm mt-1" data-testid={`text-alert-title-${alert.id}`}>{alert.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{alert.message}</div>
          <div className="flex items-center gap-2 mt-2">
            {href ? (
              <Link href={href}>
                <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid={`button-alert-open-${alert.id}`}>
                  {alert.actionLabel || "Open"}
                </Button>
              </Link>
            ) : null}
            {isUnread ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onMarkRead(alert.id)} data-testid={`button-alert-mark-${alert.id}`}>
                Mark read
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
