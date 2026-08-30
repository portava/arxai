// Admin → Edge capacity (foundation gate #23).
//
// POST /api/admin/learning/edges/:id/capacity shipped with no UI, so the
// ruin/capacity-simulator verdict and the USD deployable ceiling that gate #23
// requires could only be pressed with curl — and gate #23 refuses every
// capacity-governed LIVE entry until they are recorded.
//
// This page now carries three things:
//   1. GATE READOUT — what gate #23 does to a driver-placed live entry on each
//      edge RIGHT NOW, with the gate's own reason. The all-refuse state is the
//      correct state; it should be legible, not mysterious.
//   2. PROPOSAL — what the simulator would say on the evidence actually
//      recorded, or an explicit INSUFFICIENT_EVIDENCE listing what is missing.
//   3. THE PRESS — recording an estimate, which stays the admin's.
//
// HONESTY (inviolable):
//   * A proposal NEVER fills the form by itself. Adopting proposed inputs is
//     its own visible press, and the admin still presses record afterwards.
//   * The simulator inputs are the operator's declared assumptions unless they
//     explicitly adopted the proposal's. This page labels which.
//   * No field is ever pre-filled with a plausible-looking number: an empty
//     field stays empty and the press stays disabled.
//   * A pressed USD ceiling is honoured ONLY behind an ESTIMATED verdict; the
//     server decides that and its note is shown unchanged. The USD ceiling is
//     never proposed — no evidence in this system can produce it.
//   * This page writes capacity_* columns only. It cannot promote an edge.

import { useCallback, useEffect, useState } from "react";
import { Gauge, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type Json = Record<string, unknown>;

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
  const r = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await r.json().catch(() => ({}))) as Json;
  return { ok: r.ok, status: r.status, body };
}

