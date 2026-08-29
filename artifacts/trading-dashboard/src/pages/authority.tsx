// Capability #37 — the automation-authority page (/authority).
//
// WHY THIS PAGE EXISTS: missionPromotionService refuses an automation increase
// with the words "raising automation to level N requires an active
// owner-pressed authority grant". That grant could only ever be created by
// POST /api/me/authority/grants — a call no screen made. The documented
// blocker was a dead end. This page is the press.
//
// HONESTY (inviolable):
//   * Every number on this page comes from GET /api/me/authority. Nothing is
//     defaulted, inferred, or filled in when the read fails — an unreadable
//     ledger renders an explicit error, never an empty "no grants" list that
//     would read as "you have none".
//   * A grant PERMITS a later explicit raise through the existing gated
//     seams. It does not raise anything by itself and this page never claims
//     it does.
//   * Revoke is an immediate reduction and is always offered.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { LoadingState, ErrorState } from "@/components/ss/States";

type Effective = {
  kind: string;
  baseline: number;
  ladderMax: number;
  accountCeiling: number;
  source: string;
  expiresAt: string | null;
  reasons: string[];
};
type Grant = {
  publicId: string;
  kind: string;
  scopeType: string;
  scopeRef: string | null;
  maxLevel: number;
  reason: string | null;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
};
type AuthorityPage = {
  effective: Effective[];
  grants: Grant[];
  maxGrantDurationMs: number;
  scopes: string[];
  note: string;
};

/** Human label for an authority kind. Unknown kinds render their raw key
 *  rather than a friendly guess — a renamed ladder must look unfamiliar, not
 *  silently wear the wrong name. */
