import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/useCurrentUser";

type Run = { id: string; startedAt: string; symbol: string; timeframe: string; setup: string; challengerVersion: string };
type Page = { runs: Run[]; next: string | null; asOf: string };
type Simulation = { settledPairs: number; baseline: { totalR: number | null }; challenger: { totalR: number | null }; pairedDifferenceR: number | null };
type Charges = { currency: string; commission: number | null; fee: number | null; swap: number | null };
type Deal = { commandId: string; deal: string; spread: number | null; movement: number | null; slippage: number | null; charges: Charges | null };
type CostReview = { commandCount: number; reconciledDealCount: number; triggeredExits: number; deals: Deal[] };
type Report = Run & {
  agentId: number; asOf: string; endsAt: string; decisionScope: string; baselineVersion: string; eligibleEntries: number;
  counts: { observations: number; paired: number; different: number; ungraded: number; unresolved: number; sourceChanged: number; noObservedFeed: number };
  simulations: { quoteSideOnly: Simulation; withAssumedCosts: Simulation | null; withMeasuredSlippage: Simulation | null; withMeasuredCosts: Simulation | null };
  assumedCosts: { adverseSlippagePerFillPriceUnits: number; feePerFillPriceUnits: number } | null;
  fleetCohorts?: { revision: string | null; settings: string | null; source: string | null; verified: boolean; matchingBars: number;
    eligibleEntries: number; settledPairs: number; pairedDifferenceR: number | null }[];
  costs: { demo: CostReview; live: CostReview };
};

const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const format = (value: number | null | undefined) => value == null ? "Unknown" : value.toLocaleString(undefined, { maximumSignificantDigits: 7 });
const time = (iso: string) => new Date(iso).toLocaleString();

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error(`Report request failed (${response.status})`);
  return response.json();
}

