// Capability #44 — manual takeover (/position-control).
//
// The safety affordance that says "stop managing this position for me, I have
// it". It was implemented server-side (/api/me/positions/control) and had no
// screen, so the only way to take a position back from automation was curl.
//
// HONESTY (inviolable):
//   * Every row comes from GET /api/me/positions/control. An unreadable read
//     renders an explicit error, never an empty list — "you have no positions"
//     and "we could not look" must never look the same.
//   * This page never touches the broker. Taking over flips a management
//     state that automated management seams then refuse against; protective
//     monitoring continues. That is stated on the page, not implied.
//   * A refusal from the server (stale state, already taken over) is shown
//     verbatim rather than retried into apparent success.

import { useCallback, useEffect, useState } from "react";
import { Hand } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

type Control = {
  brokerTicket: string;
  symbol: string;
  managementState: string;
  manualTakeoverAt: string | null;
  manualTakeoverReason: string | null;
  manualReleaseAt: string | null;
  open: boolean;
};
type ControlPage = { positions: Control[]; note: string };

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function PositionControlPage() {
  const [page, setPage] = useState<ControlPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [actionErr, setActionErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/me/positions/control", { credentials: "include" });
      if (!r.ok) {
        throw new Error(
          r.status === 401
            ? "Sign in required."
            : r.status === 503
              ? "Position control state could not be read. Nothing is shown — this is not a statement that you have no open positions."
              : `Unavailable (${r.status}).`,
        );
      }
      setPage((await r.json()) as ControlPage);
    } catch (e) {
      setPage(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function press(ticket: string, action: "takeover" | "release") {
    setActionErr("");
    setBusy(ticket);
    try {
      const r = await fetch(`/api/me/positions/control/${encodeURIComponent(ticket)}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "takeover" && reason.trim() ? { reason: reason.trim() } : {}),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setActionErr(`${action === "takeover" ? "Takeover" : "Release"} refused: ${body.error ?? `HTTP ${r.status}`}`);
        return;
      }
      setReason("");
      await load();
    } catch (e) {
      setActionErr(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell
      title="Manual position control"
      description="Take a live position back from automated management, and hand it back when you are done. This page never sends an order to your broker."
      icon={<Hand className="h-6 w-6" />}
    >
      {loading ? (
        <LoadingState label="Loading position control state…" />
      ) : err ? (
        <ErrorState description={err} />
      ) : page ? (
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground" data-testid="position-control-note">{page.note}</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <SectionHeader title="Open positions" description="Only your own positions. Closed positions are not listed." />
              {page.positions.length === 0 ? (
                <EmptyState
                  title="No open positions"
                  description="When a live position is open, its management state and the takeover press appear here."
                />
              ) : (
                <>
                  <label className="block space-y-1 text-sm">
                    <span className="text-muted-foreground">Reason for takeover (optional, journaled)</span>
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-takeover-reason" />
                  </label>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="py-1 pr-3">Ticket</th>
                          <th className="py-1 pr-3">Symbol</th>
                          <th className="py-1 pr-3">Management</th>
                          <th className="py-1 pr-3">Taken over</th>
                          <th className="py-1 pr-3">Released</th>
                          <th className="py-1 pr-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.positions.map((p) => {
                          const manual = p.managementState === "MANUAL_CONTROL";
                          return (
                            <tr key={p.brokerTicket} data-testid={`control-${p.brokerTicket}`}>
                              <td className="py-1 pr-3 font-mono text-xs">{p.brokerTicket}</td>
                              <td className="py-1 pr-3">{p.symbol}</td>
                              <td className="py-1 pr-3">{p.managementState}</td>
                              <td className="py-1 pr-3">{fmt(p.manualTakeoverAt)}</td>
                              <td className="py-1 pr-3">{fmt(p.manualReleaseAt)}</td>
                              <td className="py-1 pr-3">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy === p.brokerTicket}
                                  onClick={() => void press(p.brokerTicket, manual ? "release" : "takeover")}
                                  data-testid={`button-${manual ? "release" : "takeover"}-${p.brokerTicket}`}
                                >
                                  {manual ? "Hand back to ARX" : "Take over"}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {actionErr && <p className="text-sm text-danger" data-testid="position-control-error">{actionErr}</p>}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
