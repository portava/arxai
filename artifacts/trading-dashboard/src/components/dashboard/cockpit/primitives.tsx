// ARX 5.0 Cockpit primitives — the shared visual language for the redesigned
// dashboard. Pure presentation; no data, no wiring. Built on the global theme
// tokens (bg-card, border-border, text-primary/ruby/success/warning/danger).

import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Accent = "blue" | "ruby" | "success" | "warning" | "danger" | "neutral";

// Vibrant per-accent styling to match the mockup: colored icon chip, tinted
// border, and a faint surface wash + glow keyed to each card's accent.
const ACCENT_CHIP: Record<Accent, string> = {
  blue: "bg-primary/15 text-primary ring-primary/25",
  ruby: "bg-ruby/15 text-ruby ring-ruby/25",
  success: "bg-success/15 text-success ring-success/25",
  warning: "bg-warning/15 text-warning ring-warning/25",
  danger: "bg-danger/15 text-danger ring-danger/25",
  neutral: "bg-secondary/60 text-txt-secondary ring-white/10",
};

const ACCENT_BORDER: Record<Accent, string> = {
  blue: "border-primary/25",
  ruby: "border-ruby/25",
  success: "border-success/25",
  warning: "border-warning/25",
  danger: "border-danger/25",
  neutral: "border-card-border",
};

const ACCENT_WASH: Record<Accent, string> = {
  blue: "from-primary/[0.06]",
  ruby: "from-ruby/[0.06]",
  success: "from-success/[0.07]",
  warning: "from-warning/[0.05]",
  danger: "from-danger/[0.05]",
  neutral: "from-transparent",
};

const ACCENT_GLOW: Record<Accent, string> = {
  blue: "from-primary/20",
  ruby: "from-ruby/20",
  success: "from-success/20",
  warning: "from-warning/15",
  danger: "from-danger/15",
  neutral: "from-transparent",
};

export function CockpitCard({
  title,
  subtitle,
  icon,
  accent = "neutral",
  badge,
  loading,
  children,
  className,
  headerExtra,
  ...rest
}: {
  title?: string;
  subtitle?: string;
  icon?: React.ReactNode;
  accent?: Accent;
  badge?: string;
  loading?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Optional element rendered to the right of the badge in the card header. */
  headerExtra?: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section
      data-testid={rest["data-testid"]}
      className={cn(
        "relative isolate overflow-hidden rounded-2xl border bg-card p-4 sm:p-5",
        ACCENT_BORDER[accent],
        "shadow-[0_8px_30px_-12px_rgba(0,0,0,0.7)]",
        className,
      )}
    >
      {/* faint full-card wash keyed to the accent */}
      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent", ACCENT_WASH[accent])}
      />
      {/* brighter corner glow */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-gradient-to-br to-transparent blur-2xl",
          ACCENT_GLOW[accent],
        )}
      />
      {(title || badge != null || headerExtra != null) && (
      <header className="relative mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {icon && (
            <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1", ACCENT_CHIP[accent])}>
              {icon}
            </span>
          )}
          <div>
            <h3 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h3>
            {subtitle && <p className="text-xs text-txt-secondary">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          {badge != null && (
            <span className="grid min-w-[22px] place-items-center rounded-full bg-secondary/60 px-1.5 py-0.5 text-[11px] font-semibold text-secondary-foreground">
              {badge}
            </span>
          )}
        </div>
      </header>
      )}

      <div className="relative">
        {loading ? <CardSkeleton /> : children}
      </div>
    </section>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-4 w-2/3 animate-pulse rounded bg-secondary/50" />
      <div className="h-10 w-full animate-pulse rounded bg-secondary/30" />
    </div>
  );
}

export function StatTile({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={cn("mt-0.5 truncate font-mono text-lg font-bold text-foreground sm:text-xl", valueClass)}>
        {value}
      </div>
    </div>
  );
}

type PillTone = "success" | "warning" | "danger" | "info" | "muted";
const PILL: Record<PillTone, string> = {
  success: "bg-success/10 text-success border-success/30",
  warning: "bg-warning/10 text-warning border-warning/30",
  danger: "bg-danger/10 text-danger border-danger/30",
  info: "bg-primary/10 text-primary border-primary/30",
  muted: "bg-secondary/60 text-txt-secondary border-border",
};

export function Pill({ tone = "muted", children }: { tone?: PillTone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", PILL[tone])}>
      {children}
    </span>
  );
}

export function ActionButton({
  href,
  children,
  icon,
  primary,
  subtle,
  ...rest
}: {
  href: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  primary?: boolean;
  subtle?: boolean;
  "data-testid"?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={rest["data-testid"]}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : subtle
            ? "border border-border bg-transparent text-txt-secondary hover:bg-secondary/50 hover:text-foreground"
            : "border border-border bg-secondary/40 text-foreground hover:bg-secondary/70",
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

export function SectionLink({ href, children, ...rest }: { href: string; children: React.ReactNode; "data-testid"?: string }) {
  return (
    <Link
      href={href}
      data-testid={rest["data-testid"]}
      className="mt-3 flex items-center justify-center gap-1 rounded-xl border border-border/70 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/5"
    >
      {children}
      <ChevronRight className="h-4 w-4" />
    </Link>
  );
}