function BrokerCosts({ label, review }: { label: string; review: CostReview }) {
  const charge = (deal: Deal, key: "commission" | "fee" | "swap") => deal.charges?.[key] == null
    ? "Unknown" : `${format(deal.charges[key])} ${deal.charges.currency}`;
  return <section className="space-y-1">
    <h5 className="text-sm font-medium">{label} account</h5>
    <p className="text-sm text-muted-foreground">{review.commandCount} dispatched commands · {review.reconciledDealCount} reconciled command deals · {review.triggeredExits} reconciled broker-triggered exits</p>
    {review.deals.length > 0 ? <details><summary className="cursor-pointer text-sm">Command deal costs</summary>
      <Table><TableHeader><TableRow>{["Deal", "Spread¹", "Pre-submission movement¹", "Slippage¹", "Commission", "Fees", "Swap"].map(s => <TableHead key={s}>{s}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{review.deals.map(d => <TableRow key={d.commandId}><TableCell>{d.deal}</TableCell><TableCell>{format(d.spread)}</TableCell>
          <TableCell>{format(d.movement)}</TableCell><TableCell>{format(d.slippage)}</TableCell><TableCell>{charge(d, "commission")}</TableCell>
          <TableCell>{charge(d, "fee")}</TableCell><TableCell>{charge(d, "swap")}</TableCell></TableRow>)}</TableBody></Table>
      <p className="text-xs text-muted-foreground">¹ Price units. Positive movement and slippage are adverse.</p>
    </details> : <p className="text-xs text-muted-foreground">Command execution costs are unknown.</p>}
  </section>;
}

export function AtiShadowResult({ report, fullUrl }: { report: Report; fullUrl: string }) {
  const { counts, simulations } = report;
  const bases: [string, Simulation | null][] = [
    ["Quote side only", simulations.quoteSideOnly], ["With assumed costs", simulations.withAssumedCosts],
    ["With measured slippage", simulations.withMeasuredSlippage], ["With measured costs", simulations.withMeasuredCosts],
  ];
  return <div className="space-y-4" aria-label="Shadow comparison">
    <div><h4 className="font-semibold">{report.symbol} · {report.timeframe} · {report.setup}</h4>
      <p className="break-words text-sm">Current bot <code>{report.baselineVersion}</code> · Challenger <code>{report.challengerVersion}</code></p>
      <p className="text-xs text-muted-foreground">{time(report.startedAt)} to {time(report.endsAt)} · Reviewed {time(report.asOf)}</p></div>
    <section className="space-y-1"><h5 className="font-medium">Decision coverage</h5>
      <p className="text-xs text-muted-foreground">{report.fleetCohorts ? "Decisions after fleet supervision" : "Single-agent decisions before fleet supervision"}</p>
      <p className="text-sm">{counts.observations} observations · {counts.paired} matching pairs · {report.eligibleEntries} eligible baseline entries · {counts.different} changed decisions</p>
      <p className="text-sm text-muted-foreground">{counts.noObservedFeed} missing feed · {counts.sourceChanged} changed source · {counts.ungraded} pending · {counts.unresolved} unresolved</p></section>
    {report.fleetCohorts && report.fleetCohorts.length > 0 && <details><summary className="cursor-pointer text-sm">Fleet evidence by build, settings and feed ({report.fleetCohorts.length})</summary>
      <ul className="mt-2 space-y-2 text-sm">{report.fleetCohorts.map((c, i) => <li key={i}>
        <p className="break-all">{c.verified ? "Verified version" : "Unverified version"} · Build {c.revision ?? "unknown"} · Settings {c.settings ?? "unknown"} · Feed {c.source ?? "unknown"}</p>
        <p>{c.matchingBars} matching bars · {c.eligibleEntries} eligible entries · {c.settledPairs} settled pairs · Quote-side paired difference {format(c.pairedDifferenceR)} R</p>
      </li>)}</ul></details>}
    <section className="space-y-1"><h5 className="font-medium">Simulated returns</h5>
      {report.eligibleEntries === 0 ? <p className="text-sm">No eligible entries. This run has no return comparison.</p> :
        !simulations.quoteSideOnly.settledPairs ? <p className="text-sm">No paired outcomes have settled at this cutoff.</p> : null}
      <Table><TableHeader><TableRow>{["Cost basis", "Settled pairs", "Current total R", "Challenger total R", "Paired difference R"].map(s => <TableHead key={s}>{s}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{bases.map(([label, sim]) => <TableRow key={label}><TableCell>{label}</TableCell>{sim ? <>
          <TableCell>{sim.settledPairs}</TableCell><TableCell>{format(sim.baseline.totalR)}</TableCell><TableCell>{format(sim.challenger.totalR)}</TableCell>
          <TableCell>{format(sim.pairedDifferenceR)}</TableCell></> : <TableCell colSpan={4}>Unavailable</TableCell>}</TableRow>)}</TableBody></Table>
      <p className="text-xs text-muted-foreground">R is return in units of initial risk. Each cost basis uses its own eligible samples.</p>
      {report.assumedCosts && <p className="text-xs text-muted-foreground">Per simulated fill, assumed adverse slippage is {format(report.assumedCosts.adverseSlippagePerFillPriceUnits)} and assumed fees are {format(report.assumedCosts.feePerFillPriceUnits)} in price units.</p>}</section>
    <section className="space-y-2"><h5 className="font-medium">MT5 execution costs</h5>
      <p className="text-xs text-muted-foreground">Broker evidence for your instrument and dispatch window. The full report includes strategy attribution and broker-triggered exits.</p>
      <BrokerCosts label="Demo" review={report.costs.demo} /><BrokerCosts label="Live" review={report.costs.live} /></section>
    <a href={fullUrl} target="_blank" rel="noreferrer" className="text-sm underline">Open full report at this cutoff (JSON)</a>
  </div>;
}

function RunPicker({ owner, agent }: { owner: number; agent: number }) {
  const [previous, setPrevious] = useState<string[]>([]);
  const [choice, setChoice] = useState("");
  const before = previous.at(-1);
  const endpoint = `${base}/api/self-trade-ai/agents/${agent}/ati-shadow-runs`;
  const page = useQuery({ queryKey: ["ati-shadow-runs", owner, agent, before ?? null],
    queryFn: ({ signal }) => read<Page>(endpoint + (before ? "?before=" + encodeURIComponent(before) : ""), signal), retry: false });
  const data = page.data;
  const selected = data?.runs.find(r => r.id === choice) ?? data?.runs[0];
  const url = selected && data ? `${endpoint}/${selected.id}?asOf=${encodeURIComponent(data.asOf)}` : "";
  const report = useQuery({ queryKey: ["ati-shadow-report", owner, agent, url], enabled: !!url,
    queryFn: ({ signal }) => read<Report>(url + "&view=summary", signal), retry: false });
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {data?.runs.length ? <label className="grid min-w-0 max-w-full gap-1 text-xs">Shadow run
        <select className="w-full min-w-0 max-w-full rounded-md border bg-background px-2 py-2 text-sm" value={selected?.id} onChange={e => setChoice(e.target.value)}>
          {data.runs.map(r => <option key={r.id} value={r.id}>{time(r.startedAt)} · {r.symbol} {r.timeframe} · {r.challengerVersion} · {r.id.slice(0,8)}</option>)}</select></label> : null}
      <Button variant="outline" size="sm" onClick={() => void page.refetch()} disabled={page.isFetching}>Refresh reports</Button>
      {before && <Button variant="ghost" size="sm" onClick={() => { setChoice(""); setPrevious(previous.slice(0, -1)); }}>Newer runs</Button>}
      {data?.next && <Button variant="ghost" size="sm" onClick={() => { setChoice(""); setPrevious([...previous, data.next!]); }}>Older runs</Button>}
    </div>
    {page.isError ? <p role="alert">Couldn’t load the run list.</p> : !data ? <p role="status">Loading shadow runs…</p> :
      !selected ? <p>No shadow runs are available for this agent on your account.</p> : report.isError ? <p role="alert">The report is unavailable at this cutoff. Refresh to review again.</p> :
      !report.data ? <p role="status">Loading report…</p> : <AtiShadowResult report={report.data} fullUrl={url} />}
  </div>;
}

function OwnerReports({ agent }: { agent: number }) {
  const identity = useCurrentUser();
  if (identity.isLoading) return <p role="status">Checking account…</p>;
  if (!identity.user || identity.isError) return <p role="alert">An authenticated account is required to read shadow reports.</p>;
  return <RunPicker key={`${identity.user.id}-${agent}`} owner={identity.user.id} agent={agent} />;
}

export function AtiShadowReports({ agentId }: { agentId: number }) {
  const [open, setOpen] = useState(false);
  return <Card><CardHeader><CardTitle className="text-base"><button type="button" className="text-left underline-offset-4 hover:underline"
    aria-expanded={open} onClick={() => setOpen(!open)}>ATI shadow reports {open ? "▴" : "▾"}</button></CardTitle></CardHeader>
    {open && <CardContent><OwnerReports agent={agentId} /></CardContent>}</Card>;
}
