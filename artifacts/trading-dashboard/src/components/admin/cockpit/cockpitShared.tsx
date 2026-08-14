// Admin Cockpit — shared UI primitives, formatters and a reason-capture dialog.
//
// SAFETY: this module is presentational only. It performs NO mutations and
// holds NO trust decisions. Every write is delegated by the section components
// to the generated cockpit mutation hooks, which call the audited server
// handlers. Broker masking is decided by the SERVER (values arrive null with a
// `masked` flag); this layer only renders the honest masked placeholder.

import { ReactNode, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

// Auto-refresh cadence for every cockpit read (dense real-time screen).
export const COCKPIT_REFRESH_MS = 15000;
export const cockpitQuery = { refetchInterval: COCKPIT_REFRESH_MS } as const;

type Tone = "success" | "danger" | "warning" | "muted" | "info";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  danger: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  muted: "border-border bg-background/40 text-txt-secondary",
  info: "border-primary/40 bg-primary/10 text-primary",
};

// ── formatters (honest "—" for absent values, never a fabricated 0) ──

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtPl(n: number | null | undefined): { text: string; tone: Tone } {
  if (n === null || n === undefined || Number.isNaN(n)) return { text: "—", tone: "muted" };
  return { text: fmtMoney(n), tone: n > 0 ? "success" : n < 0 ? "danger" : "muted" };
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── primitives ──

export function Chip({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

export function Panel({
  title,
  testid,
  right,
  children,
}: {
  title: string;
  testid: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={testid}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone = "muted",
  testid,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  testid?: string;
}) {
  const toneText =
    tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3" data-testid={testid}>
      <div className="text-[11px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={`mt-1 text-lg font-bold leading-tight ${toneText}`}>{value}</div>
    </div>
  );
}

// Renders a server-masked broker value honestly. When `masked` and the value is
// absent, show an explicit OWNER-only placeholder rather than a misleading 0.
export function MaskedValue({
  value,
  masked,
}: {
  value: ReactNode;
  masked: boolean | null | undefined;
}) {
  if (masked) {
    return (
      <span className="text-txt-muted" title="Visible to OWNER only" data-testid="cockpit-masked">
        •••• <span className="text-[10px]">OWNER</span>
      </span>
    );
  }
  return <>{value}</>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const s = severity.toUpperCase();
  const tone: Tone = s === "CRITICAL" ? "danger" : s === "HIGH" ? "warning" : s === "MEDIUM" ? "info" : "muted";
  return <Chip tone={tone}>{s}</Chip>;
}

export function SectionState({
  query,
  empty,
  emptyLabel,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error?: unknown };
  empty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}) {
  if (query.isLoading) {
    return <div className="p-4 text-sm text-txt-muted" data-testid="cockpit-section-loading">Loading…</div>;
  }
  if (query.isError) {
    const msg = extractErr(query.error);
    const denied = msg === "ADMIN_OR_OWNER_REQUIRED" || msg === "AUTH_REQUIRED";
    return (
      <div className="p-4 text-sm text-danger" data-testid="cockpit-section-error">
        {denied ? "Admin or owner session required." : `Failed to load: ${msg}`}
      </div>
    );
  }
  if (empty) {
    return <div className="p-4 text-sm text-txt-muted" data-testid="cockpit-section-empty">{emptyLabel ?? "Nothing to show."}</div>;
  }
  return <>{children}</>;
}

// ── reason capture (every emergency / freeze / approval write needs a reason) ──

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  busy,
  minLen = 3,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  minLen?: number;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);
  const valid = reason.trim().length >= minLen;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cockpit-reason-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={`Reason (min ${minLen} characters) — recorded in the cockpit audit log`}
          className="min-h-[88px]"
          data-testid="cockpit-reason-input"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} data-testid="cockpit-reason-cancel">
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!valid || busy}
            onClick={() => onConfirm(reason.trim())}
            data-testid="cockpit-reason-confirm"
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── mutation helpers ──

export function extractErr(e: unknown): string {
  if (!e) return "Request was refused.";
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "error" in e) {
    const v = (e as { error?: unknown }).error;
    if (typeof v === "string") return v;
  }
  return String(e);
}

// Invalidates every cockpit read so a write is reflected immediately, then
// toasts. Used by all section mutation handlers.
export function useCockpitAction() {
  const { toast } = useToast();
  const qc = useQueryClient();
  function invalidateAll() {
    void qc.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/admin/cockpit"),
    });
  }
  return {
    invalidateAll,
    onDone(label: string) {
      invalidateAll();
      toast({ title: label });
    },
    onError(e: unknown) {
      toast({ title: "Action failed", description: extractErr(e), variant: "destructive" });
    },
  };
}
