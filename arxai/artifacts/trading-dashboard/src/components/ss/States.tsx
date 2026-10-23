import React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Inbox, AlertTriangle, ShieldAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "./StatusPill";

// ── Loading ──────────────────────────────────────────────────────────────────
export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)} role="status" aria-live="polite">
      <Loader2 className="h-6 w-6 text-muted-foreground animate-spin mb-2" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export function CardSkeletons({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
    </div>
  );
}

// ── Empty ────────────────────────────────────────────────────────────────────
export function EmptyState({
  title, description, icon, action, className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center border border-dashed border-border rounded-lg py-10 px-6 bg-muted/20", className)}>
      <div className="text-muted-foreground mb-3" aria-hidden="true">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      {description && <p className="text-xs text-muted-foreground max-w-md mb-4">{description}</p>}
      {action && (
        action.href
          ? <a href={action.href}><Button size="sm" variant="outline">{action.label}</Button></a>
          : <Button size="sm" variant="outline" onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}

// ── Error ────────────────────────────────────────────────────────────────────
export function ErrorState({
  title = "Something went wrong",
  description, onRetry, className,
}: { title?: string; description?: string; onRetry?: () => void; className?: string }) {
  return (
    <Alert variant="destructive" className={className} role="alert">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-xs">
        {description ?? "Please try again. If the issue persists, check System Health."}
        {onRetry && <Button size="sm" variant="outline" className="ml-2 mt-2" onClick={onRetry}>Retry</Button>}
      </AlertDescription>
    </Alert>
  );
}

// ── Blocked (the helpful kind from §7) ──────────────────────────────────────
export function BlockedState({
  what, why, blockingSystem, safeNextStep, link, className,
}: {
  what: string;
  why: string;
  blockingSystem?: string;
  safeNextStep?: string;
  link?: { label: string; href: string };
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={cn("bg-red-500/5 border-red-500/30", className)} role="alert">
      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
      <AlertTitle className="flex items-center gap-2">
        <span>{what}</span>
        <StatusPill status="BLOCKED" size="xs" />
      </AlertTitle>
      <AlertDescription className="text-xs space-y-1.5 mt-2">
        <p><span className="font-semibold">Why:</span> {why}</p>
        {blockingSystem && <p><span className="font-semibold">Blocked by:</span> {blockingSystem}</p>}
        {safeNextStep && <p><span className="font-semibold">Safest next step:</span> {safeNextStep}</p>}
        {link && <a className="inline-block mt-1 underline" href={link.href}>{link.label} →</a>}
      </AlertDescription>
    </Alert>
  );
}
