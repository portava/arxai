import { useGetAaciDecision, getGetAaciDecisionQueryKey } from "@workspace/api-client-react";
import { aaciCohesionTone, type AaciCohesionTone } from "@workspace/domain/aaci";
import { Link } from "wouter";
import { useViewMode } from "@/hooks/useViewMode";
import { cn } from "@/lib/utils";

// AACI Sync chip — a compact, read-only "systems in sync" read for one symbol.
// ADVISORY/DISPLAY only: it reflects the cross-system cohesion verdict and never
// gates, reorders, or routes any trade. It is NOT a live/demo mode badge. Admins
// can click through to the full System Cohesion page; users see a static chip.
// Honest states: while loading it shows "Sync …"; on error/no data it shows
// "Sync unavailable" (muted) and never fabricates a verdict.

const DOT: Record<AaciCohesionTone, string> = {
  ok: "bg-success",
  muted: "bg-muted",
  warn: "bg-warning",
  danger: "bg-danger",
};
const SHELL: Record<AaciCohesionTone, string> = {
  ok: "border-success/40 text-success bg-success/10",
  muted: "border-border text-txt-secondary bg-muted/40",
  warn: "border-warning/40 text-warning bg-warning/10",
  danger: "border-danger/40 text-danger bg-danger/10",
};

export function AaciSyncChip({
  symbol,
  className,
}: {
  symbol: string | null | undefined;
  className?: string;
}) {
  const { realIsAdmin } = useViewMode();
  const sym = (symbol ?? "").trim();
  const { data, isLoading, isError } = useGetAaciDecision(
    sym,
    undefined,
    {
      query: {
        queryKey: getGetAaciDecisionQueryKey(sym),
        enabled: sym.length > 0,
        staleTime: 30_000,
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
        retry: false,
      },
    },
  );

  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap";

  if (!sym) return null;

  if (isLoading) {
    return (
      <span
        className={cn(base, SHELL.muted, className)}
        data-testid="aaci-sync-chip-loading"
      >
        <span className={cn("h-1.5 w-1.5 rounded-full animate-pulse", DOT.muted)} />
        Sync …
      </span>
    );
  }

  if (isError || !data) {
    return (
      <span
        className={cn(base, SHELL.muted, className)}
        data-testid="aaci-sync-chip-unavailable"
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", DOT.muted)} />
        Sync unavailable
      </span>
    );
  }

  const tone = aaciCohesionTone(data.recommendedAction);
  const label = data.recommendedActionLabel;

  const chip = (
    <span
      className={cn(base, SHELL[tone], realIsAdmin && "hover:brightness-110 cursor-pointer", className)}
      data-testid="aaci-sync-chip"
      title={data.userFacingExplanation}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} />
      <span className="opacity-70">Sync</span>
      <span>{label}</span>
    </span>
  );

  if (realIsAdmin) {
    return (
      <Link href="/admin/system-cohesion" data-testid="aaci-sync-chip-link">
        {chip}
      </Link>
    );
  }
  return chip;
}
