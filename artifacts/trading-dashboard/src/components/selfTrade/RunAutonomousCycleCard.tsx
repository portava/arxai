// Run one admin-triggered autonomous cycle, with honest operator feedback.
//
// The request can legitimately take 20 s or more: the protective path waits
// (once per cycle, bridges concurrently) for a fresh broker position snapshot
// from the EA before any protective close or stop move. So the card:
//   - shows waiting feedback in the same render as the click, with a live
//     elapsed-seconds counter, in a polite live region;
//   - disables only its own Run button (no double submit); the page stays usable;
//   - says plainly when the wait runs past the expected bound, claiming nothing;
//   - on success reports protective dispatches as "sent to EA — awaiting broker
//     confirmation" (never closed / completed) and every hold reason with its
//     plain-English explanation from the server.
import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import {
  useAdminRunSelfTradeAutonomousCycle,
  type RunAutonomousCycleResp,
  type RunAutonomousCycleHoldDetail,
} from "@workspace/api-client-react";

/** Server-side protective wait for a fresh EA sweep (PROTECTIVE_EVIDENCE_WAIT_MS). */
export const PROTECTIVE_WAIT_BUDGET_SEC = 20;
/** Past this, the card says the run is taking longer than expected. */
export const RUN_CYCLE_LONG_WAIT_MS = 45_000;

function Tone({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[tone].badge}`}>
      {children}
    </span>
  );
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function holdTone(kind: string): StatusTone {
  if (kind === "PROTECTIVE") return "warning";
  if (kind === "PAUSE") return "danger";
  return "neutral";
}

function holdDetails(data: RunAutonomousCycleResp): RunAutonomousCycleHoldDetail[] | null {
  if (data.managementHeldDetails) return data.managementHeldDetails;
  if (!data.managementHeld) return null;
  return Object.entries(data.managementHeld).map(([reason, count]) => ({
    reason,
    count,
    kind: "OTHER",
    text: "No explanation was provided by the server; see the self-trade audit log.",
  }));
}

function CycleResult({ data, durationMs }: { data: RunAutonomousCycleResp; durationMs: number | null }) {
  const p = data.protective;
  const holds = holdDetails(data);
  const budgetSec = p ? Math.round(p.waitBudgetMs / 1000) : PROTECTIVE_WAIT_BUDGET_SEC;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <Tone tone="info">considered {data.decisionsConsidered}</Tone>
        <Tone tone="success">filled {data.reconciled.filled}</Tone>
        <Tone tone="warning">managed {data.agentsManaged}</Tone>
        <Tone tone="neutral">broker-confirmed modifications {data.positionsModified}</Tone>
        <Tone tone="info">broker-confirmed closes {data.positionsClosed}</Tone>
        <Tone tone="danger">rejected {data.reconciled.rejected}</Tone>
        <span className="text-muted-foreground">
          cycle {data.cycleId}
          {durationMs != null ? ` · server answered after ${seconds(durationMs)}` : ""}
        </span>
      </div>

      {p ? (
        <section aria-label="Protective path" className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
          <div className="mb-1 font-semibold text-foreground">Protective path</div>
          <div className="flex flex-wrap items-center gap-1">
            <Tone tone="info">considered {p.considered}</Tone>
            <Tone tone="warning">sent to EA — awaiting broker confirmation {p.acted}</Tone>
            <Tone tone="neutral">held {p.held}</Tone>
            <span className="text-muted-foreground">
              waited {seconds(p.elapsedMs)} of {budgetSec} s budget
              {p.bridges > 0 ? ` · ${p.bridges} bridge${p.bridges === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {p.acted > 0 && (
            <p className="mt-1 text-muted-foreground">
              Sent to EA means the request passed the gated pipeline and was handed to the terminal. It is not a fill or a
              broker result; the execution feed shows the outcome once the broker confirms it.
            </p>
          )}
        </section>
      ) : (
        <p className="text-muted-foreground">This server did not report protective-path results for the cycle.</p>
      )}

      {holds && holds.length > 0 ? (
        <ul aria-label="Hold reasons" className="space-y-1">
          {holds.map((h) => (
            <li key={h.reason} className="rounded-md border border-border/60 p-2">
              <div className="flex flex-wrap items-center gap-1">
                <Tone tone={holdTone(h.kind)}>{h.reason}</Tone>
                <span className="text-muted-foreground">× {h.count}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{h.text}</p>
            </li>
          ))}
        </ul>
      ) : holds ? (
        <p className="text-muted-foreground">No management holds this cycle.</p>
      ) : null}
    </div>
  );
}

