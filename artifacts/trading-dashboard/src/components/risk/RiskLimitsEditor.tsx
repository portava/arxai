import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PendingIncreasesPanel } from "./PendingIncreasesPanel";
import {
  classifyRiskSave, saveHeadline,
  type FieldOutcome, type RiskSettingsPatchResponse,
} from "./riskLimitSave";

// RANK 16 — the risk editor that tells the truth about what a save did.
//
// The old editor (settings.tsx) used an UNCONTROLLED `defaultValue` and toasted
// "Saved ✓" on every 2xx, discarding the `appliedNow` / `pendingIncreases` /
// `queueFailure` fields the server returns. A user raising Max Daily Loss %
// therefore saw their typed number sitting in the box under a green tick, and
// believed the looser limit was live. It was queued behind a 24-hour
// confirmation they had no screen to press — or, if `queueFailure` was set,
// silently dropped.
//
// Here:
//   * inputs are CONTROLLED off the server value, so a queued or refused
//     increase visibly snaps back to what is actually in force;
//   * each field renders its own outcome from the response — applied, queued
//     with the confirmable-at time, or dropped with the reason;
//   * PendingIncreasesPanel gives the confirm/cancel actions that already
//     existed server-side and had no UI at all.

const RISK_FIELDS = [
  { key: "riskPerTradePct", label: "Risk Per Trade (%)", step: "0.01" },
  { key: "maxDailyLossPct", label: "Max Daily Loss (%)", step: "0.01" },
  { key: "maxWeeklyLossPct", label: "Max Weekly Loss (%)", step: "0.01" },
  { key: "maxLotSize", label: "Max Lot Size", step: "0.01" },
  { key: "maxOpenTrades", label: "Max Open Trades", step: "1" },
  { key: "minConfidenceScore", label: "Min Confidence (%)", step: "1" },
] as const;

type RiskKey = (typeof RISK_FIELDS)[number]["key"];

const SETTINGS_KEY = ["risk", "settings"] as const;

type RiskSettings = Partial<Record<RiskKey, number>> & { riskMode?: string };

async function fetchRiskSettings(): Promise<RiskSettings | null> {
  const res = await fetch("/api/risk/settings", { credentials: "include" });
  if (!res.ok) return null;
  const json = (await res.json()) as RiskSettings | null;
  if (!json || typeof json !== "object") return null;
  return json;
}

const OUTCOME_CLASS: Record<FieldOutcome["kind"], string> = {
  applied: "text-success",
  queued: "text-warning",
  dropped: "text-danger",
  unchanged: "text-txt-muted",
};

export function RiskLimitsEditor() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchRiskSettings });
  const [draft, setDraft] = React.useState<Partial<Record<RiskKey, string>>>({});
  const [outcomes, setOutcomes] = React.useState<FieldOutcome[]>([]);
  const [headline, setHeadline] = React.useState<{ title: string; tone: "ok" | "warn" | "error" } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (patch: Partial<Record<RiskKey, number>>) => {
      const res = await fetch("/api/risk/settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => null)) as (RiskSettingsPatchResponse & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `The server refused the change (HTTP ${res.status}).`);
      return { body, fields: Object.keys(patch) };
    },
    onSuccess: ({ body, fields }) => {
      setError(null);
      const next = classifyRiskSave(fields, body);
      setOutcomes(next);
      setHeadline(saveHeadline(next));
      // Clear the draft so every input re-reads the server value: a queued or
      // dropped increase must visibly snap back to what is in force.
      setDraft({});
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      void qc.invalidateQueries({ queryKey: ["risk", "pending-increases"] });
    },
    onError: (e: unknown) => {
      setOutcomes([]);
      setHeadline(null);
      setDraft({});
      setError(e instanceof Error ? e.message : "The change was not saved.");
    },
  });

  if (isLoading) return <div className="text-sm text-txt-muted">Loading your risk limits…</div>;

  if (!settings) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning" data-testid="risk-settings-unavailable">
        Your risk limits could not be read, so none are shown and none can be edited here. This is
        not a statement that you have no limits — it means we could not determine them.
      </div>
    );
  }

  const outcomeFor = (key: RiskKey) => outcomes.find((o) => o.field === key) ?? null;
  const dirty = RISK_FIELDS.filter(({ key }) => {
    const d = draft[key];
    return d !== undefined && d !== "" && Number(d) !== settings[key];
  });

  const submit = () => {
    const patch: Partial<Record<RiskKey, number>> = {};
    for (const { key } of dirty) {
      const v = Number(draft[key]);
      if (Number.isFinite(v)) patch[key] = v;
    }
    if (Object.keys(patch).length > 0) save.mutate(patch);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-txt-secondary">
        Lowering a limit applies immediately. <strong>Raising</strong> one does not: it is queued for
        a waiting period and must be confirmed again before it takes effect. Until you confirm it,
        your current, tighter limit stays in force.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {RISK_FIELDS.map(({ key, label, step }) => {
          const serverValue = settings[key];
          const outcome = outcomeFor(key);
          return (
            <div key={key}>
              <label className="text-xs text-txt-secondary mb-1 block" htmlFor={`risk-${key}`}>{label}</label>
              <Input
                id={`risk-${key}`}
                type="number"
                step={step}
                className="tabular-nums"
                // Controlled off the server value — the previous editor used
                // defaultValue, so a refused or queued increase stayed on screen
                // looking applied.
                value={draft[key] ?? (serverValue ?? "")}
                disabled={save.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                data-testid={`input-risk-${key}`}
              />
              <div className="mt-1 text-[11px] tabular-nums text-txt-muted">
                In force: <strong>{serverValue ?? "—"}</strong>
              </div>
              {outcome && (
                <div className={`mt-1 text-[11px] ${OUTCOME_CLASS[outcome.kind]}`} data-testid={`risk-outcome-${key}`}>
                  {outcome.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={dirty.length === 0 || save.isPending} data-testid="button-save-risk-limits">
          {save.isPending ? "Saving…" : dirty.length === 0 ? "No changes" : `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}`}
        </Button>
        {headline && (
          <span
            className={`text-xs ${headline.tone === "ok" ? "text-success" : headline.tone === "warn" ? "text-warning" : "text-danger"}`}
            data-testid="risk-save-headline"
          >
            {headline.title}
          </span>
        )}
        {error && <span className="text-xs text-danger" data-testid="risk-save-error">{error}</span>}
      </div>

      <div className="pt-2 border-t border-border/60 space-y-2">
        <div className="text-xs font-semibold text-foreground">Increases waiting for confirmation</div>
        <PendingIncreasesPanel />
      </div>
    </div>
  );
}
