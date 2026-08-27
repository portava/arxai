// Phase 6 — the Approval Inbox.
//
// The surface where a human decides whether an order may be placed. Its job is
// to make an INFORMED decision possible, and to make a misinformed one hard.
//
// Four things this page must never do, each of which would be easy:
//
//   1. AUTO-APPROVE, or offer an "approve and send" convenience. Approve and
//      dispatch are separate acts because fusing them makes a retry
//      indistinguishable from a second intentional order.
//   2. Present an OPERATOR DISCLOSURE WAIVER as the user's own consent. Gate 18
//      can pass because an operator waived the risk disclosure; showing that
//      identically to "you accepted" would launder someone else's decision into
//      the user's.
//   3. Render an UNKNOWN outcome as "no trade" or "failed". The server sends
//      `indeterminate` for exactly this, and the copy here says an order may
//      exist.
//   4. Let an expired ticket look actionable. The countdown is live and the
//      buttons disable when it reaches zero, because the server will refuse
//      anyway and a button that cannot work is a lie about what is possible.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Ticket = {
  ticketId: string;
  state: string;
  broker: string;
  accountRef: string;
  instrument: string;
  side: string;
  stakeUsd: number;
  multiplier: number;
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  referenceQuote: number | null;
  expectedPayoutUsd: number | null;
  scannerSignalId: string | null;
  rubyExplanation: string | null;
  riskEvaluation: unknown;
  constitutionVersion: number;
  gateVerdicts: unknown;
  gateVerdictsPassed: boolean;
  disclosureWaivedByOperator: boolean;
  expiresAt: string;
  createdAt: string;
  rejectionReason: string | null;
  venueContractRef: string | null;
  intentId: string;
};

