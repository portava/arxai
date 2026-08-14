import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PostTradeDebriefModal, RecommendedReplayDrillCard,
} from "@/components/postTradeDebriefs";

interface Debrief {
  id: number; tradeId: number; result: "WIN"|"LOSS"|"BREAKEVEN"|"UNKNOWN";
  followedPlan: number; traderEmotionAfter: string | null;
  biggestMistake: string | null; biggestStrength: string | null;
  lessonLearned: string | null; aiFeedback: string; recommendedDrill: string;
  checklist: Array<{ id: string; answer: string }>;
  createdAt: string;
}
interface ClosedOrder {
  id: number; symbol: string; direction: string; status: string;
  profitLoss: number; closedAt: string | null;
}

const resultTone = (r: string) =>
  r === "WIN" ? "bg-success/20 text-success"
  : r === "LOSS" ? "bg-danger/20 text-danger"
  : "bg-secondary text-txt-secondary";

export default function PostTradeDebriefsPage() {
  const [openTradeId, setOpenTradeId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const debriefs = useQuery<{ debriefs: Debrief[] }>({
    queryKey: ["debriefs"],
    queryFn: async () => (await fetch("/api/post-trade-debriefs?limit=100")).json(),
  });

  // Resolve active paper account first, then pull its orders and filter to
  // closed (non-OPEN) trades client-side. paper API requires accountId.
  const activeAcct = useQuery<{ account: { id: number } | null }>({
    queryKey: ["active-paper-account"],
    queryFn: async () => (await fetch("/api/paper/accounts/active")).json(),
  });
  const closed = useQuery<{ orders: ClosedOrder[] }>({
    queryKey: ["closed-orders", activeAcct.data?.account?.id],
    enabled: !!activeAcct.data?.account?.id,
    queryFn: async () =>
      (await fetch(`/api/paper/orders?accountId=${activeAcct.data!.account!.id}&limit=100`)).json(),
  });

  const debriefedIds = new Set((debriefs.data?.debriefs ?? []).map((d) => d.tradeId));
  const undebriefed = (closed.data?.orders ?? [])
    .filter((o) => o.status !== "OPEN" && !debriefedIds.has(o.id));
  const sel = (debriefs.data?.debriefs ?? []).find((d) => d.id === selected);

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      <header>
        <h1 className="text-2xl font-bold leading-tight">Post-trade Debriefs</h1>
        <p className="text-sm text-txt-secondary">Quick reflection right after a trade closes — process beats outcome. Coaching aid, not predictive.</p>
      </header>

      {undebriefed.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          <h2 className="mb-1.5 text-sm font-semibold text-warning">{undebriefed.length} closed trade(s) waiting for debrief</h2>
          <ul className="space-y-1 text-xs">
            {undebriefed.slice(0, 8).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 rounded border border-warning/30 bg-background/40 p-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-txt-secondary">#{o.id}</span>
                  <span className="text-foreground">{o.symbol} {o.direction}</span>
                  <span className={`font-mono ${o.profitLoss >= 0 ? "text-success" : "text-danger"}`}>
                    {o.profitLoss >= 0 ? "+" : ""}{o.profitLoss.toFixed(2)}
                  </span>
                </div>
                <button onClick={() => setOpenTradeId(o.id)}
                  className="rounded bg-warning/20 px-2 py-0.5 text-[11px] font-semibold text-warning hover:bg-warning/30">Debrief</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold text-foreground">History ({debriefs.data?.debriefs.length ?? 0})</h2>
          <ul className="max-h-[60vh] space-y-1 overflow-auto">
            {(debriefs.data?.debriefs ?? []).map((d) => (
              <li key={d.id}>
                <button onClick={() => setSelected(d.id)}
                  className={`flex w-full items-center justify-between rounded border p-2 text-xs text-left transition ${
                    selected === d.id ? "border-primary bg-primary/10" : "border-border bg-background/40 hover:border-primary/40"}`}>
                  <div>
                    <div className="text-foreground">Trade #{d.tradeId}</div>
                    <div className="text-[10px] text-txt-muted">{new Date(d.createdAt).toLocaleString()}</div>
                  </div>
                  <span className={`rounded px-1.5 py-0.5 font-bold text-[10px] ${resultTone(d.result)}`}>{d.result}</span>
                </button>
              </li>
            ))}
            {(debriefs.data?.debriefs.length ?? 0) === 0 && (
              <li className="rounded border border-border bg-background/40 p-3 text-center text-xs text-txt-muted">No debriefs yet.</li>
            )}
          </ul>
        </div>
        <div className="lg:col-span-2">
          {sel ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-border bg-card p-3 text-xs">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Debrief detail · trade #{sel.tradeId}</h3>
                  <span className={`rounded px-2 py-0.5 font-bold text-[10px] ${resultTone(sel.result)}`}>{sel.result}</span>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  <div className="flex justify-between"><dt className="text-txt-muted">Followed plan</dt><dd className={sel.followedPlan ? "text-success" : "text-warning"}>{sel.followedPlan ? "yes" : "no"}</dd></div>
                  <div className="flex justify-between"><dt className="text-txt-muted">Emotion after</dt><dd>{sel.traderEmotionAfter ?? "—"}</dd></div>
                </dl>
                {sel.biggestStrength && <p className="mt-2"><span className="text-success">Did well: </span>{sel.biggestStrength}</p>}
                {sel.biggestMistake  && <p><span className="text-danger">Would change: </span>{sel.biggestMistake}</p>}
                {sel.lessonLearned   && <p className="mt-1 italic text-txt-secondary">"{sel.lessonLearned}"</p>}
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <h4 className="mb-1 text-xs font-semibold text-foreground">Checklist</h4>
                <ul className="space-y-0.5 text-xs">
                  {sel.checklist.map((c) => (
                    <li key={c.id} className="flex justify-between gap-2 rounded border border-border bg-background/40 px-2 py-1">
                      <span className="text-txt-secondary">{c.id.replaceAll("_", " ")}</span>
                      <span className={`font-mono text-[10px] ${c.answer === "YES" ? "text-success" : c.answer === "NO" ? "text-danger" : "text-txt-secondary"}`}>{c.answer}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <RecommendedReplayDrillCard drill={sel.recommendedDrill} feedback={sel.aiFeedback} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-txt-muted">
              Select a debrief on the left, or open one for an undebriefed trade above.
            </div>
          )}
        </div>
      </div>

      {openTradeId != null && (
        <PostTradeDebriefModal tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
      )}
    </div>
  );
}
