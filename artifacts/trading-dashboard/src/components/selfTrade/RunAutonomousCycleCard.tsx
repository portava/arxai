// Run one admin-triggered autonomous cycle, with honest operator feedback.
//
// The request can legitimately take 20 s or more: the protective path waits
// (once per cycle, bridges concurrently) for a fresh broker position snapshot
// from the EA before any protective close or stop move. So the card:
//   - shows waiting feedback in the same render as the click, with an
//     elapsed-seconds counter aligned to the click; the polite live region
//     announces only state changes (started, past 20 s, past 45 s, the
//     outcome or error), never the per-second count;
//   - blocks only its own Run button (aria-disabled, so keyboard focus stays on
//     it; no double submit); the page stays usable;
//   - never queues a run while the browser is offline: the click says it was
//     not sent (networkMode "always", so TanStack never pauses the request and
//     sends it later);
//   - says plainly when the wait runs past the expected bound, claiming nothing;
//   - on success reports protective dispatches as "sent to EA — awaiting broker
//     confirmation" (never closed / completed) and every hold reason with its
//     plain-English explanation from the server.
//
// Running / result state is read from the shared TanStack MutationCache (by
// mutation key), not from component state, because the admin page's tabs
// unmount inactive panels: leaving the tab mid-run and coming back must still
// show the running cycle (counted from the original click), keep Run disabled,
// and then show that run's result. The server also refuses an overlapping run
// (409 CYCLE_ALREADY_RUNNING). A settled result shows when it finished, and is
// kept for RUN_RESULT_GC_MS after the run.
import { useEffect, useState } from "react";
import { onlineManager, useMutationState, type MutationState } from "@tanstack/react-query";
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
/** Same key the generated hook uses; shared so state survives a tab remount. */
export const RUN_CYCLE_MUTATION_KEY = ["adminRunSelfTradeAutonomousCycle"];
/** How long a settled run's result stays in the cache (shown with its finish time). */
export const RUN_RESULT_GC_MS = 60 * 60_000;

type RunState = MutationState<RunAutonomousCycleResp, unknown, unknown, unknown>;
type ErrorKind = "conflict" | "outcome-open" | "unreadable" | "failed";

/**
 * Finish time per run, keyed by the run's variables object (the same reference
 * MutationState.variables holds). Written by the mutation-level onSettled, so
 * it is recorded even when the run settles while this card is unmounted.
 */
const settledAtByRun = new WeakMap<object, number>();

/**
 * 409: the server refused because a cycle is already running. 2xx: the server
 * answered but the body could not be read (ResponseParseError), so the cycle
 * ran. No HTTP status (dropped connection) or a gateway 502/503/504: the cycle
 * may still be running on the server. Anything else: the server answered with
 * a failure.
 */
function classifyError(error: unknown): ErrorKind {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) return "conflict";
  if (typeof status === "number" && status >= 200 && status < 300) return "unreadable";
  if (typeof status !== "number" || status === 0 || status === 502 || status === 503 || status === 504)
    return "outcome-open";
  return "failed";
}