type DispatchResult = {
  ok: boolean;
  indeterminate: boolean;
  refusal: string | null;
  detail: string;
  venueContractRef: string | null;
  dryRun: boolean;
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const LIVE_STATES = new Set(["PENDING", "APPROVED", "DISPATCHING", "UNRESOLVED"]);

function msLeft(expiresAt: string, now: number): number {
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? 0 : t - now;
}

function countdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s left` : `${s}s left`;
}

function money(n: number | null): string {
  return n === null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;
}

export default function ApprovalInboxPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [results, setResults] = useState<Record<string, DispatchResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { body } = await api("/api/me/approval-tickets");
    setTickets(Array.isArray(body?.tickets) ? body.tickets : []);
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Drives the expiry countdown. A stale clock would leave a dead button
  // looking live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function act(ticketId: string, action: "approve" | "reject" | "dispatch") {
    setBusy(ticketId);
    setError(null);
    try {
      const { status, body } = await api(`/api/me/approval-tickets/${ticketId}/${action}`, { method: "POST" });
      if (action === "dispatch") {
        setResults((r) => ({ ...r, [ticketId]: body as DispatchResult }));
      } else if (status >= 400) {
        setError(typeof body?.error === "string" ? body.error : "The action could not be completed.");
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  const live = tickets.filter((t) => LIVE_STATES.has(t.state));
  const past = tickets.filter((t) => !LIVE_STATES.has(t.state));

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Approval inbox</h1>
        <p className="text-sm text-muted-foreground">
          Nothing here is sent until you approve it, and approving is not sending — each is a
          separate, explicit step.
        </p>
      </header>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>
      )}

      {live.length === 0 && (
        <p className="text-sm text-muted-foreground">No trades are waiting for your decision.</p>
      )}

      {live.map((t) => {
        const left = msLeft(t.expiresAt, now);
        const expired = left <= 0;
        const result = results[t.ticketId];
        return (
          <article key={t.ticketId} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge variant={t.side === "BUY" ? "default" : "secondary"}>{t.side}</Badge>
                <span className="font-medium">{t.instrument}</span>
                <span className="text-sm text-muted-foreground">
                  {t.broker} · {t.accountRef}
                </span>
              </div>
              <span className={cn("text-sm", expired ? "text-destructive" : "text-muted-foreground")}>
                {countdown(left)}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div><dt className="text-muted-foreground">Stake</dt><dd>{money(t.stakeUsd)}</dd></div>
              <div><dt className="text-muted-foreground">Multiplier</dt><dd>{t.multiplier}×</dd></div>
              <div><dt className="text-muted-foreground">Reference quote</dt><dd>{t.referenceQuote ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Expected upside</dt><dd>{money(t.expectedPayoutUsd)}</dd></div>
              <div>
                <dt className="text-muted-foreground">Stop</dt>
                {/* An absent stop is stated, never blank — blank reads as "fine". */}
                <dd>{t.stopLossUsd === null ? "none" : money(t.stopLossUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Take profit</dt>
                <dd>{t.takeProfitUsd === null ? "none" : money(t.takeProfitUsd)}</dd>
              </div>
              <div><dt className="text-muted-foreground">Policy version</dt><dd>v{t.constitutionVersion}</dd></div>
              <div>
                <dt className="text-muted-foreground">Risk checks</dt>
                <dd>{t.gateVerdictsPassed ? "passed" : "did not pass"}</dd>
              </div>
            </dl>

            {t.scannerSignalId && (
              <p className="text-sm"><span className="text-muted-foreground">Setup: </span>{t.scannerSignalId}</p>
            )}
            {t.rubyExplanation && (
              <p className="text-sm"><span className="text-muted-foreground">Ruby: </span>{t.rubyExplanation}</p>
            )}

            {/*
              An operator waiver is NOT the user's consent. Shown as its own
              warning so it can never be mistaken for "you already accepted this".
            */}
            {t.disclosureWaivedByOperator && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                The risk disclosure for this account was <strong>waived by an operator</strong>. You
                have not accepted it yourself.
              </div>
            )}

            {t.state === "PENDING" && (
              <div className="flex gap-2">
                <Button
                  disabled={expired || busy === t.ticketId}
                  onClick={() => void act(t.ticketId, "approve")}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  disabled={busy === t.ticketId}
                  onClick={() => void act(t.ticketId, "reject")}
                >
                  Reject
                </Button>
              </div>
            )}

            {t.state === "APPROVED" && (
              <div className="flex items-center gap-2">
                {/* A SEPARATE act from approving. Deliberately not fused. */}
                <Button
                  disabled={expired || busy === t.ticketId}
                  onClick={() => void act(t.ticketId, "dispatch")}
                >
                  Send to broker
                </Button>
                <Button
                  variant="outline"
                  disabled={busy === t.ticketId}
                  onClick={() => void act(t.ticketId, "reject")}
                >
                  Withdraw
                </Button>
              </div>
            )}

            {t.state === "UNRESOLVED" && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                <strong>Outcome unknown.</strong> An order may exist at the broker. This is not a
                failed trade and it must not be retried — it is being reconciled.
              </div>
            )}

            {result && (
              <div
                className={cn(
                  "rounded border p-2 text-sm",
                  result.indeterminate
                    ? "border-amber-500/40 bg-amber-500/10"
                    : result.ok
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-muted",
                )}
              >
                {result.indeterminate ? (
                  <>
                    <strong>Outcome unknown.</strong> An order may exist at the broker. Do not retry;
                    this is being reconciled.
                  </>
                ) : result.dryRun ? (
                  <>
                    <strong>Dry run.</strong> Every check ran and nothing was sent to the broker.
                  </>
                ) : result.ok ? (
                  <>Placed. Broker reference {result.venueContractRef}</>
                ) : (
                  <>Not sent. {result.detail}</>
                )}
              </div>
            )}
          </article>
        );
      })}

      {past.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Recent</h2>
          <ul className="text-sm space-y-1">
            {past.map((t) => (
              <li key={t.ticketId} className="flex justify-between gap-4 border-b py-1">
                <span>{t.side} {t.instrument} · {money(t.stakeUsd)}</span>
                <span className="text-muted-foreground">
                  {t.state.toLowerCase()}
                  {t.rejectionReason ? ` — ${t.rejectionReason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
