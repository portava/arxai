import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface PaperAccount {
  id: number; accountName: string;
  startingBalance: number; currentBalance: number; equity: number; marginUsed: number;
  isActive: number; createdAt: string;
}

/**
 * A failed read of the active demo account. 503 means the server found the
 * active account but could not value it (no current real quote); any other
 * status means the account could not be read at all. Neither is "no account".
 */
class PaperAccountReadError extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, reason: string | null) {
    super(reason ?? `HTTP ${status}`);
    this.status = status;
    this.reason = reason;
  }
}

function readFailureCopy(err: unknown): string {
  if (err instanceof PaperAccountReadError && err.status === 503) {
    return `Your active demo account could not be valued right now${err.reason ? ` (${err.reason})` : ""}. ` +
      "Balance, equity and P&L are not shown until it can be valued. The account still exists — you do not need a new one.";
  }
  const why = err instanceof PaperAccountReadError ? (err.reason ?? `HTTP ${err.status}`) : "the request failed";
  return `Your demo account could not be loaded (${why}). ` +
    "Wait for it to load before creating another one — creating a new demo account deactivates the current one.";
}

export function PaperAccountCard({ onActive }: { onActive?: (id: number) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Practice");
  const [bal, setBal] = useState(10000);
  const { data, isLoading, isError, error } = useQuery<{ account: PaperAccount | null }>({
    queryKey: ["paper-active"],
    queryFn: async () => {
      const r = await fetch("/api/paper/accounts/active");
      // Only a 404 is a confirmed "no active account".
      if (r.status === 404) return { account: null };
      if (!r.ok) {
        let reason: string | null = null;
        try { const b = await r.json(); if (typeof b?.error === "string" && b.error) reason = b.error; } catch { /* keep status */ }
        throw new PaperAccountReadError(r.status, reason);
      }
      const j = await r.json();
      onActive?.(j.account?.id);
      return j;
    },
    refetchInterval: 5000,
  });
  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/paper/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: name, startingBalance: bal }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paper-active"] }),
  });
  const acc = data?.account;
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/20 p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Demo account</h3>
        <span className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-bold text-white">SIMULATED</span>
      </header>
      {isLoading ? (
        <p className="text-xs text-slate-500" data-testid="paper-account-loading">Loading demo account…</p>
      ) : isError && !acc ? (
        <p className="text-xs text-amber-300" role="alert" data-testid="paper-account-unavailable">{readFailureCopy(error)}</p>
      ) : acc ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">{acc.accountName}</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-slate-500">Balance</span><div className="font-mono text-slate-100">{acc.currentBalance.toFixed(2)}</div></div>
            <div><span className="text-slate-500">Equity</span><div className="font-mono text-slate-100">{acc.equity.toFixed(2)}</div></div>
            <div><span className="text-slate-500">Margin</span><div className="font-mono text-slate-100">{acc.marginUsed.toFixed(2)}</div></div>
            <div><span className="text-slate-500">P&L vs start</span>
              <div className={`font-mono ${acc.equity - acc.startingBalance >= 0 ? "text-green-400" : "text-red-400"}`}>
                {(acc.equity - acc.startingBalance).toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      ) : data?.account === null ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">No active account.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
          <input type="number" value={bal} onChange={(e) => setBal(Number(e.target.value))}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
          <button onClick={() => create.mutate()} disabled={create.isPending}
            className="w-full rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create demo account"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500" data-testid="paper-account-loading">Loading demo account…</p>
      )}
      <p className="mt-2 text-[10px] text-amber-300">Simulated — demo trading does not guarantee live results.</p>
    </div>
  );
}
