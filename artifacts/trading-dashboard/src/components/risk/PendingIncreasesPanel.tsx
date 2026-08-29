import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/design-tokens";
import type { PendingIncrease } from "./riskLimitSave";

// RANK 16 — the missing half of the delayed-increase feature.
//
// routes/risk.ts has had the full lifecycle since capability #42:
//   GET  /api/risk/pending-increases          (per-user, requireUser)
//   POST /api/risk/pending-increases/:id/confirm
//   POST /api/risk/pending-increases/:id/cancel
// and PATCH /risk/settings queues every loosening into it. But nothing in the
// dashboard read any of it: a grep for "pending-increases" across the frontend
// returned zero hits. So a queued increase was invisible and unconfirmable —
// the 24-hour cooling-off period was, in practice, a permanent refusal that no
// screen ever mentioned.
//
// This panel is that screen. It shows every queued increase, the exact time it
// becomes confirmable, and the two actions the server already supports.
//
// Confirm is deliberately NOT auto-fired and NOT enabled early: the whole point
// of the waiting period is that raising your own risk ceiling requires a second,
// later, deliberate act.

const KEY = ["risk", "pending-increases"] as const;

interface PendingResponse {
  pendingIncreases: PendingIncrease[];
  increaseDelayMs: number;
}

async function fetchPending(): Promise<PendingResponse | null> {
  const res = await fetch("/api/risk/pending-increases", { credentials: "include" });
  if (!res.ok) return null;
  const json = (await res.json()) as Partial<PendingResponse> | null;
  if (!json || !Array.isArray(json.pendingIncreases)) return null;
  return { pendingIncreases: json.pendingIncreases, increaseDelayMs: json.increaseDelayMs ?? 0 };
}

function remaining(p: PendingIncrease): string {
  const ms = typeof p.remainingMs === "number"
    ? p.remainingMs
    : Math.max(0, new Date(p.effectiveAt).getTime() - Date.now());
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function PendingIncreasesPanel() {
  const qc = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: fetchPending, refetchInterval: 60_000 });

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "confirm" | "cancel" }) => {
      const res = await fetch(`/api/risk/pending-increases/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => null)) as { error?: string; remainingMs?: number } | null;
      if (!res.ok) {
        // The server refuses an early confirm with 409 + the remaining wait.
        // Report that verbatim rather than pretending the press worked.
        const wait = typeof body?.remainingMs === "number" && body.remainingMs > 0
          ? ` Still ${Math.ceil(body.remainingMs / 60_000)} minute(s) to wait.`
          : "";
        throw new Error(`${body?.error ?? `HTTP ${res.status}`}.${wait}`);
      }
      return body;
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["risk", "settings"] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "The request failed."),
  });

  if (isLoading) return null;

  // A failed read is reported, never rendered as "you have no pending changes".
  if (!data) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning" data-testid="pending-increases-unavailable">
        Your pending risk increases could not be read. This is not a confirmation that you have
        none — do not assume a raised limit is in force.
      </div>
    );
  }

  const pending = data.pendingIncreases.filter((p) => p.status === "PENDING");
  if (pending.length === 0) {
    return (
      <div className="text-xs text-txt-muted" data-testid="pending-increases-empty">
        No risk increases are waiting for confirmation.
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="pending-increases-panel">
      <div className="text-xs text-txt-secondary">
        These raise a risk ceiling, so they are <strong>not in force</strong>. Each one must be
        confirmed again after its waiting period before it takes effect.
      </div>
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger" data-testid="pending-increases-error">
          {error}
        </div>
      )}
      {pending.map((p) => {
        const ready = p.confirmableNow === true
          || new Date(p.effectiveAt).getTime() <= Date.now();
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3 text-sm" data-testid={`pending-increase-${p.field}`}>
            <div className="flex-1 min-w-[12rem]">
              <div className="font-medium text-foreground">{p.field}</div>
              <div className="text-xs text-txt-muted tabular-nums">
                {p.currentValue} → {p.targetValue} · in force: <strong>{p.currentValue}</strong>
              </div>
            </div>
            <Badge className={ready ? STATUS_COLORS.warning.badge : STATUS_COLORS.info.badge}>
              {ready ? "Confirmable now" : `Waits ${remaining(p)}`}
            </Badge>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!ready || act.isPending}
                onClick={() => act.mutate({ id: p.id, action: "confirm" })}
                data-testid={`confirm-increase-${p.field}`}
              >
                Confirm increase
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={act.isPending}
                onClick={() => act.mutate({ id: p.id, action: "cancel" })}
                data-testid={`cancel-increase-${p.field}`}
              >
                Cancel
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