export function RunAutonomousCycleCard({ onRan }: { onRan?: () => void }) {
  const runCycle = useAdminRunSelfTradeAutonomousCycle();
  const [reason, setReason] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const reasonOk = reason.trim().length >= 3;
  const waiting = startedAt !== null;

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // Waiting ends only when THIS submission settles (success or error).
  useEffect(() => {
    if (startedAt === null) return;
    if ((runCycle.isSuccess || runCycle.isError) && runCycle.submittedAt >= startedAt) {
      setDurationMs(Date.now() - startedAt);
      setStartedAt(null);
    }
  }, [startedAt, runCycle.isSuccess, runCycle.isError, runCycle.submittedAt]);

  function start() {
    if (waiting || runCycle.isPending || !reasonOk) return;
    const t = Date.now();
    setStartedAt(t);
    setNow(t);
    setDurationMs(null);
    runCycle.mutate(
      { data: { reason: reason.trim() } },
      { onSuccess: () => { setReason(""); onRan?.(); } },
    );
  }

  const elapsedMs = waiting ? Math.max(0, now - startedAt) : 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const longWait = waiting && elapsedMs > RUN_CYCLE_LONG_WAIT_MS;
  const errorMessage =
    (runCycle.error as { message?: string } | null | undefined)?.message ?? "The run-cycle endpoint refused.";

  let statusText = "";
  if (waiting) {
    statusText = `Cycle running — ${elapsedSec} s elapsed.`;
  } else if (runCycle.isSuccess && runCycle.data) {
    statusText = "Cycle finished; results below.";
  } else if (runCycle.isError) {
    statusText = "The run-cycle request failed; no result was returned.";
  }

  return (
    <Card className="border-cyan-500/20">
      <CardHeader>
        <CardTitle className="text-sm">Run autonomous cycle</CardTitle>
        <CardDescription className="text-xs">
          Admin-triggered, audited single cycle: evaluates approved decisions, executes the permitted
          ones through the gated pipeline, manages open agent positions, and reconciles ledger / positions
          from real fills. No always-on loop — every run is one controlled, reason-stamped action.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <Label className="text-xs">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this run (≥3 chars)" />
          </div>
          <Button size="sm" disabled={waiting || runCycle.isPending || !reasonOk} onClick={start}>
            <Rocket className="mr-1 h-4 w-4" />
            {waiting || runCycle.isPending ? "Running cycle…" : "Run cycle"}
          </Button>
        </div>

        <div data-testid="run-cycle-status" role="status" aria-live="polite" className="text-xs">
          {statusText && (
            <p className={waiting ? "font-medium text-amber-200" : "text-muted-foreground"}>{statusText}</p>
          )}
          {waiting && (
            <p className="text-muted-foreground">
              No result yet. A cycle can wait up to {PROTECTIVE_WAIT_BUDGET_SEC} s for a fresh broker position snapshot
              from the EA before any protective action, so {PROTECTIVE_WAIT_BUDGET_SEC} s or more is normal. Nothing is
              reported until the server answers; you can keep using this page.
            </p>
          )}
          {longWait && (
            <p className="mt-1 text-amber-300">
              Taking longer than expected (over {Math.round(RUN_CYCLE_LONG_WAIT_MS / 1000)} s). The server has not
              answered, so no outcome is known yet. Do not start another run; the result will appear here. Leaving this
              page does not cancel a cycle already running on the server — check the execution feed and audit log.
            </p>
          )}
        </div>

        {!waiting && runCycle.isError && (
          <p className="text-xs text-rose-300">
            Run-cycle request failed: {errorMessage} Anything the cycle did before failing is in the execution feed and
            audit log.
          </p>
        )}
        {!waiting && runCycle.isSuccess && runCycle.data && (
          <CycleResult data={runCycle.data} durationMs={durationMs} />
        )}
      </CardContent>
    </Card>
  );
}