const KIND_LABELS: Record<string, string> = {
  MISSION_AUTOMATION_LEVEL: "Mission automation level",
  AGENT_AUTONOMY_LEVEL: "Self-trade agent autonomy level",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function AuthorityPage() {
  const [page, setPage] = useState<AuthorityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [actionErr, setActionErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Grant form state.
  const [kind, setKind] = useState("MISSION_AUTOMATION_LEVEL");
  const [scopeType, setScopeType] = useState("ACCOUNT");
  const [scopeRef, setScopeRef] = useState("");
  const [maxLevel, setMaxLevel] = useState("3");
  const [days, setDays] = useState("7");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/me/authority", { credentials: "include" });
      if (!r.ok) {
        throw new Error(
          r.status === 401
            ? "Sign in required."
            : r.status === 503
              ? "The authority ledger could not be read. Your grants are NOT shown — this is not a statement that you have none."
              : `Unavailable (${r.status}).`,
        );
      }
      setPage((await r.json()) as AuthorityPage);
    } catch (e) {
      setPage(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createGrant() {
    setActionErr("");
    const level = Number(maxLevel);
    const dayCount = Number(days);
    if (!Number.isInteger(level)) { setActionErr("Level must be a whole number."); return; }
    if (!Number.isFinite(dayCount) || dayCount <= 0) { setActionErr("Duration must be a positive number of days."); return; }
    setBusy(true);
    try {
      const expiresAt = new Date(Date.now() + dayCount * 24 * 60 * 60 * 1000).toISOString();
      const r = await fetch("/api/me/authority/grants", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          scopeType,
          ...(scopeRef.trim() ? { scopeRef: scopeRef.trim() } : {}),
          maxLevel: level,
          expiresAt,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setActionErr(`Grant refused: ${body.error ?? `HTTP ${r.status}`}`);
        return;
      }
      setReason("");
      await load();
    } catch (e) {
      setActionErr(`Grant failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(publicId: string) {
    setActionErr("");
    setBusy(true);
    try {
      const r = await fetch(`/api/me/authority/grants/${publicId}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setActionErr(`Revoke failed: ${body.error ?? `HTTP ${r.status}`}`);
        return;
      }
      await load();
    } catch (e) {
      setActionErr(`Revoke failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title="Automation authority"
      description="Scoped, expiring permission for ARX to raise its own automation on your account. A grant only PERMITS a later explicit raise through the normal safety gates — it never raises anything by itself."
      icon={<KeyRound className="h-6 w-6" />}
    >
      {loading ? (
        <LoadingState label="Loading your authority ledger…" />
      ) : err ? (
        <ErrorState description={err} />
      ) : page ? (
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground" data-testid="authority-note">{page.note}</p>
            </CardContent>
          </Card>

          <Card data-testid="authority-effective">
            <CardContent className="space-y-3 pt-6">
              <SectionHeader
                title="Effective ceilings"
                description="The highest level an increase may reach right now, and where that ceiling comes from."
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-3">Ladder</th>
                      <th className="py-1 pr-3">Baseline</th>
                      <th className="py-1 pr-3">Ceiling now</th>
                      <th className="py-1 pr-3">Ladder max</th>
                      <th className="py-1 pr-3">Source</th>
                      <th className="py-1 pr-3">Ceiling expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.effective.map((e) => (
                      <tr key={e.kind} data-testid={`effective-${e.kind}`}>
                        <td className="py-1 pr-3">{KIND_LABELS[e.kind] ?? e.kind}</td>
                        <td className="py-1 pr-3">{e.baseline}</td>
                        <td className="py-1 pr-3 font-semibold">{e.accountCeiling}</td>
                        <td className="py-1 pr-3">{e.ladderMax}</td>
                        <td className="py-1 pr-3">{e.source}</td>
                        <td className="py-1 pr-3">{fmt(e.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.effective.some((e) => e.reasons.length > 0) && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {page.effective.flatMap((e) =>
                    e.reasons.map((r) => <li key={`${e.kind}:${r}`}>{(KIND_LABELS[e.kind] ?? e.kind)}: {r}</li>),
                  )}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card data-testid="authority-grant-form">
            <CardContent className="space-y-3 pt-6">
              <SectionHeader
                title="Press a new grant"
                description="You are the owner of your own account, so this press is your press. Expiry is mandatory."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Ladder</span>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    data-testid="select-authority-kind"
                  >
                    {page.effective.map((e) => (
                      <option key={e.kind} value={e.kind}>{KIND_LABELS[e.kind] ?? e.kind}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Scope</span>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={scopeType}
                    onChange={(e) => setScopeType(e.target.value)}
                    data-testid="select-authority-scope"
                  >
                    {page.scopes.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Scope reference (blank for the whole account)</span>
                  <Input value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} data-testid="input-scope-ref" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Maximum level this grant permits</span>
                  <Input value={maxLevel} onChange={(e) => setMaxLevel(e.target.value)} inputMode="numeric" data-testid="input-max-level" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">
                    Expires in (days, at most {Math.floor(page.maxGrantDurationMs / (24 * 60 * 60 * 1000))})
                  </span>
                  <Input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" data-testid="input-grant-days" />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Reason (kept in the audit trail)</span>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-grant-reason" />
                </label>
              </div>
              <Button onClick={() => void createGrant()} disabled={busy} data-testid="button-create-grant">
                <ShieldCheck className="mr-2 h-4 w-4" /> Press grant
              </Button>
              {actionErr && (
                <p className="text-sm text-danger" data-testid="authority-action-error">{actionErr}</p>
              )}
              <p className="text-xs text-muted-foreground">
                The server decides. A refusal here is the safety contract refusing, and the exact reason is shown above unchanged.
              </p>
            </CardContent>
          </Card>

          <Card data-testid="authority-grants">
            <CardContent className="space-y-3 pt-6">
              <SectionHeader title="Grant ledger" description="Every grant ever pressed on this account, newest first." />
              {page.grants.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="authority-no-grants">
                  No authority grants have been pressed on this account. Automation stays at its conservative baseline.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1 pr-3">Ladder</th>
                        <th className="py-1 pr-3">Scope</th>
                        <th className="py-1 pr-3">Max level</th>
                        <th className="py-1 pr-3">Granted</th>
                        <th className="py-1 pr-3">Expires</th>
                        <th className="py-1 pr-3">State</th>
                        <th className="py-1 pr-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.grants.map((g) => (
                        <tr key={g.publicId} data-testid={`grant-${g.publicId}`}>
                          <td className="py-1 pr-3">{KIND_LABELS[g.kind] ?? g.kind}</td>
                          <td className="py-1 pr-3">{g.scopeType}{g.scopeRef ? `:${g.scopeRef}` : ""}</td>
                          <td className="py-1 pr-3">{g.maxLevel}</td>
                          <td className="py-1 pr-3">{fmt(g.grantedAt)}</td>
                          <td className="py-1 pr-3">{fmt(g.expiresAt)}</td>
                          <td className="py-1 pr-3">
                            {g.revokedAt ? `revoked ${fmt(g.revokedAt)}` : g.active ? "active" : "expired"}
                          </td>
                          <td className="py-1 pr-3">
                            {g.active && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void revoke(g.publicId)}
                                data-testid={`button-revoke-${g.publicId}`}
                              >
                                Revoke
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
