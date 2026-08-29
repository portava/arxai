import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface PaperAccount {
  id: number; accountName: string;
  startingBalance: number; currentBalance: number; equity: number; marginUsed: number;
  isActive: number; createdAt: string;
}

export function PaperAccountCard({ onActive }: { onActive?: (id: number) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Practice");
  const [bal, setBal] = useState(10000);
  const { data } = useQuery<{ account: PaperAccount }>({
    queryKey: ["paper-active"],
    queryFn: async () => {
      const r = await fetch("/api/paper/accounts/active");
      if (r.status === 404) return { account: null as unknown as PaperAccount };
      if (!r.ok) throw new Error("failed");
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
    <div className="rounded-lg border border-warning/40 bg-warning/20 p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Demo account</h3>
        <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-white">SIMULATED</span>
      </header>
      {acc ? (
        <div className="space-y-2">
          <p className="text-xs text-txt-secondary">{acc.accountName}</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-txt-muted">Balance</span><div className="font-mono text-foreground">{acc.currentBalance.toFixed(2)}</div></div>
            <div><span className="text-txt-muted">Equity</span><div className="font-mono text-foreground">{acc.equity.toFixed(2)}</div></div>
            <div><span className="text-txt-muted">Margin</span><div className="font-mono text-foreground">{acc.marginUsed.toFixed(2)}</div></div>
            <div><span className="text-txt-muted">P&L vs start</span>
              <div className={`font-mono ${acc.equity - acc.startingBalance >= 0 ? "text-success" : "text-danger"}`}>
                {(acc.equity - acc.startingBalance).toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-txt-secondary">No active account.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground" />
          <input type="number" value={bal} onChange={(e) => setBal(Number(e.target.value))}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground" />
          <button onClick={() => create.mutate()} disabled={create.isPending}
            className="w-full rounded bg-warning px-3 py-1.5 text-xs font-semibold text-white hover:bg-warning disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create demo account"}
          </button>
        </div>
      )}
      <p className="mt-2 text-[10px] text-warning">Simulated — demo trading does not guarantee live results.</p>
    </div>
  );
}
