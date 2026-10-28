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

// GET /post-trade-debriefs caps at 200 rows; GET /paper/orders returns at
// most the newest 200 orders of one account (any status) and ignores ?limit.
const DEBRIEF_PAGE = 200;
const ORDERS_PAGE_CAP = 200;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Fetch JSON, throwing on a non-2xx so a failed read is never parsed as "no rows". */
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error : r.statusText;
    throw new HttpError(r.status, `HTTP ${r.status}${msg ? `: ${msg}` : ""}`);
  }
  return body as T;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
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
    queryFn: () => getJson<{ debriefs: Debrief[] }>(`/api/post-trade-debriefs?limit=${DEBRIEF_PAGE}`),
  });

  // Resolve active paper account first, then pull its orders and filter to
  // closed (non-OPEN) trades client-side. paper API requires accountId and
  // returns only that account's newest ORDERS_PAGE_CAP orders.
  const activeAcct = useQuery<{ account: { id: number } | null }>({
    queryKey: ["active-paper-account"],
    queryFn: () => getJson<{ account: { id: number } | null }>("/api/paper/accounts/active"),
  });
  const closed = useQuery<{ orders: ClosedOrder[] }>({
    queryKey: ["closed-orders", activeAcct.data?.account?.id],
    enabled: !!activeAcct.data?.account?.id,
    queryFn: () =>
      getJson<{ orders: ClosedOrder[] }>(`/api/paper/orders?accountId=${activeAcct.data!.account!.id}`),
  });

  const debriefRows = debriefs.data?.debriefs ?? [];
  const debriefedIds = new Set(debriefRows.map((d) => d.tradeId));
  const orderRows = closed.data?.orders ?? [];
  // The waiting list is only meaningful when both reads succeeded.
  const waitingKnown = debriefs.isSuccess && closed.isSuccess;
  const undebriefed = waitingKnown
    ? orderRows.filter((o) => o.status !== "OPEN" && !debriefedIds.has(o.id))
    : [];
  const ordersCapped = orderRows.length >= ORDERS_PAGE_CAP;
  const debriefsCapped = debriefRows.length >= DEBRIEF_PAGE;
  const sel = debriefRows.find((d) => d.id === selected);

  // Why the waiting list could not be checked, if it could not.
  let waitingUnchecked: string | null = null;
  if (activeAcct.isError) {
    const e = activeAcct.error;
    waitingUnchecked = e instanceof HttpError && e.status === 404
      ? "You have no active paper account, so closed paper trades waiting for a debrief were not checked."
      : `Closed trades waiting for a debrief could not be checked: the active paper account could not be read (${errText(e)}).`;
  } else if (activeAcct.isSuccess && !activeAcct.data?.account?.id) {
    waitingUnchecked = "You have no active paper account, so closed paper trades waiting for a debrief were not checked.";
  } else if (closed.isError) {
    waitingUnchecked = `Closed trades waiting for a debrief could not be checked: paper orders could not be loaded (${errText(closed.error)}).`;
  } else if (debriefs.isError && closed.isSuccess) {
    waitingUnchecked = "Closed trades waiting for a debrief could not be checked because your debrief history could not be loaded.";
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      <header>
        <h1 className="text-2xl font-bold leading-tight">Post-trade Debriefs</h1>
        <p className="text-sm text-txt-secondary">Quick reflection right after a trade closes — process beats outcome. Coaching aid, not predictive.</p>
      </header>

      {waitingUnchecked && (
        <p className="rounded-lg border border-border bg-background/40 p-3 text-xs text-txt-secondary" data-testid="debriefs-waiting-unchecked">
          {waitingUnchecked}
        </p>
      )}

      {undebriefed.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3" data-testid="debriefs-waiting">
          <h2 className="mb-1.5 text-sm font-semibold text-warning">
            {ordersCapped ? "At least " : ""}{undebriefed.length} closed trade{undebriefed.length === 1 ? "" : "s"} waiting for debrief
          </h2>
          <p className="mb-1.5 text-[11px] text-txt-secondary">
            Checked on your active paper account only{ordersCapped ? `, among its newest ${orderRows.length} orders; older closed trades were not checked` : ""}. Other paper accounts are not included.
            {debriefsCapped ? ` Only your newest ${debriefRows.length} debriefs were compared, so a trade you debriefed earlier may also be listed here.` : ""}
          </p>
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
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            History ({debriefs.isError ? "unavailable" : debriefs.isLoading ? "loading" : debriefsCapped ? `newest ${debriefRows.length}` : debriefRows.length})
          </h2>
          <ul className="max-h-[60vh] space-y-1 overflow-auto">
            {debriefs.isError && (
              <li className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger" data-testid="debriefs-load-error">
                Your debrief history could not be loaded ({errText(debriefs.error)}). Whether you have any debriefs is unknown.
              </li>
            )}
            {debriefRows.map((d) => (
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
            {debriefs.isSuccess && debriefRows.length === 0 && (
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
