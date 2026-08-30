// The basis/freshness strip for money surfaces.
//
// The economic reconciliation worker journals a verdict comparing the posting
// ledger's broker-cash balance against the broker's reported balance —
// including a CRITICAL "your ledger disagrees with the broker" DISCREPANCY.
// Nothing rendered it, so every dollar figure in ARX was shown with the same
// confidence whether or not it was broker-reconciled. This strip is the one
// place a person learns which of those it is.
//
// HONESTY (inviolable):
//   * The four states come from the server, derived only from a persisted
//     verdict. There is no client-side default and no optimistic state.
//   * A failed read renders "basis unknown — the check itself could not be
//     read", NOT a clean bill of health and NOT silence.
//   * NEVER_RUN is stated plainly. "No reconciliation has run" may never be
//     displayed as agreement.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";

export type LedgerBasisState = "NEVER_RUN" | "DISPUTED" | "UNVERIFIED" | "RECONCILED";

type Latest = {
  verdict: string;
  reason: string;
  differenceMinor: string | null;
  currency: string;
  scale: number;
  trigger: string;
  observedAt: string;
};
type Payload = {
  state: LedgerBasisState;
  headline: string;
  latest: Latest | null;
};

/** Render minor units exactly, without inventing precision. */
export function formatMinor(minor: string | null, currency: string, scale: number): string | null {
  if (minor == null) return null;
  let n: bigint;
  try { n = BigInt(minor); } catch { return null; }
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) return null;
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const s = abs.toString().padStart(scale + 1, "0");
  const whole = s.slice(0, s.length - scale);
  const frac = scale === 0 ? "" : `.${s.slice(s.length - scale)}`;
  return `${neg ? "-" : ""}${whole}${frac} ${currency}`;
}

const TONE: Record<LedgerBasisState | "UNREADABLE", string> = {
  RECONCILED: "border-success/30 bg-success/5 text-success",
  DISPUTED: "border-danger/40 bg-danger/5 text-danger",
  UNVERIFIED: "border-warning/30 bg-warning/5 text-warning",
  NEVER_RUN: "border-border bg-muted/40 text-muted-foreground",
  UNREADABLE: "border-warning/30 bg-warning/5 text-warning",
};

export function LedgerBasisStrip() {
  const [data, setData] = useState<Payload | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/me/economic-reconciliation", { credentials: "include" });
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as Payload;
        if (!cancelled) { setData(body); setUnreadable(false); }
      } catch {
        if (!cancelled) { setData(null); setUnreadable(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="ledger-basis-loading">
        Checking whether your figures are broker-reconciled…
      </div>
    );
  }

  if (unreadable || !data) {
    return (
      <div className={`rounded-md border p-3 text-xs ${TONE.UNREADABLE}`} data-testid="ledger-basis-unreadable">
        <div className="flex items-start gap-2">
          <HelpCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>
            Basis unknown — the ledger-vs-broker check could not be read. This is <strong>not</strong> a statement that
            your figures agree with your broker.
          </span>
        </div>
      </div>
    );
  }

  const Icon = data.state === "RECONCILED" ? CheckCircle2 : data.state === "DISPUTED" ? AlertTriangle : HelpCircle;
  const diff = data.latest ? formatMinor(data.latest.differenceMinor, data.latest.currency, data.latest.scale) : null;

  return (
    <div className={`rounded-md border p-3 text-xs ${TONE[data.state]}`} data-testid={`ledger-basis-${data.state}`}>
      <div className="flex items-start gap-2">
        <Icon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1">
          <div data-testid="ledger-basis-headline">{data.headline}</div>
          {data.latest && (
            <div className="text-muted-foreground">
              Verdict {data.latest.verdict} · {data.latest.reason}
              {diff ? ` · difference ${diff}` : ""} · checked {new Date(data.latest.observedAt).toLocaleString()} ({data.latest.trigger})
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default LedgerBasisStrip;