function browserOffline(): boolean {
  return !onlineManager.isOnline() || (typeof navigator !== "undefined" && navigator.onLine === false);
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function ago(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute ago";
  return `${min} min ago`;
}

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

function CycleResult({ data }: { data: RunAutonomousCycleResp }) {
  const p = data.protective;
  const holds = holdDetails(data);
  const budgetSec = p ? Math.round(p.waitBudgetMs / 1000) : PROTECTIVE_WAIT_BUDGET_SEC;
  const unresolved = p?.commandRecordedOrUnknown ?? 0;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <Tone tone="info">considered {data.decisionsConsidered}</Tone>
        <Tone tone="success">filled {data.reconciled.filled}</Tone>
        <Tone tone="warning">managed {data.agentsManaged}</Tone>
        <Tone tone="neutral">broker-confirmed modifications {data.positionsModified}</Tone>
        <Tone tone="info">broker-confirmed closes {data.positionsClosed}</Tone>
        <Tone tone="danger">rejected {data.reconciled.rejected}</Tone>
        <span className="text-muted-foreground">cycle {data.cycleId}</span>
      </div>

      {p ? (
        <section aria-label="Protective path" className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
          <div className="mb-1 font-semibold text-foreground">Protective path</div>
          <div className="flex flex-wrap items-center gap-1">
            <Tone tone="info">considered {p.considered}</Tone>
            <Tone tone="warning">sent to EA — awaiting broker confirmation {p.acted}</Tone>
            <Tone tone="neutral">held {p.held}</Tone>
            {unresolved > 0 && <Tone tone="danger">command recorded / outcome unknown {unresolved}</Tone>}
            <span className="text-muted-foreground">
              protective step took {seconds(p.elapsedMs)} (sweep wait budget {budgetSec} s)
              {p.bridges > 0 ? ` · ${p.bridges} bridge${p.bridges === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {unresolved > 0 && (
            <p className="mt-1 text-muted-foreground">
              Command recorded / outcome unknown: a request may have reached the terminal (refused after a command was
              recorded, outcome not yet proven, or the protective step failed). Check the execution feed before acting;
              the reasons are listed below. Held means nothing was sent.
            </p>
          )}
          {p.acted > 0 && (
            <p className="mt-1 text-muted-foreground">
              Sent to EA means the request passed the gated pipeline and was queued in the EA mailbox. The EA picks it up
              on its next poll, and it can still expire or be rejected. It is not a fill or a broker result; the
              execution feed shows the outcome once the broker confirms it.
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
  // Mutation-level callbacks run even if this card unmounted mid-run, so the
  // feed / audit queries are still refreshed when a run settles off-tab (also
  // after an error, whose outcome may still be open), and the finish time is
  // recorded. networkMode "always": an offline click must never be paused and
  // sent later; start() refuses it instead.
  const runCycle = useAdminRunSelfTradeAutonomousCycle({
    mutation: {
      mutationKey: RUN_CYCLE_MUTATION_KEY,
      networkMode: "always",
      gcTime: RUN_RESULT_GC_MS,
      onSettled: (_data, _error, variables) => {
        if (variables && typeof variables === "object") settledAtByRun.set(variables, Date.now());
        onRan?.();
      },
    },
  });
  const runs = useMutationState({
    filters: { mutationKey: RUN_CYCLE_MUTATION_KEY },
    select: (m) => m.state as RunState,
  });
  const [reason, setReason] = useState("");
  // Set on click so feedback renders in the same tick, before the cache notifies.
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  // Set when a click was refused because the browser is offline (nothing sent).
  const [offlineAt, setOfflineAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reasonOk = reason.trim().length >= 3;

  const pendingRun = [...runs].reverse().find((r) => r.status === "pending");
  const cacheSawClick = clickedAt !== null && runs.some((r) => r.submittedAt >= clickedAt);
  const startedAt = pendingRun ? pendingRun.submittedAt : clickedAt !== null && !cacheSawClick ? clickedAt : null;
  const waiting = startedAt !== null || runCycle.isPending;
  const latest = runs[runs.length - 1];
  const settled = !waiting && latest && (latest.status === "success" || latest.status === "error") ? latest : null;
  const settledAt =
    settled && settled.variables && typeof settled.variables === "object"
      ? settledAtByRun.get(settled.variables) ?? null
      : null;

  // Once the cache has the run, it is the source of truth (and a later GC of
  // the settled mutation can never leave a stale "running" behind).
  useEffect(() => {
    if (cacheSawClick) setClickedAt(null);
  }, [cacheSawClick]);

  // Elapsed counter: each update lands on the next whole second after the
  // original click, so a remounted card does not lag the true elapsed time.
  useEffect(() => {
    if (startedAt === null) return;
    let id = 0;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      id = window.setTimeout(tick, 1000 - (Math.max(0, t - startedAt) % 1000));
    };
    tick();
    return () => window.clearTimeout(id);
  }, [startedAt]);

  // Keep "N min ago" on a settled result current.
  const showingSettled = settled !== null;
  useEffect(() => {
    if (!showingSettled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [showingSettled]);

  function start() {
    if (waiting || !reasonOk) return;
    const t = Date.now();
    if (browserOffline()) {
      setOfflineAt(t);
      setNow(t);
      return;
    }
    setOfflineAt(null);
    setClickedAt(t);
    setNow(t);
    runCycle.mutate({ data: { reason: reason.trim() } }, { onSuccess: () => setReason("") });
  }

  const elapsedMs = startedAt !== null ? Math.max(0, now - startedAt) : 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const pastBudget = startedAt !== null && elapsedMs >= PROTECTIVE_WAIT_BUDGET_SEC * 1000;
  const longWait = startedAt !== null && elapsedMs > RUN_CYCLE_LONG_WAIT_MS;
  const error = settled?.status === "error" ? settled.error : null;
  const errorKind = error != null ? classifyError(error) : null;
  const errorMessage = (error as { message?: string } | null)?.message ?? "The run-cycle endpoint refused.";
  const offlineNotice = !waiting && offlineAt !== null;

  // Absolute time goes in the live region; the relative age ticks, so it sits outside it.
  let when = "";
  let age = "";
  if (settled) {
    when = settledAt !== null ? ` at ${clock(settledAt)}` : ` (started at ${clock(settled.submittedAt)})`;
    age = settledAt !== null
      ? `Result from ${ago(now - settledAt)}.`
      : `Run started ${ago(now - settled.submittedAt)}.`;
  }

  // Live-region text: changes only on a state change, never per second.
  let announcement = "";
  if (waiting) {
    announcement = pastBudget
      ? `Cycle still running after ${PROTECTIVE_WAIT_BUDGET_SEC} s; the server has not answered, so no outcome is known yet.`
      : "Cycle started; waiting for the server to answer.";
  } else if (offlineNotice) {
    announcement = `Not sent: this browser is offline (at ${clock(offlineAt!)}), so no cycle was started on the server. Reconnect and press Run cycle again.`;
  } else if (settled?.status === "success" && settled.data) {
    announcement = `Cycle finished${when}; results below.`;
  } else if (errorKind === "conflict") {
    announcement = `Another cycle is still running on the server; this run was not started${when}.`;
  } else if (errorKind === "outcome-open") {
    announcement = `No answer from the server${when} — the cycle may still be running.`;
  } else if (errorKind === "unreadable") {
    announcement = `The server answered${when} but its result could not be read — the cycle ran; check the execution feed.`;
  } else if (errorKind === "failed") {
    announcement = `The run-cycle request failed${when}.`;
  }

  const blocked = waiting || !reasonOk;

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
          {/* aria-disabled, not disabled: a natively disabled button drops keyboard focus to <body>. */}
          <Button
            size="sm"
            aria-disabled={blocked}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={start}
          >
            <Rocket className="mr-1 h-4 w-4" />
            {waiting ? "Running cycle…" : "Run cycle"}
          </Button>
        </div>

        <div data-testid="run-cycle-status" className="space-y-1 text-xs">
          {waiting && (
            <>
              <p data-testid="run-cycle-elapsed" className="font-medium text-amber-200">
                Cycle running — {elapsedSec} s elapsed.
              </p>
              <p className="text-muted-foreground">
                No result yet. A cycle can wait up to {PROTECTIVE_WAIT_BUDGET_SEC} s for a fresh broker position
                snapshot from the EA before any protective action, so {PROTECTIVE_WAIT_BUDGET_SEC} s or more is normal.
                Nothing is reported until the server answers; you can keep using this page, including other tabs.
              </p>
            </>
          )}
          <div data-testid="run-cycle-announce" role="status" aria-live="polite" aria-atomic="true">
            {announcement && (
              <p className={waiting ? "sr-only" : offlineNotice ? "text-amber-300" : "text-muted-foreground"}>
                {announcement}
              </p>
            )}
            {longWait && (
              <p className="mt-1 text-amber-300">
                Taking longer than expected (over {Math.round(RUN_CYCLE_LONG_WAIT_MS / 1000)} s). The server has not
                answered, so no outcome is known yet. Do not start another run; the result will appear here. Leaving
                this page does not cancel a cycle already running on the server — check the execution feed and audit
                log.
              </p>
            )}
            {!waiting && !offlineNotice && errorKind === "outcome-open" && (
              <p className="text-rose-300">
                The connection dropped or a gateway timed out before the server answered ({errorMessage}). The cycle
                may still be running on the server and may still send protective actions to the EA; its outcome will
                appear in the execution feed and audit log. Check there before running again — the server refuses a
                new run while one is still going.
              </p>
            )}
            {!waiting && !offlineNotice && errorKind === "unreadable" && (
              <p className="text-rose-300">
                The server answered but its response could not be read ({errorMessage}). The cycle ran on the server
                and may have sent protective actions to the EA; check the execution feed and audit log for its outcome
                before running again.
              </p>
            )}
            {!waiting && !offlineNotice && errorKind === "conflict" && (
              <p className="text-amber-300">
                {errorMessage} The running cycle&apos;s outcome will appear in the execution feed and audit log.
              </p>
            )}
            {!waiting && !offlineNotice && errorKind === "failed" && (
              <p className="text-rose-300">
                Run-cycle request failed: {errorMessage} Anything the cycle did before failing is in the execution
                feed and audit log.
              </p>
            )}
          </div>
          {!waiting && age && (
            <p data-testid="run-cycle-age" className="text-muted-foreground">
              {age}
            </p>
          )}
        </div>

        {!waiting && settled?.status === "success" && settled.data && (
          <>
            {offlineNotice && (
              <p className="text-xs text-muted-foreground">Previous run finished{when}:</p>
            )}
            <CycleResult data={settled.data} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
