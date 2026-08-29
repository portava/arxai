// Admin → Org structure (capability #50).
//
// Legal-entity hierarchy, beneficial-ownership graph and the consolidated
// exposure READ. The backend shipped with six handlers and no UI, so the
// entity graph that consolidated exposure is computed over could only be
// populated by curl.
//
// HONESTY: structure only — nothing on this page executes, sizes, or gates a
// trade. The server's own conflict answers (OWNERSHIP_CYCLE, HIERARCHY_INVALID,
// LAYER_ALREADY_LINKED, SELF_OWNERSHIP_REFUSED) are surfaced verbatim rather
// than smoothed into an empty tree.

import { useCallback, useEffect, useState } from "react";
import { Network } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-snug" data-testid={testid}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Select({ label, value, onChange, options, testid }: {
  label: string; value: string; onChange: (v: string) => void; options: string[]; testid: string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
      >
        <option value="">— choose —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export default function AdminOrgStructurePage() {
  const [tree, setTree] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [exposure, setExposure] = useState<Json | null>(null);
  const [result, setResult] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);

  // create org
  const [name, setName] = useState("");
  const [entityKind, setEntityKind] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [parentOrgId, setParentOrgId] = useState("");
  // link layer
  const [linkOrgId, setLinkOrgId] = useState("");
  const [layerKind, setLayerKind] = useState("");
  const [layerRefId, setLayerRefId] = useState("");
  // ownership edge
  const [ownerKind, setOwnerKind] = useState("");
  const [ownerRefId, setOwnerRefId] = useState("");
  const [ownedOrgId, setOwnedOrgId] = useState("");
  const [ownershipPct, setOwnershipPct] = useState("");
  const [controlKind, setControlKind] = useState("");

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/org-structure");
    if (!r.ok) {
      setTree(null);
      setErr(`Hierarchy read failed (${r.status}): ${String(r.body.error ?? "")}`);
      return;
    }
    setTree(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const vocab = (tree?.vocab as Json | undefined) ?? {};
  const entityKinds = (vocab.entityKinds as string[] | undefined) ?? [];
  const layerKinds = (vocab.layerKinds as string[] | undefined) ?? [];
  const ownerKinds = (vocab.ownerKinds as string[] | undefined) ?? [];
  const controlKinds = (vocab.controlKinds as string[] | undefined) ?? [];

  async function post(path: string, payload: Json) {
    setBusy(true);
    setResult(null);
    const r = await call(path, { method: "POST", body: JSON.stringify(payload) });
    setResult({ httpStatus: r.status, ...r.body });
    if (r.ok) await load();
    setBusy(false);
  }

  async function loadExposure() {
    const r = await call("/api/admin/org-structure/consolidated-exposure");
    setExposure({ httpStatus: r.status, ...r.body });
  }

  return (
    <AdminDiagnosticsGate
      pageTitle="Org structure"
      pageDescription="Legal-entity hierarchy and beneficial ownership"
      userSafeMessage="This is an operator structure panel. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="page-admin-org-structure">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Network className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Org structure</h1>
            <p className="text-sm text-muted-foreground">
              Structure only — nothing here executes, sizes or gates a trade. It records who owns and controls what.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Hierarchy</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {err && <p className="text-danger" data-testid="org-read-error">{err}</p>}
            {tree == null ? <p className="text-muted-foreground">Not loaded.</p> : (
              <Raw value={{ rootOrgIds: tree.rootOrgIds, nodes: tree.nodes, danglingLinks: tree.danglingLinks }} testid="org-hierarchy" />
            )}
            <Button size="sm" variant="outline" onClick={() => void load()} data-testid="button-org-reload">Reload</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Add an organization</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-muted-foreground">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-org-name" />
              </label>
              <Select label="Entity kind" value={entityKind} onChange={setEntityKind} options={entityKinds} testid="select-org-entity-kind" />
              <label className="space-y-1">
                <span className="text-muted-foreground">Jurisdiction (optional)</span>
                <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} data-testid="input-org-jurisdiction" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Parent org id (optional)</span>
                <Input value={parentOrgId} onChange={(e) => setParentOrgId(e.target.value)} inputMode="numeric" data-testid="input-org-parent" />
              </label>
            </div>
            <Button
              size="sm"
              disabled={busy || !name.trim() || !entityKind}
              onClick={() => void post("/api/admin/org-structure/organizations", {
                name: name.trim(),
                entityKind,
                ...(jurisdiction.trim() ? { jurisdiction: jurisdiction.trim() } : {}),
                ...(parentOrgId.trim() ? { parentOrgId: Number(parentOrgId) } : {}),
              })}
              data-testid="button-org-create"
            >
              Create organization
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Link an existing object to an org</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-muted-foreground">Org id</span>
                <Input value={linkOrgId} onChange={(e) => setLinkOrgId(e.target.value)} inputMode="numeric" data-testid="input-link-org" />
              </label>
              <Select label="Layer kind" value={layerKind} onChange={setLayerKind} options={layerKinds} testid="select-link-layer-kind" />
              <label className="space-y-1">
                <span className="text-muted-foreground">Layer object id</span>
                <Input value={layerRefId} onChange={(e) => setLayerRefId(e.target.value)} inputMode="numeric" data-testid="input-link-ref" />
              </label>
            </div>
            <Button
              size="sm"
              disabled={busy || !linkOrgId || !layerKind || !layerRefId}
              onClick={() => void post("/api/admin/org-structure/links", {
                orgId: Number(linkOrgId), layerKind, layerRefId: Number(layerRefId),
              })}
              data-testid="button-link-create"
            >
              Link
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Record a beneficial-ownership edge</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Owner kind" value={ownerKind} onChange={setOwnerKind} options={ownerKinds} testid="select-edge-owner-kind" />
              <label className="space-y-1">
                <span className="text-muted-foreground">Owner id</span>
                <Input value={ownerRefId} onChange={(e) => setOwnerRefId(e.target.value)} inputMode="numeric" data-testid="input-edge-owner" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Owned org id</span>
                <Input value={ownedOrgId} onChange={(e) => setOwnedOrgId(e.target.value)} inputMode="numeric" data-testid="input-edge-owned" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Ownership % (optional)</span>
                <Input value={ownershipPct} onChange={(e) => setOwnershipPct(e.target.value)} inputMode="decimal" data-testid="input-edge-pct" />
              </label>
              <Select label="Control kind" value={controlKind} onChange={setControlKind} options={controlKinds} testid="select-edge-control-kind" />
            </div>
            <Button
              size="sm"
              disabled={busy || !ownerKind || !ownerRefId || !ownedOrgId || !controlKind}
              onClick={() => void post("/api/admin/org-structure/ownership-edges", {
                ownerKind, ownerRefId: Number(ownerRefId), ownedOrgId: Number(ownedOrgId), controlKind,
                ...(ownershipPct.trim() ? { ownershipPct: Number(ownershipPct) } : {}),
              })}
              data-testid="button-edge-create"
            >
              Record edge
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Consolidated exposure (read only)</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Button size="sm" variant="outline" onClick={() => void loadExposure()} data-testid="button-exposure-load">Load</Button>
            <Raw value={exposure ?? undefined} testid="org-exposure" />
          </CardContent>
        </Card>

        <Raw value={result ?? undefined} testid="org-result" />
      </div>
    </AdminDiagnosticsGate>
  );
}
