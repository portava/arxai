// Shared presentation helpers for the Admin Fund Control Center.
//
// SAFETY: read-only formatting + a reason-collecting dialog. No mutations
// happen here; every caller passes its own audited mutation through onConfirm.
// Mirrors the visual language of the investor portal (fmtMoney/FreshnessBadge/
// StatusBadge/EmptyState) so operator and investor surfaces read consistently.

import { ReactNode, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LucideIcon } from "lucide-react";

export function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function fmtUnits(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n);
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function fmtTimeAgo(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 0) return fmtDate(s);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return fmtDate(s);
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  testid,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  testid?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center"
      data-testid={testid}
    >
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

// Distinct from EmptyState: a failed/unavailable fetch must never be drawn as
// "no data" (that reads as false calm — zero balances, no discrepancies). This
// surfaces the failure honestly and offers a retry.
export function ErrorState({
  title = "Data unavailable",
  body = "This data could not be loaded. The backend may be unreachable or returned an error.",
  onRetry,
  busy,
  testid,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  busy?: boolean;
  testid?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-danger/40 bg-danger/5 p-10 text-center"
      data-testid={testid}
    >
      <AlertTriangle className="h-8 w-8 text-danger" />
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={busy} data-testid="button-retry">
          {busy ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: "bg-success/15 text-success",
  APPROVED: "bg-success/15 text-success",
  SETTLED: "bg-success/15 text-success",
  RESOLVED: "bg-success/15 text-success",
  OPEN: "bg-warning/15 text-warning",
  PENDING_APPROVAL: "bg-warning/15 text-warning",
  PENDING: "bg-warning/15 text-warning",
  REQUESTED: "bg-warning/15 text-warning",
  REVIEWING: "bg-warning/15 text-warning",
  INVESTIGATING: "bg-ruby/15 text-ruby",
  UNDER_REVIEW: "bg-ruby/15 text-ruby",
  REJECTED: "bg-danger/15 text-danger",
  CRITICAL: "bg-danger/15 text-danger",
  HIGH: "bg-warning/15 text-warning",
  MEDIUM: "bg-warning/15 text-warning",
  LOW: "bg-primary/15 text-primary",
  CANCELLED: "bg-muted text-muted-foreground",
  DISMISSED: "bg-muted text-muted-foreground",
  SUPERSEDED: "bg-muted text-muted-foreground",
  DRAFT: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const raw = (status ?? "").toUpperCase();
  const label = raw
    ? raw.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";
  return <Badge className={STATUS_CLASS[raw] ?? "bg-muted text-muted-foreground"}>{label}</Badge>;
}

// Freshness ranking so a "worst across all bridges" summary is honest: a single
// stale bridge dominates the headline rather than being hidden by fresh ones.
const FRESHNESS_RANK: Record<string, number> = {
  FRESH: 0,
  DELAYED: 1,
  UNDER_REVIEW: 2,
  STALE: 3,
  MISSING: 4,
};

export function worstFreshness(values: Array<string | null | undefined>): string {
  let worst = "FRESH";
  let worstRank = -1;
  for (const v of values) {
    const f = (v ?? "MISSING").toUpperCase();
    const rank = FRESHNESS_RANK[f] ?? 4;
    if (rank > worstRank) {
      worstRank = rank;
      worst = f;
    }
  }
  return values.length === 0 ? "MISSING" : worst;
}

export function FreshnessBadge({
  freshness,
  asOf,
  className,
}: {
  freshness: string | null | undefined;
  asOf?: string | null;
  className?: string;
}) {
  const f = (freshness ?? "MISSING").toUpperCase();
  const map: Record<string, { cls: string; label: string }> = {
    FRESH: { cls: "bg-success/15 text-success", label: "Live" },
    DELAYED: { cls: "bg-warning/15 text-warning", label: "Delayed" },
    STALE: { cls: "bg-danger/15 text-danger", label: "Stale" },
    UNDER_REVIEW: { cls: "bg-ruby/15 text-ruby", label: "Under review" },
    MISSING: { cls: "bg-muted text-muted-foreground", label: "Unavailable" },
  };
  const m = map[f] ?? map.MISSING;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.cls} ${className ?? ""}`}
      data-testid="freshness-badge"
      title={asOf ? `As of ${fmtDate(asOf)}` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
      {asOf ? <span className="font-normal opacity-80">· {fmtTimeAgo(asOf)}</span> : null}
    </span>
  );
}

export function PnlValue({
  value,
  currency = "USD",
}: {
  value: number | null | undefined;
  currency?: string;
}) {
  if (value == null || Number.isNaN(value)) return <span className="tabular-nums">—</span>;
  const cls = value > 0 ? "text-success" : value < 0 ? "text-danger" : "";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`tabular-nums ${cls}`}>
      {sign}
      {fmtMoney(value, currency)}
    </span>
  );
}

export function StatCard({
  label,
  hint,
  children,
  testid,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-black tabular-nums" data-testid={testid}>
          {children}
        </p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

// Reason-collecting confirmation dialog. Every operator mutation in the Fund
// Control Center routes through this so a ≥3-char reason is always captured for
// the server-side audit log. `extra` lets a caller add a target picker (e.g.
// choosing the destination pool for a trade assignment).
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant = "default",
  busy = false,
  withNote = false,
  noteLabel = "Note (optional)",
  extra,
  extraValid = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: "default" | "destructive";
  busy?: boolean;
  withNote?: boolean;
  noteLabel?: string;
  extra?: ReactNode;
  extraValid?: boolean;
  onConfirm: (reason: string, note?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setReason("");
      setNote("");
    }
  }, [open]);

  const reasonValid = reason.trim().length >= 3;
  const canConfirm = reasonValid && extraValid && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="reason-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">
          {extra}
          <div className="space-y-2">
            <Label htmlFor="reason-input">Reason (required, min 3 characters)</Label>
            <Input
              id="reason-input"
              data-testid="input-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you taking this action?"
              autoFocus
            />
            {!reasonValid && reason.length > 0 ? (
              <p className="text-xs text-danger">A reason of at least 3 characters is required.</p>
            ) : null}
          </div>
          {withNote ? (
            <div className="space-y-2">
              <Label htmlFor="note-input">{noteLabel}</Label>
              <Textarea
                id="note-input"
                data-testid="input-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            data-testid="button-confirm-reason"
            disabled={!canConfirm}
            onClick={() => onConfirm(reason.trim(), note.trim() || undefined)}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
