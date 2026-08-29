import React from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertOctagon, AlertTriangle, Bell, CheckCircle2, Info } from "lucide-react";

// API Alert shape (subset we render).
interface AlertLike {
  id: number;
  type: string;
  priority?: string | null;
  severity: string;
  title: string;
  message: string;
  symbol?: string | null;
  relatedTradeId?: number | null;
  relatedPositionId?: number | null;
  relatedTradePlanId?: number | null;
  actionRequired?: boolean | null;
  read: number;
  createdAt?: string | null;
}

interface Props {
  alert: AlertLike;
  onMarkRead: (id: number) => void | Promise<void>;
}

// (L) Map related ids to the primary destination so a click takes the user
// directly to the page where they can act on the alert.
function relatedHref(a: AlertLike): string | null {
  if (a.relatedTradePlanId) return `/trade-plan-builder?planId=${a.relatedTradePlanId}`;
  if (a.relatedPositionId)  return `/portfolio`;
  if (a.relatedTradeId)     return `/trade-logs`;
  if (a.type === "WEEKLY_REVIEW")    return "/weekly-review";
  if (a.type === "BROKER_HEALTH" || a.type === "MT5_DISCONNECTED") return "/mt5-bridge";
  if (a.type === "RISK_LOCK") return "/risk-settings";
  if (a.type === "MARKET_CONDITION") return "/scanner";
  if (a.type === "POSITION_WARNING") return "/portfolio";
  if (a.type === "AI_COACH" || a.type === "REPLAY_DRILL") return "/learning";
  if (a.type === "EXECUTION_SAFETY" || a.type === "KILL_SWITCH_ACTIVATED") return "/emergency";
  return null;
}

function priorityBadge(p?: string | null) {
  switch (p) {
    case "CRITICAL": return <Badge variant="destructive" data-testid="badge-priority-critical">CRITICAL</Badge>;
    case "HIGH":     return <Badge className="bg-warning text-white" data-testid="badge-priority-high">HIGH</Badge>;
    case "MEDIUM":   return <Badge variant="secondary" data-testid="badge-priority-medium">MEDIUM</Badge>;
    case "LOW":      return <Badge variant="outline" data-testid="badge-priority-low">LOW</Badge>;
    default:         return null;
  }
}

function icon(severity: string) {
  switch (severity) {
    case "danger":  return <AlertOctagon className="h-4 w-4 text-danger" />;
    case "warning": return <AlertTriangle className="h-4 w-4 text-warning" />;
    case "success": return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "info":    return <Info className="h-4 w-4 text-primary" />;
    default:        return <Bell className="h-4 w-4 text-muted-foreground" />;
  }
}

export function AlertDetailCard({ alert, onMarkRead }: Props) {
  const href = relatedHref(alert);
  const ts = alert.createdAt ? new Date(alert.createdAt).toLocaleString() : "";
  return (
    <Card className={`p-3 ${alert.read === 0 ? "border-l-4 border-l-blue-500" : "opacity-70"}`} data-testid={`card-alert-${alert.id}`}>
      <div className="flex items-start gap-2">
        <div className="pt-0.5">{icon(alert.severity)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {priorityBadge(alert.priority)}
            <Badge variant="outline" className="text-[10px]">{alert.type}</Badge>
            {alert.actionRequired ? <Badge className="bg-warning text-white text-[10px]">ACTION</Badge> : null}
            <span className="text-xs text-muted-foreground ml-auto">{ts}</span>
          </div>
          <div className="font-medium text-sm mt-1" data-testid={`text-alert-title-${alert.id}`}>{alert.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{alert.message}</div>
          <div className="flex items-center gap-2 mt-2">
            {href ? (
              <Link href={href}>
                <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid={`button-alert-open-${alert.id}`}>
                  Open
                </Button>
              </Link>
            ) : null}
            {alert.read === 0 ? (
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
