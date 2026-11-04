import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { safeDate } from "@/lib/safeFormat";

// "Convert" does not execute anything. POST /trade-plans/:id/convert creates a
// practice confirmation request (execution_confirmations, PENDING,
// practiceMode, 5-minute expiry) and records the plan as EXECUTED, which on
// this server means "sent to the Pre-Trade Confirmation flow". Copy here says
// what happened and reads the request's real state instead of assuming it.

interface Props {
  planId: number;
  isReady: boolean;
}

export function ConvertToLiveExecutionButton({ planId, isReady }: Props) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const convert = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/trade-plans/${planId}/convert`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data: { executionConfirmationId?: number }) => {
      setMessage(
        `Created practice confirmation request #${data.executionConfirmationId}. It is pending and expires 5 minutes after it was created. ` +
        "No order has been placed. Open the Pre-Trade Confirmation flow to review and confirm it.",
      );
      qc.invalidateQueries({ queryKey: ["trade-plans"] });
    },
    onError: (e: Error) => setMessage(e.message),
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => convert.mutate()}
        disabled={!isReady || convert.isPending}
        className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${
          isReady ? "bg-indigo-600 text-white hover:bg-indigo-500" : "cursor-not-allowed bg-slate-700 text-slate-400"
        }`}
      >
        <Send className="h-4 w-4" />
        {convert.isPending ? "Sending…" : "Send to Pre-Trade Confirmation"}
      </button>
      {!isReady && (
        <p className="mt-2 text-xs text-slate-500">Validate the plan and pass every blocking check to enable sending.</p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${convert.isError ? "text-red-400" : "text-green-400"}`}>{message}</p>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Sending creates a practice confirmation request that expires after 5 minutes. It places no order: any execution still has to be
        confirmed in the Pre-Trade Confirmation flow and pass the Safety Core.
      </p>
    </div>
  );
}

interface ConfirmationState {
  id: number;
  status: string;
  practiceMode: boolean;
  executionResult: string | null;
  executedTradeId: number | null;
  confirmedAtIso: string | null;
  cancelledAtIso: string | null;
  executedAtIso: string | null;
  expiresAtIso: string;
}

function describeRequest(c: ConfirmationState, nowMs: number): { text: string; tone: string } {
  const expiresMs = new Date(c.expiresAtIso).getTime();
  const pastExpiry = Number.isFinite(expiresMs) && expiresMs <= nowMs;
  const at = (iso: string | null) => (iso ? ` at ${safeDate(iso)}` : "");
  // GET /execution-confirmations/:id does not sweep expiry, so a PENDING or
  // CONFIRMED row past its expiry is reported as expired here.
  if (c.status === "EXPIRED" || ((c.status === "PENDING" || c.status === "CONFIRMED") && pastExpiry)) {
    return { text: `Expired${at(c.expiresAtIso)} without being confirmed and executed. No order was placed from this request.`, tone: "text-amber-300" };
  }
  switch (c.status) {
    case "PENDING":
      return { text: `Waiting for your confirmation — expires${at(c.expiresAtIso)}. No order has been placed.`, tone: "text-indigo-200" };
    case "CONFIRMED":
      return { text: `Confirmed${at(c.confirmedAtIso)}, not executed yet — expires${at(c.expiresAtIso)}. No order has been placed.`, tone: "text-indigo-200" };
    case "EXECUTING":
      return { text: "The confirmation flow is executing this request now. Its result has not been recorded yet.", tone: "text-indigo-200" };
    case "CANCELLED":
      return { text: `Cancelled${at(c.cancelledAtIso)}. No order was placed from this request.`, tone: "text-slate-300" };
    case "REJECTED":
      return { text: `Rejected by the safety layer${c.executionResult ? `: ${c.executionResult}` : ""}. No order was placed from this request.`, tone: "text-red-300" };
    case "EXECUTED":
      return {
        text: `The confirmation flow recorded this request as executed${at(c.executedAtIso)}` +
          `${c.practiceMode ? " (practice request)" : ""}` +
          `${c.executedTradeId != null ? `, trade #${c.executedTradeId}` : ""}` +
          `${c.executionResult ? `: ${c.executionResult}` : "."}`,
        tone: "text-slate-200",
      };
    default:
      return { text: `The confirmation flow reports status ${c.status}.`, tone: "text-slate-300" };
  }
}

/** State of the confirmation request a plan was sent to, read from the confirmation itself. */
export function SentToConfirmationStatus({ confirmationId }: { confirmationId: number }) {
  const q = useQuery<ConfirmationState>({
    queryKey: ["execution-confirmation", confirmationId],
    queryFn: async () => {
      const r = await fetch(`/api/execution-confirmations/${confirmationId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });
  // The row does not change when it expires (the read does not sweep expiry),
  // so a refetch of the same row does not re-render this component. While the
  // request is waiting, a timer re-renders it just after its expiry so the
  // text turns to "Expired" on time instead of saying it is still waiting.
  const [tick, setTick] = useState(0);
  const waitingUntilMs = q.data && (q.data.status === "PENDING" || q.data.status === "CONFIRMED")
    ? new Date(q.data.expiresAtIso).getTime()
    : NaN;
  useEffect(() => {
    if (!Number.isFinite(waitingUntilMs)) return;
    const delay = waitingUntilMs - Date.now();
    if (delay < 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(delay + 250, 2_147_000_000));
    return () => clearTimeout(t);
  }, [waitingUntilMs, tick]);
  const state = q.data ? describeRequest(q.data, Date.now()) : null;
  return (
    <div className="rounded-md border border-indigo-700 bg-indigo-950/40 p-3 text-sm text-indigo-200">
      <p>
        Sent to the Pre-Trade Confirmation flow as {q.data?.practiceMode === false ? "" : "practice "}confirmation request #{confirmationId}.
        Sending a plan does not place an order.
      </p>
      {q.isLoading && <p className="mt-1 text-xs text-slate-400">Checking the request&apos;s current state…</p>}
      {q.isError && !q.data && (
        <p className="mt-1 text-xs text-amber-300">The request&apos;s current state could not be loaded.</p>
      )}
      {state && <p className={`mt-1 text-xs ${state.tone}`}>{state.text}</p>}
    </div>
  );
}
