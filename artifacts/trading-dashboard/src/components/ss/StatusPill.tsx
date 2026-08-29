import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CheckCircle2, PauseCircle, ShieldAlert, Eye, Lock, Beaker,
  AlertTriangle, AlertOctagon, Circle, Clock, type LucideIcon,
} from "lucide-react";

export type StatusKind =
  | "ACTIVE" | "PAUSED" | "BLOCKED" | "WATCH_ONLY" | "LOCKED"
  | "PAPER_ONLY" | "LIVE_DISABLED" | "READ_ONLY" | "REPLAY_ONLY"
  | "SAFE_TO_PAPER_TEST" | "ACTION_REQUIRED" | "PENDING" | "INACTIVE";

const MAP: Record<StatusKind, { label: string; icon: LucideIcon; cls: string; aria: string }> = {
  ACTIVE:              { label: "ACTIVE",              icon: CheckCircle2, cls: "bg-success/15 text-success border-success/30", aria: "status: active" },
  PAUSED:              { label: "PAUSED",              icon: PauseCircle,  cls: "bg-warning/15 text-warning border-warning/30",        aria: "status: paused" },
  BLOCKED:             { label: "BLOCKED",             icon: ShieldAlert,  cls: "bg-danger/15 text-danger border-danger/30",              aria: "status: blocked" },
  WATCH_ONLY:          { label: "TRADING PAUSED",      icon: Eye,          cls: "bg-primary/15 text-primary border-primary/30",           aria: "status: trading paused" },
  LOCKED:              { label: "LOCKED",              icon: Lock,         cls: "bg-danger/15 text-danger border-danger/30",              aria: "status: locked" },
  PAPER_ONLY:          { label: "DEMO ONLY",           icon: Lock,         cls: "bg-primary/15 text-primary border-primary/30",           aria: "status: demo trading only" },
  LIVE_DISABLED:       { label: "LIVE DISABLED",       icon: ShieldAlert,  cls: "bg-danger/15 text-danger border-danger/30",              aria: "status: live trading disabled" },
  READ_ONLY:           { label: "READ ONLY",           icon: Eye,          cls: "bg-warning/15 text-warning border-warning/30",        aria: "status: read only" },
  REPLAY_ONLY:         { label: "REPLAY ONLY",         icon: Beaker,       cls: "bg-premium/15 text-premium border-premium/30",     aria: "status: replay simulation only" },
  SAFE_TO_PAPER_TEST:  { label: "SAFE TO DEMO TEST",   icon: CheckCircle2, cls: "bg-success/15 text-success border-success/30",  aria: "status: safe to demo test" },
  ACTION_REQUIRED:     { label: "ACTION REQUIRED",     icon: AlertTriangle,cls: "bg-warning/15 text-warning border-warning/30",        aria: "status: action required" },
  PENDING:             { label: "PENDING",             icon: Clock,        cls: "bg-muted text-muted-foreground border-border",              aria: "status: pending" },
  INACTIVE:            { label: "INACTIVE",            icon: Circle,       cls: "bg-muted text-muted-foreground border-border",              aria: "status: inactive" },
};

export function StatusPill({ status, label, className, size = "sm" }: { status: StatusKind; label?: string; className?: string; size?: "xs" | "sm" }) {
  const m = MAP[status];
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={cn(m.cls, "font-semibold inline-flex items-center", size === "xs" ? "text-[10px] py-0 px-1.5" : "", className)} aria-label={m.aria}>
      <Icon className={cn(size === "xs" ? "h-2.5 w-2.5 mr-1" : "h-3 w-3 mr-1")} aria-hidden="true" />
      {label ?? m.label}
    </Badge>
  );
}

export function CriticalStatusPill({ label, className }: { label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-danger/20 text-danger border-danger/40 font-semibold animate-pulse", className)} aria-label={`critical: ${label}`}>
      <AlertOctagon className="h-3 w-3 mr-1" aria-hidden="true" />{label}
    </Badge>
  );
}
