// Capability #46 — the broker-native escape route page.
//
// The one page a user needs when they want OUT of ARX and straight to their
// broker: per-connection direct-access instructions built from REAL reported
// connection identity, the last broker-confirmed positions with explicit
// staleness, and the emergency walkthrough. Every value on this page comes
// from /api/me/escape-route; a field the server could not source renders as an
// explicit "not reported" — this page never invents a broker, server, or
// account number.

import { useEffect, useState } from "react";
import { LifeBuoy, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

/** Tiny local pill — the shared StatusPill vocabulary is for trading states,
 *  and inventing new StatusKinds for page-local labels would pollute it. */
function Pill({ label, tone }: { label: string; tone: "neutral" | "warning" | "danger" | "positive" }) {
  const cls =
    tone === "danger" ? "bg-danger/15 text-danger border-danger/30"
      : tone === "warning" ? "bg-warning/15 text-warning border-warning/30"
        : tone === "positive" ? "bg-success/15 text-success border-success/30"
          : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

type Step = { step: number; title: string; detail: string; usesUnknownValue: boolean };
type ConfirmedPosition = {
  brokerTicket: string; symbol: string; side: string; volume: number;
  entryPrice: number; currentPrice: number | null; stopLoss: number | null;
  takeProfit: number | null; floatingPl: number | null; lastSyncedAt: string | null;
};
type Connection = {
  connectionId: number; venue: string; connectionLabel: string | null;
  brokerName: string | null; serverName: string | null;
  maskedAccountIdentifier: string | null; baseCurrency: string | null;
  environment: string;
  directAccessInstructions: Step[];
  lastConfirmedPositions: {
    asOf: string | null; stale: boolean | null;
    positions: ConfirmedPosition[]; unavailableReason: string | null;
  };
  unavailable: string[];
};
type EscapePage = {
  generatedAt: string;
  nonCustodyStatement: string;
  connections: Connection[];
  emergencyProcedure: Step[];
  connectionsUnavailableReason: string | null;
};

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s) => (
        <li key={s.step} className="flex gap-3" data-testid={`step-${s.step}`}>
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
            {s.step}
          </span>
          <div>
            <div className="text-sm font-medium">{s.title}</div>
            <div className="text-sm text-muted-foreground">{s.detail}</div>
            {s.usesUnknownValue && (
              <div className="mt-1 flex items-center gap-1 text-xs text-warning">
                <AlertTriangle className="h-3 w-3" />
                A value this step needs has not been reported — the step tells you where to find it yourself.
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ConnectionCardView({ c }: { c: Connection }) {
  const lc = c.lastConfirmedPositions;
  return (
    <Card data-testid={`escape-connection-${c.connectionId}`}>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{c.connectionLabel ?? "Connection"}</span>
          <Pill label={c.venue} tone="neutral" />
          <Pill
            label={c.environment}
            tone={c.environment === "LIVE" ? "danger" : c.environment === "UNKNOWN" ? "warning" : "neutral"}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
          <dt className="text-muted-foreground">Broker</dt>
          <dd data-testid="broker-name">{c.brokerName ?? "Not reported"}</dd>
          <dt className="text-muted-foreground">Server</dt>
          <dd data-testid="server-name">{c.serverName ?? "Not reported"}</dd>
          <dt className="text-muted-foreground">Account</dt>
          <dd data-testid="masked-account">{c.maskedAccountIdentifier ?? "Not reported"}</dd>
          <dt className="text-muted-foreground">Currency</dt>
          <dd>{c.baseCurrency ?? "Not reported"}</dd>
        </dl>

        {c.unavailable.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground" data-testid="unavailable-reasons">
            <div className="mb-1 font-medium text-warning">Not everything could be sourced honestly:</div>
            <ul className="list-disc pl-4">
              {c.unavailable.map((u) => <li key={u}>{u}</li>)}
            </ul>
          </div>
        )}

        <SectionHeader title="Direct broker access" />
        <StepList steps={c.directAccessInstructions} />

        <SectionHeader title="Last confirmed positions" />
        {lc.unavailableReason ? (
          <p className="text-sm text-muted-foreground" data-testid="positions-unavailable">{lc.unavailableReason}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>As of {lc.asOf ? new Date(lc.asOf).toLocaleString() : "unknown"}</span>
              {lc.stale === true && <Pill label="STALE — verify at the broker" tone="warning" />}
              {lc.stale === false && <Pill label="Recent" tone="positive" />}
            </div>
            {lc.positions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open positions in the last confirmed snapshot.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-3">Ticket</th><th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3">Side</th><th className="py-1 pr-3">Volume</th>
                      <th className="py-1 pr-3">Entry</th><th className="py-1 pr-3">SL</th>
                      <th className="py-1 pr-3">TP</th><th className="py-1 pr-3">Floating P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lc.positions.map((p) => (
                      <tr key={p.brokerTicket} data-testid={`position-${p.brokerTicket}`}>
                        <td className="py-1 pr-3 font-mono text-xs">{p.brokerTicket}</td>
                        <td className="py-1 pr-3">{p.symbol}</td>
                        <td className="py-1 pr-3">{p.side}</td>
                        <td className="py-1 pr-3">{p.volume}</td>
                        <td className="py-1 pr-3">{p.entryPrice}</td>
                        <td className="py-1 pr-3">{p.stopLoss ?? "—"}</td>
                        <td className="py-1 pr-3">{p.takeProfit ?? "—"}</td>
                        <td className="py-1 pr-3">{p.floatingPl ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The broker's own Trade tab is the truth — this snapshot is ARX's last confirmed view and can be behind.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function EscapeRoutePage() {
  const [page, setPage] = useState<EscapePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/me/escape-route", { credentials: "include" });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in required." : `Unavailable (${response.status}).`);
        const data = (await response.json()) as EscapePage;
        if (!cancelled) setPage(data);
      } catch (e) {
        if (!cancelled) setErr(`Failed to load the escape route: ${String(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <PageShell
      title="Broker escape route"
      description="How to reach your money at your broker directly — without ARX in the path. Built from your real connection data; anything unreported says so."
      icon={<LifeBuoy className="h-6 w-6" />}
      readOnly
    >
      {loading ? (
        <LoadingState label="Loading your escape route…" />
      ) : err ? (
        <ErrorState description={err} />
      ) : page ? (
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm" data-testid="non-custody-statement">{page.nonCustodyStatement}</p>
            </CardContent>
          </Card>

          {page.connectionsUnavailableReason && (
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-warning" data-testid="connections-unavailable">
                  {page.connectionsUnavailableReason}
                </p>
              </CardContent>
            </Card>
          )}

          {page.connections.length === 0 && !page.connectionsUnavailableReason ? (
            <EmptyState
              title="No broker connections"
              description="Once a broker connection reports in, its direct-access instructions appear here."
            />
          ) : (
            page.connections.map((c) => <ConnectionCardView key={c.connectionId} c={c} />)
          )}

          <Card data-testid="emergency-procedure">
            <CardContent className="space-y-4 pt-6">
              <SectionHeader title="Emergency procedure" />
              <StepList steps={page.emergencyProcedure} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
