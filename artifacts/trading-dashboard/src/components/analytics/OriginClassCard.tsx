// Capability #45 — comparative origin-class analytics, rendered.
//
// GET /api/me/trades/origin-analytics shipped with no consumer, so a user
// could not see whether their manual trades, ARX-assisted trades, or fully
// automated trades actually performed differently.
//
// HONESTY (inviolable):
//   * winRate and expectancy are typed honest nulls when there is nothing to
//     compute from — rendered "—", never 0% and never $0.00.
//   * The UNTAGGED bucket is shown as its own row. Historical trades that
//     predate origin tagging are never folded into a class.
//   * pnlExcludedCount is displayed, so an aggregate can never silently
//     shrink behind the reader's back.
//   * `comparable: false` is stated: fewer than two tagged classes with closed
//     trades means the comparison means nothing yet, and the page says so.

import { useEffect, useState } from "react";

type Stats = {
  originClass: string;
  count: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancy: number | null;
  pnlExcludedCount: number;
  discipline?: unknown;
};
type Payload = {
  classes: Stats[];
  totalTrades: number;
  taggedTrades: number;
  untaggedTrades: number;
  comparable: boolean;
  notes: string[];
};

const CLASS_LABELS: Record<string, string> = {
  MANUAL: "You decided and placed it",
  ASSISTED: "ARX suggested, you approved",
  MODIFIED: "ARX suggested, you changed it",
  AUTOMATED: "ARX decided and placed it",
  UNTAGGED: "Not tagged (predates origin tracking)",
};

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}
function money(v: number | null): string {
  return v == null ? "—" : v.toFixed(2);
}

export function OriginClassCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/me/trades/origin-analytics", { credentials: "include" });
        if (!r.ok) throw new Error(r.status === 401 ? "Sign in required." : `Unavailable (${r.status}).`);
        const body = (await r.json()) as Payload;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="rounded-2xl border border-border bg-card p-4 text-sm text-txt-muted" data-testid="origin-analytics-loading">Loading origin analytics…</div>;
  }
  if (err || !data) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 text-sm text-warning" data-testid="origin-analytics-error">
        Origin analytics could not be read ({err || "no response"}). No comparison is shown — this is not a statement
        that your trade origins perform the same.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid="origin-analytics-card">
      <h3 className="text-sm font-semibold">Performance by who decided the trade</h3>
      <p className="mt-1 text-xs text-txt-muted">
        {data.totalTrades} trade(s) total · {data.taggedTrades} tagged · {data.untaggedTrades} untagged
      </p>
      {!data.comparable && (
        <p className="mt-2 text-xs text-warning" data-testid="origin-not-comparable">
          Not yet comparable: fewer than two origin classes have closed trades, so any difference between these rows
          is noise rather than evidence.
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-txt-muted">
              <th className="py-1 pr-3">Origin</th>
              <th className="py-1 pr-3">Trades</th>
              <th className="py-1 pr-3">Open</th>
              <th className="py-1 pr-3">Closed</th>
              <th className="py-1 pr-3">Win rate</th>
              <th className="py-1 pr-3">Avg realised P/L</th>
              <th className="py-1 pr-3">Excluded from P/L</th>
            </tr>
          </thead>
          <tbody>
            {data.classes.map((c) => (
              <tr key={c.originClass} data-testid={`origin-row-${c.originClass}`}>
                <td className="py-1 pr-3">{CLASS_LABELS[c.originClass] ?? c.originClass}</td>
                <td className="py-1 pr-3">{c.count}</td>
                <td className="py-1 pr-3">{c.openCount}</td>
                <td className="py-1 pr-3">{c.closedCount}</td>
                <td className="py-1 pr-3">{pct(c.winRate)}</td>
                <td className="py-1 pr-3">{money(c.expectancy)}</td>
                <td className="py-1 pr-3">{c.pnlExcludedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.notes.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-xs text-txt-muted" data-testid="origin-notes">
          {data.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <p className="mt-3 text-xs text-txt-muted">
        A dash means there is nothing to compute from yet, not a zero.
      </p>
    </div>
  );
}

export default OriginClassCard;
