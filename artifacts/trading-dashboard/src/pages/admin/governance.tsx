// Admin → Governance.
//
// Three shipped ADMIN/OWNER backends that had no button anywhere:
//   * compliance eligibility  (capability #52) — the ONLY write surface for
//     broker_eligibility, the table the fail-closed dispatch consult reads.
//     With no UI, a user held by gate #3 could only ever be released by hand
//     editing the database.
//   * lifecycle roles         (capability #51) — separation-of-duties grants.
//   * execution-policy promotion (#27) — the documented OWNER-PRESS that moves
//     the execution-policy chooser out of SHADOW. The press had no button.
//   * as-of reconstruction    (#35) — read-only historical system view.
//
// This is a deliberately plain operator panel, not a designed product surface.
// It says exactly what each control does and shows the server's refusal text
// unchanged. Nothing here is simulated: every value is a server response and
// every failure renders as a failure.

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
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

/** Raw server response, shown verbatim. An operator panel must not paraphrase
 *  a refusal — the exact error code is the actionable part. */
function Raw({ value, testid }: { value: unknown; testid?: string }) {
  if (value === undefined) return null;
  return (
    <pre
      className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-snug"
      data-testid={testid}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ── Compliance eligibility ──────────────────────────────────────────────────

function CompliancePanel() {
  const [list, setList] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [userId, setUserId] = useState("");
  const [venueCode, setVenueCode] = useState("");
  const [status, setStatus] = useState("");
  const [relationship, setRelationship] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/compliance/eligibility");
    if (!r.ok) { setList(null); setErr(`Read failed (${r.status}): ${String(r.body.error ?? "")}`); return; }
    setList(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const statuses = (list?.statuses as string[] | undefined) ?? [];

  async function save() {
    setBusy(true);
    setResult(null);
    const payload: Json = {
      userId: Number(userId),
      venueCode: venueCode.trim(),
      eligibilityStatus: status,
    };
    if (relationship) payload.relationshipToMaster = relationship;
    const r = await call("/api/admin/compliance/eligibility", { method: "PUT", body: JSON.stringify(payload) });
    setResult({ httpStatus: r.status, ...r.body });
    if (r.ok) await load();
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Compliance eligibility (capability #52)</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The only write surface for <code>broker_eligibility</code>. The live dispatch pipeline consults this
          fail-closed; recording a review here does not grant live authority by itself. An OUTSIDE_CLIENT
          relationship may only ever be recorded as COMPLIANCE_HOLD — the server refuses anything else.
        </p>
        {err && <p className="text-danger" data-testid="compliance-read-error">{err}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">User id</span>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric" data-testid="input-compliance-user" />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Venue code</span>
            <Input value={venueCode} onChange={(e) => setVenueCode(e.target.value)} data-testid="input-compliance-venue" />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Eligibility status</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              data-testid="select-compliance-status"
            >
              <option value="">— choose —</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Relationship to master (optional)</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              data-testid="select-compliance-relationship"
            >
              <option value="">— leave unchanged —</option>
              {["SELF", "SAME_ENTITY_OPERATOR", "EMPLOYEE_OF_OWNER", "OUTSIDE_CLIENT"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <Button
          size="sm"
          disabled={busy || !userId || !venueCode || !status}
          onClick={() => void save()}
          data-testid="button-compliance-save"
        >
          Record review
        </Button>
        <Raw value={result ?? undefined} testid="compliance-result" />
        <div>
          <div className="mb-1 text-muted-foreground">Recorded reviews</div>
          {list == null ? <p className="text-muted-foreground">Not loaded.</p> : <Raw value={list.reviews} testid="compliance-reviews" />}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Lifecycle roles ─────────────────────────────────────────────────────────

function LifecycleRolesPanel() {
  const [data, setData] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/lifecycle-roles");
    if (!r.ok) { setData(null); setErr(`Read failed (${r.status}): ${String(r.body.error ?? "")}`); return; }
    setData(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const roles = (data?.roles as string[] | undefined) ?? [];

  async function press(action: "grant" | "revoke") {
    setBusy(true);
    setResult(null);
    const r = await call(`/api/admin/lifecycle-roles/${action}`, {
      method: "POST",
      body: JSON.stringify({ userId: Number(userId), role }),
    });
    setResult({ httpStatus: r.status, ...r.body });
    if (r.ok) await load();
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Lifecycle roles — separation of duties (capability #51)</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Conflicting role combinations are refused by the server's evaluator, not by this form. A refusal below
          names the roles it conflicts with.
        </p>
        {err && <p className="text-danger" data-testid="lifecycle-read-error">{err}</p>}
        {data != null && data.sodConfigured === false && (
          <p className="text-warning" data-testid="lifecycle-not-configured">
            No lifecycle role has ever been granted — separation of duties is not yet configured on this deployment.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">User id</span>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric" data-testid="input-lifecycle-user" />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Role</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              data-testid="select-lifecycle-role"
            >
              <option value="">— choose —</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !userId || !role} onClick={() => void press("grant")} data-testid="button-lifecycle-grant">Grant</Button>
          <Button size="sm" variant="outline" disabled={busy || !userId || !role} onClick={() => void press("revoke")} data-testid="button-lifecycle-revoke">Revoke</Button>
        </div>
        <Raw value={result ?? undefined} testid="lifecycle-result" />
        <div>
          <div className="mb-1 text-muted-foreground">Current grants and the conflicting pairs the evaluator enforces</div>
          {data == null ? <p className="text-muted-foreground">Not loaded.</p> : (
            <Raw value={{ grants: data.grants, conflictingPairs: data.conflictingPairs }} testid="lifecycle-state" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Execution-policy promotion (#27) ────────────────────────────────────────

function ExecutionPolicyPanel() {
  const [data, setData] = useState<Json | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await call("/api/admin/execution-policy");
    if (!r.ok) {
      setData(null);
      setErr(`Read failed (${r.status}): ${String(r.body.error ?? "")}${r.body.detail ? ` — ${String(r.body.detail)}` : ""}`);
      return;
    }
    setData(r.body);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function press(action: "enable" | "revert") {
    setBusy(true);
    setResult(null);
    const body: Json = action === "enable" ? { confirm: true, reason: reason.trim() } : { reason: reason.trim() };
    const r = await call(`/api/admin/execution-policy/${action}`, { method: "POST", body: JSON.stringify(body) });
    setResult({ httpStatus: r.status, ...r.body });
    await load();
    setBusy(false);
  }

  const enableArmed = confirmText === "ENABLE" && reason.trim().length > 0;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Execution-policy promotion (#27) — OWNER PRESS</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The ladder is SHADOW → PRESS_UNLOCKED (evidence threshold met; grants nothing) → ENABLED (this press).
          The server re-verifies the evidence at press time and refuses if it no longer holds. Reverting to SHADOW
          is always accepted — authority only shrinks on the way back.
        </p>
        {err && <p className="text-danger" data-testid="execution-policy-read-error">{err}</p>}
        {data != null && (
          <Raw
            value={{ mode: data.mode, promotion: data.promotion, evidence: data.evidence, evidenceError: data.evidenceError, note: data.note }}
            testid="execution-policy-state"
          />
        )}
        <label className="block space-y-1">
          <span className="text-muted-foreground">Reason (required — written to the admin audit log)</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-execution-policy-reason" />
        </label>
        <label className="block space-y-1">
          <span className="text-muted-foreground">Type ENABLE to arm the promotion press</span>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} data-testid="input-execution-policy-confirm" />
        </label>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !enableArmed} onClick={() => void press("enable")} data-testid="button-execution-policy-enable">
            Press ENABLE
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void press("revert")} data-testid="button-execution-policy-revert">
            Revert to SHADOW
          </Button>
        </div>
        <Raw value={result ?? undefined} testid="execution-policy-result" />
      </CardContent>
    </Card>
  );
}

// ── As-of reconstruction (#35) ──────────────────────────────────────────────

function AsOfPanel() {
  const [ts, setTs] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const r = await call(`/api/admin/as-of?timestamp=${encodeURIComponent(ts)}`);
    setResult({ httpStatus: r.status, ...r.body });
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">As-of reconstruction (#35) — read only</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Reconstructs what the system's state looked like at a past instant. SELECTs only — this is a debugger,
          never a control. Future timestamps are refused rather than extrapolated.
        </p>
        <label className="block space-y-1">
          <span className="text-muted-foreground">Timestamp (ISO-8601 or epoch ms)</span>
          <Input value={ts} onChange={(e) => setTs(e.target.value)} placeholder="2026-08-01T12:00:00Z" data-testid="input-as-of" />
        </label>
        <Button size="sm" disabled={busy || !ts.trim()} onClick={() => void run()} data-testid="button-as-of-run">Reconstruct</Button>
        <Raw value={result ?? undefined} testid="as-of-result" />
      </CardContent>
    </Card>
  );
}

export default function AdminGovernancePage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Governance"
      pageDescription="Compliance eligibility, lifecycle roles and the execution-policy promotion press"
      userSafeMessage="This is an operator governance panel. Your account does not require any action here."
    >
      <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="page-admin-governance">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Landmark className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Governance</h1>
            <p className="text-sm text-muted-foreground">
              Operator controls that gate real user access. Every panel talks directly to its audited backend and
              shows the server's answer, including refusals, unchanged.
            </p>
          </div>
        </div>
        <CompliancePanel />
        <LifecycleRolesPanel />
        <ExecutionPolicyPanel />
        <AsOfPanel />
      </div>
    </AdminDiagnosticsGate>
  );
}
