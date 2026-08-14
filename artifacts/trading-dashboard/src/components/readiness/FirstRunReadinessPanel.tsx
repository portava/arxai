import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, Info, XCircle, ArrowRight } from "lucide-react";

type ReadinessStatus = "PASS" | "WARN" | "INFO" | "FAIL";
interface ReadinessItem {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  cta?: { label: string; href: string } | null;
}
interface ReadinessResponse {
  generatedAt: string;
  items: ReadinessItem[];
  summary: { passed: number; total: number; blockingFailures: number; readyForFirstTrade: boolean };
  safetyMode: "paper_only";
  liveLocked: boolean;
  readOnlyMode: boolean;
}

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === "PASS") return <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />;
  if (status === "WARN") return <AlertTriangle size={18} className="text-amber-400 shrink-0" />;
  if (status === "FAIL") return <XCircle size={18} className="text-red-400 shrink-0" />;
  return <Info size={18} className="text-zinc-400 shrink-0" />;
}

export function FirstRunReadinessPanel() {
  const q = useQuery<ReadinessResponse>({
    queryKey: ["first-run-readiness"],
    queryFn: async () => {
      const r = await fetch("/api/me/first-run-readiness", { credentials: "include" });
      if (!r.ok) throw new Error(`readiness check failed (${r.status})`);
      return r.json();
    },
    refetchInterval: 60_000,
  });

  return (
    <Card className="border-card-border" data-testid="first-run-readiness-panel">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
          First-run readiness
          <span className="text-[10px] font-normal text-zinc-400 normal-case">
            live trading armed
          </span>
        </CardTitle>
        {q.data && (
          <p className="text-xs text-zinc-400 mt-1">
            {q.data.summary.passed}/{q.data.summary.total} checks passing
            {q.data.summary.readyForFirstTrade ? " — ready to place your first demo trade." : "."}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {q.isLoading && <div className="text-xs text-zinc-400">Checking your readiness…</div>}
        {q.isError && (
          <div className="text-xs text-amber-400">
            Could not load readiness right now. Refresh to retry.
          </div>
        )}
        {q.data && (
          <ul className="grid gap-2">
            {q.data.items.map((it) => (
              <li
                key={it.key}
                className="flex items-start gap-3 p-3 rounded border border-zinc-800/80 bg-zinc-900/30"
                data-testid={`readiness-item-${it.key}`}
              >
                <div className="mt-0.5"><StatusIcon status={it.status} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-zinc-100">{it.label}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">{it.detail}</div>
                </div>
                {it.cta && (
                  <a
                    href={it.cta.href}
                    className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 shrink-0"
                    data-testid={`readiness-cta-${it.key}`}
                  >
                    {it.cta.label} <ArrowRight size={12} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-zinc-500 mt-4 leading-relaxed">
          Every status is read from the backend. Live trading remains BLOCKED; all order
          flows route to the demo engine. Safety alerts are read-only — they never close a trade.
        </p>
      </CardContent>
    </Card>
  );
}
