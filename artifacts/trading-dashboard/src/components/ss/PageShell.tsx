import React from "react";
import { SafetyBadgeRow } from "./SafetyBadges";
import { cn } from "@/lib/utils";

interface PageShellProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  readOnly?: boolean;
  replayOnly?: boolean;
  hideSafety?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function PageShell({ title, description, icon, badges, actions, readOnly, replayOnly, hideSafety, children, className }: PageShellProps) {
  return (
    <div className={cn("space-y-4 md:space-y-6", className)}>
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            {icon && <span className="text-primary shrink-0" aria-hidden="true">{icon}</span>}
            <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate">{title}</h1>
          </div>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
          {!hideSafety && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <SafetyBadgeRow readOnly={readOnly} replayOnly={replayOnly} />
              {badges}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2 md:shrink-0">{actions}</div>}
      </header>
      <div className="space-y-4 md:space-y-6">{children}</div>
    </div>
  );
}

export function SectionHeader({ title, description, actions, className }: { title: string; description?: string; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-3", className)}>
      <div className="min-w-0">
        <h2 className="text-base md:text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