function Raw({ value, testid }: { value: unknown; testid?: string }) {
  if (value === undefined) return null;
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-snug" data-testid={testid}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Numeric field with no default. Returns undefined for blank so a blank field
 *  can never be sent to the simulator as a confident zero. */
function num(v: string): number | undefined {
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function usd(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : "unknown";
}

// ── Shapes returned by GET /admin/learning/edge-capacity/proposals ──────────
// Mirrored loosely: the server is the source of truth and its strings are
// rendered verbatim rather than re-worded here.

interface ProposalGap { code: string; missing: string; wouldBeSettledBy: string }
interface Proposal {
  verdict: "PROPOSED" | "INSUFFICIENT_EVIDENCE";
  confidence: string;
  proposedCapacityStatus: string | null;
  proposedCapacityRiskR: number | null;
  proposedMaxDeployedUsd: null;
  maxDeployedUsdReason: string;
  simulatorInput: Record<string, unknown> | null;
  gaps: ProposalGap[];
  optimisticAssumptions: string[];
  sampleSizes: Record<string, number>;
  reasons: string[];
}
interface Readout {
  wouldAdmitAnEntry: boolean;
  gateDetail: string | null;
  blocker: string | null;
  remedy: string | null;
  effectiveCeilingUsd: number | null;
  deployedUsd: number | null;
  headroomUsd: number | null;
  awaitingOwnerPress: boolean;
}
interface ProposalItem {
  edgeId: number;
  name: string;
  versionTag: string;
  recorded: {
    capacityStatus: string | null;
    capacityRiskR: number | null;
    capacityMaxDeployedUsd: number | null;
    capacityRecordedByAdminId: number | null;
    capacityEstimatedAt: string | null;
    adminAuthored: boolean;
  };
  evidence: Record<string, unknown>;
  proposal: Proposal;
  readout: Readout;
}
interface FleetSummary {
  edges: number; admitting: number; refusing: number;
  awaitingOwnerPress: number; headline: string;
}

export default function AdminEdgeCapacityPage() {
  const [edges, setEdges] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);

  const [items, setItems] = useState<ProposalItem[] | null>(null);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [propErr, setPropErr] = useState("");
  const [propLoading, setPropLoading] = useState(false);

  const [edgeId, setEdgeId] = useState("");
  const [winRate, setWinRate] = useState("");
  const [avgWinR, setAvgWinR] = useState("");
  const [avgLossR, setAvgLossR] = useState("");
  const [maxDeployedUsd, setMaxDeployedUsd] = useState("");
  const [overrideUsd, setOverrideUsd] = useState("");
  /** Set only by the explicit "adopt" press, cleared by any manual edit. */
  const [adoptedFrom, setAdoptedFrom] = useState<number | null>(null);

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/learning/edges");
    if (!r.ok) {
      setEdges(null);
      setErr(`Edge library unavailable (${r.status}): ${String(r.body.message ?? r.body.error ?? "")}`);
      return;
    }
    setEdges(r.body);
  }, []);

  const loadProposals = useCallback(async () => {
    setPropErr("");
    setPropLoading(true);
    const r = await call("/api/admin/learning/edge-capacity/proposals");
    setPropLoading(false);
    if (!r.ok) {
      setItems(null);
      setSummary(null);
      setPropErr(`Proposals unavailable (${r.status}): ${String(r.body.message ?? r.body.error ?? "")} — this is an UNREADABLE state, not an empty one.`);
      return;
    }
    setItems((r.body.items as ProposalItem[] | undefined) ?? []);
    setSummary((r.body.summary as FleetSummary | undefined) ?? null);
  }, []);

  useEffect(() => { void load(); void loadProposals(); }, [load, loadProposals]);

  const ready =
    num(edgeId) !== undefined &&
    num(winRate) !== undefined &&
    num(avgWinR) !== undefined &&
    num(avgLossR) !== undefined;

  /** Copies a proposal's measured inputs into the form. This is a PRESS, not
   *  an auto-fill: the admin still has to press record, and the fact that the
   *  inputs came from the proposal is shown next to the record button. */
  function adopt(item: ProposalItem) {
    const si = item.proposal.simulatorInput;
    if (!si) return;
    setEdgeId(String(item.edgeId));
    setWinRate(String(si["winRate01"] ?? ""));
    setAvgWinR(String(si["avgWinR"] ?? ""));
    setAvgLossR(String(si["avgLossR"] ?? ""));
    setAdoptedFrom(item.edgeId);
  }

  function edited<T>(setter: (v: T) => void) {
    return (v: T) => { setAdoptedFrom(null); setter(v); };
  }

  async function press() {
    setBusy(true);
    setResult(null);
    const payload: Json = {
      simulator: {
        winRate01: num(winRate),
        avgWinR: num(avgWinR),
        avgLossR: num(avgLossR),
      },
    };
    const ceiling = num(maxDeployedUsd);
    if (ceiling !== undefined) payload.maxDeployedUsd = ceiling;
    const override = num(overrideUsd);
    if (override !== undefined) payload.deployCapOverrideUsd = override;

    const r = await call(`/api/admin/learning/edges/${num(edgeId)}/capacity`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setResult({ httpStatus: r.status, ...r.body });
    if (r.ok) { await load(); await loadProposals(); }
    setBusy(false);
  }

  return (
    <AdminDiagnosticsGate
      pageTitle="Edge capacity"
      pageDescription="Ruin/capacity simulator verdict and the USD deployable ceiling (gate #23)"
      userSafeMessage="This is an operator capacity panel. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="page-admin-edge-capacity">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Gauge className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Edge capacity</h1>
            <p className="text-sm text-muted-foreground">
              Gate #23 admits nothing on an edge until a capacity verdict AND a pressed USD ceiling exist. This page
              writes only the capacity columns — it cannot promote an edge or set liveAllowed.
            </p>
          </div>
        </div>

        {/* ── 1. What gate #23 does right now ───────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What gate #23 does right now</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {propErr && <p className="text-danger" data-testid="capacity-readout-error">{propErr}</p>}
            {propLoading && items == null && !propErr && <p className="text-muted-foreground">Loading…</p>}
            {summary && (
              <p className="font-medium" data-testid="capacity-fleet-headline">{summary.headline}</p>
            )}
            {items != null && items.length === 0 && !propErr && (
              <p className="text-muted-foreground" data-testid="capacity-readout-empty">
                The edge library is readable and contains no edges. Gate #23 has nothing to admit or refuse.
              </p>
            )}
            {items?.map((it) => (
              <div key={it.edgeId} className="rounded-md border border-border p-3 space-y-2" data-testid={`capacity-readout-${it.edgeId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  {it.readout.wouldAdmitAnEntry
                    ? <ShieldCheck className="h-4 w-4 text-success" />
                    : <ShieldAlert className="h-4 w-4 text-danger" />}
                  <span className="font-medium">#{it.edgeId} {it.name}</span>
                  <span className="text-xs text-muted-foreground">{it.versionTag}</span>
                  <Badge variant={it.readout.wouldAdmitAnEntry ? "default" : "destructive"} data-testid={`capacity-verdict-${it.edgeId}`}>
                    {it.readout.wouldAdmitAnEntry ? "WOULD ADMIT AN ENTRY" : "REFUSES EVERY ENTRY"}
                  </Badge>
                  {it.readout.blocker && (
                    <Badge variant="outline" data-testid={`capacity-blocker-${it.edgeId}`}>{it.readout.blocker}</Badge>
                  )}
                  {it.readout.awaitingOwnerPress && (
                    <Badge variant="outline" data-testid={`capacity-awaiting-press-${it.edgeId}`}>AWAITING ADMIN PRESS</Badge>
                  )}
                </div>
                {it.readout.remedy && (
                  <p className="text-muted-foreground" data-testid={`capacity-remedy-${it.edgeId}`}>{it.readout.remedy}</p>
                )}
                {it.readout.gateDetail && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Gate #23 says:</span> {it.readout.gateDetail}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  ceiling {usd(it.readout.effectiveCeilingUsd)} · deployed {usd(it.readout.deployedUsd)} · headroom {usd(it.readout.headroomUsd)}
                  {it.recorded.adminAuthored
                    ? ` · recorded by admin #${it.recorded.capacityRecordedByAdminId} (admin-authored) at ${it.recorded.capacityEstimatedAt ?? "unknown time"}`
                    : " · no estimate has ever been recorded"}
                </p>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => void loadProposals()} data-testid="button-readout-reload">
              Recheck gate #23
            </Button>
          </CardContent>
        </Card>

        {/* ── 2. Proposals ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader><CardTitle className="text-base">Proposals from recorded evidence</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              What the ruin/capacity simulator <strong>would</strong> say, derived from the trades and dispatches this
              system has actually recorded. A proposal has not been recorded and cannot record itself — pressing
              record below is the only thing that writes.
            </p>
            {items?.map((it) => (
              <div key={it.edgeId} className="rounded-md border border-border p-3 space-y-2" data-testid={`capacity-proposal-${it.edgeId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">#{it.edgeId} {it.name}</span>
                  <Badge variant={it.proposal.verdict === "PROPOSED" ? "default" : "outline"} data-testid={`proposal-verdict-${it.edgeId}`}>
                    {it.proposal.verdict}
                  </Badge>
                  <span className="text-xs text-muted-foreground">confidence {it.proposal.confidence}</span>
                </div>

                {it.proposal.verdict === "PROPOSED" ? (
                  <>
                    <p data-testid={`proposal-number-${it.edgeId}`}>
                      Proposed capacity status <strong>{it.proposal.proposedCapacityStatus}</strong>
                      {it.proposal.proposedCapacityRiskR != null
                        ? <> · capacity_risk_r <strong>{it.proposal.proposedCapacityRiskR.toFixed(3)}</strong></>
                        : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">USD ceiling: not proposed.</span> {it.proposal.maxDeployedUsdReason}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">Inputs the proposal used</summary>
                      <Raw value={it.proposal.simulatorInput} testid={`proposal-inputs-${it.edgeId}`} />
                    </details>
                    <Button size="sm" variant="outline" onClick={() => adopt(it)} data-testid={`button-adopt-${it.edgeId}`}>
                      Copy these inputs into the form below
                    </Button>
                  </>
                ) : (
                  <>
                    <p data-testid={`proposal-insufficient-${it.edgeId}`}>
                      <strong>No number is proposed.</strong> The evidence cannot support one. This is a refusal to
                      guess, not a calculation still running.
                    </p>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid={`proposal-gaps-${it.edgeId}`}>
                      {it.proposal.gaps.map((g) => (
                        <li key={g.code}>
                          <span className="font-medium">{g.code}</span> — {g.missing}
                          <br />
                          <span className="italic">Settled by: {g.wouldBeSettledBy}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {it.proposal.optimisticAssumptions.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-warning" data-testid={`proposal-optimism-${it.edgeId}`}>
                    {it.proposal.optimisticAssumptions.map((a) => <li key={a}>{a}</li>)}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Evidence read (sample sizes and drops)</summary>
                  <Raw value={{ sampleSizes: it.proposal.sampleSizes, evidence: it.evidence }} testid={`proposal-evidence-${it.edgeId}`} />
                </details>
              </div>
            ))}
            {items != null && items.length === 0 && !propErr && (
              <p className="text-muted-foreground">No edges to propose for.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Edge library</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {err && <p className="text-danger" data-testid="edge-library-error">{err}</p>}
            {edges == null && !err && <p className="text-muted-foreground">Loading…</p>}
            {edges != null && <Raw value={edges.edges} testid="edge-library" />}
            <Button size="sm" variant="outline" onClick={() => void load()} data-testid="button-edges-reload">Reload</Button>
          </CardContent>
        </Card>

        {/* ── 3. The press ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader><CardTitle className="text-base">Record a capacity estimate</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              What you record here is <strong>yours</strong>. It is stored as admin-authored against your account id,
              whether you typed the numbers or copied them from a proposal. The simulator runs on exactly what is in
              these fields; nothing is filled in for you.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-muted-foreground">Edge id</span>
                <Input value={edgeId} onChange={(e) => edited(setEdgeId)(e.target.value)} inputMode="numeric" data-testid="input-capacity-edge-id" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Win rate (0–1)</span>
                <Input value={winRate} onChange={(e) => edited(setWinRate)(e.target.value)} inputMode="decimal" data-testid="input-capacity-winrate" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Average win (R)</span>
                <Input value={avgWinR} onChange={(e) => edited(setAvgWinR)(e.target.value)} inputMode="decimal" data-testid="input-capacity-avgwin" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Average loss (R, negative)</span>
                <Input value={avgLossR} onChange={(e) => edited(setAvgLossR)(e.target.value)} inputMode="decimal" data-testid="input-capacity-avgloss" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">USD deployable ceiling (never proposed — yours)</span>
                <Input value={maxDeployedUsd} onChange={(e) => setMaxDeployedUsd(e.target.value)} inputMode="decimal" data-testid="input-capacity-ceiling" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Tighten-only override USD (optional)</span>
                <Input value={overrideUsd} onChange={(e) => setOverrideUsd(e.target.value)} inputMode="decimal" data-testid="input-capacity-override" />
              </label>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="capacity-inputs-origin">
              {adoptedFrom != null
                ? `Inputs copied from the proposal for edge #${adoptedFrom}. They are still yours to press, change, or abandon — nothing has been recorded.`
                : "Inputs are your own declared assumptions. Nothing was copied from a proposal."}
            </p>
            <Button size="sm" disabled={busy || !ready} onClick={() => void press()} data-testid="button-capacity-press">
              Run simulator and record
            </Button>
            <p className="text-xs text-muted-foreground">
              Without a pressed USD ceiling, an ESTIMATED verdict still admits nothing — an estimate alone is not
              permission.
            </p>
            <Raw value={result ?? undefined} testid="capacity-result" />
          </CardContent>
        </Card>
      </div>
    </AdminDiagnosticsGate>
  );
}
