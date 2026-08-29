import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Key, Copy, CheckCircle, AlertTriangle } from "lucide-react";
import { getExpiryIndicator, isExpiringSoon, compareByExpiry } from "./betaControlExpiry";

interface PublicKey {
  id: number;
  email: string | null;
  keyMasked: string | null;
  inviteCodeMasked: string | null;
  keyPrefix: string | null;
  roleGrant: string | null;
  accountMode: string;
  status: string;
  invitedAt: string;
  updatedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  acceptedAt: string | null;
  acceptedUserId: number | null;
  revokedAt: string | null;
  notes: string | null;
}

interface GeneratedKey {
  id: number;
  rawKey: string;
  keyPrefix: string;
  maskedKey: string | null;
}

interface KeysResponse {
  keys: PublicKey[];
  byStatus: Record<string, number>;
  total: number;
  pepperConfigured: boolean;
}

// Mirrors the email digest exactly (same query, window, masking, days-left math).
interface ExpiringSoonItem {
  id: number;
  maskedKey: string | null;
  daysLeft: number;
  assignedEmail: string | null;
  roleGrant: string | null;
  expiresAt: string;
}
interface ExpiringSoonResponse {
  windowDays: number;
  total: number;
  items: ExpiringSoonItem[];
}
interface SendDigestResult {
  delivered: number;
  recipients: number;
  expiringCount: number;
  skipped?: string | null;
}

/** Whole-days label matching the email digest's daysLeftLabel for parity. */
function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "expires today";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

interface Invite {
  id: number; email: string | null; accountMode: string; status: string;
  inviteCodeMasked: string | null; keyMasked: string | null; keyPrefix: string | null;
  roleGrant: string | null;
  invitedAt: string; acceptedAt: string | null;
  revokedAt: string | null; pausedAt: string | null; notes: string | null;
}
interface Cohort {
  cohort: string; maxCohortSize: number; activeCount: number;
  seatsRemaining: number; waitlistActive: boolean;
  byStatus: Record<string, number>; invites: Invite[];
  inviteGateEnabled: boolean; registrationKeyPepperConfigured: boolean;
}
interface JoinRequest {
  id: number; email: string; name: string | null; note: string | null;
  status: string; source: string; createdAt: string; updatedAt: string;
  decidedByUserId: number | null; decidedAt: string | null;
  declineReason: string | null; inviteId: number | null;
}
interface JoinRequestsResponse {
  byStatus: Record<string, number>; pendingCount: number; requests: JoinRequest[];
}

const ACCOUNT_MODES = ["DEMO_TESTER", "PERSONAL_MT5", "SHARED_MASTER_REVIEW"] as const;
const ROLE_GRANTS = ["USER", "INVESTOR", "ADMIN"] as const;
const STATUS_FILTERS = ["", "PENDING", "ACCEPTED", "REVOKED", "PAUSED", "EXPIRED"] as const;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string; message?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

function StatusBadge({ status, expired }: { status: string; expired?: boolean }) {
  const variant =
    status === "PENDING" ? "secondary" :
    status === "ACCEPTED" ? "default" :
    "destructive";
  return (
    <span className="flex items-center gap-1">
      <Badge variant={variant}>{status}</Badge>
      {expired && status === "PENDING" && <Badge variant="outline" className="text-warning border-warning">EXPIRED</Badge>}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={doCopy}
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted hover:bg-muted/70 transition-colors"
      title="Copy"
    >
      {copied ? <CheckCircle className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ExpiryCell({ expiresAt, status }: { expiresAt: string | null; status: string }) {
  const ind = getExpiryIndicator(expiresAt, status);
  if (ind.kind === "no-expiry") {
    return <span className="text-muted-foreground italic">No expiry</span>;
  }
  if (ind.kind === "not-applicable") {
    return <span>{ind.dateLabel}</span>;
  }
  if (ind.kind === "expired") {
    return (
      <span className="flex flex-col">
        <span>{ind.dateLabel}</span>
        <Badge variant="outline" className="w-fit text-danger border-danger">{ind.relativeLabel}</Badge>
      </span>
    );
  }
  const toneClass =
    ind.tone === "danger" ? "text-danger border-danger" :
    ind.tone === "warning" ? "text-warning border-warning" :
    "text-muted-foreground border-border";
  return (
    <span className="flex flex-col">
      <span>{ind.dateLabel}</span>
      <Badge variant="outline" className={`w-fit ${toneClass}`} data-testid={`rk-expires-relative-${ind.relativeLabel.replace(/\s+/g, "-")}`}>
        {ind.relativeLabel}
      </Badge>
    </span>
  );
}

// ── Registration Keys Section ─────────────────────────────────────────────

function RegistrationKeysSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [soonOnly, setSoonOnly] = useState(false);
  const [count, setCount] = useState("1");
  const [email, setEmail] = useState("");
  const [roleGrant, setRoleGrant] = useState<string>("USER");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [notes, setNotes] = useState("");
  const [generatedKeys, setGeneratedKeys] = useState<GeneratedKey[] | null>(null);
  const [editingExpiryId, setEditingExpiryId] = useState<number | null>(null);
  const [expiryDays, setExpiryDays] = useState("");
  const [digestExtendId, setDigestExtendId] = useState<number | null>(null);
  const [digestExtendDays, setDigestExtendDays] = useState("");

  const keysQuery = useQuery<KeysResponse>({
    queryKey: ["admin", "registration-keys", statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      return jsonFetch<KeysResponse>(`/api/admin/registration-keys?${params.toString()}`);
    },
    refetchInterval: 15_000,
  });

  // In-app twin of the email digest — same backend query/window/masking.
  const expiringQuery = useQuery<ExpiringSoonResponse>({
    queryKey: ["admin", "registration-keys", "expiring-soon"],
    queryFn: () => jsonFetch<ExpiringSoonResponse>("/api/admin/registration-keys/expiring-soon"),
    refetchInterval: 15_000,
  });

  const sendDigest = useMutation({
    mutationFn: () => jsonFetch<SendDigestResult>("/api/admin/registration-keys/send-digest", { method: "POST" }),
    onSuccess: (res) => {
      const description =
        res.skipped === "NOTHING_EXPIRING"
          ? "No keys are expiring in the window — nothing to send."
          : res.skipped
            ? `Digest not sent (${res.skipped}).`
            : `Digest sent to ${res.delivered} recipient${res.delivered === 1 ? "" : "s"} (${res.expiringCount} expiring key${res.expiringCount === 1 ? "" : "s"}).`;
      toast({ title: "Send digest", description });
    },
    onError: (e: Error) => toast({ title: "Send digest failed", description: e.message, variant: "destructive" }),
  });

  const generate = useMutation({
    mutationFn: () => jsonFetch<{ keys: GeneratedKey[]; rawKeyNotice: string; count: number }>(
      "/api/admin/registration-keys/generate",
      {
        method: "POST",
        body: JSON.stringify({
          count: Number(count) || 1,
          email: email.trim() || null,
          roleGrant: roleGrant || "USER",
          expiresInDays: expiresInDays ? Number(expiresInDays) : null,
          notes: notes.trim() || null,
        }),
      },
    ),
    onSuccess: (res) => {
      setGeneratedKeys(res.keys);
      setCount("1"); setEmail(""); setNotes("");
      qc.invalidateQueries({ queryKey: ["admin", "registration-keys"] });
    },
    onError: (e: Error) => toast({ title: "Generation failed", description: e.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => jsonFetch(`/api/admin/registration-keys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "registration-keys"] });
      toast({ title: "Key revoked" });
    },
    onError: (e: Error) => toast({ title: "Revoke failed", description: e.message, variant: "destructive" }),
  });

  const setExpiry = useMutation({
    mutationFn: ({ id, expiresInDays }: { id: number; expiresInDays: number | null }) =>
      jsonFetch(`/api/admin/registration-keys/${id}/expiry`, {
        method: "POST",
        body: JSON.stringify({ expiresInDays }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "registration-keys"] });
      setEditingExpiryId(null);
      setExpiryDays("");
      toast({ title: "Expiry updated" });
    },
    onError: (e: Error) => toast({ title: "Expiry update failed", description: e.message, variant: "destructive" }),
  });

  const pepperOk = keysQuery.data?.pepperConfigured ?? true;

  const allKeys = keysQuery.data?.keys ?? [];
  const soonCount = allKeys.filter((k) => isExpiringSoon(k.expiresAt, k.status)).length;
  const displayKeys = soonOnly
    ? allKeys.filter((k) => isExpiringSoon(k.expiresAt, k.status)).sort(compareByExpiry)
    : allKeys;

  return (
    <div className="space-y-4">
      {!pepperOk && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <b>REGISTRATION_KEY_PEPPER is not set.</b> Key generation and validation will fail until this environment variable is configured.
          </span>
        </div>
      )}

      {/* Generate keys form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="w-4 h-4" />
            Generate Registration Keys
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rk-count">Count (1–100)</Label>
              <Input
                id="rk-count" type="number" min={1} max={100}
                value={count} onChange={(e) => setCount(e.target.value)}
                className="mt-1" data-testid="rk-count"
              />
            </div>
            <div>
              <Label htmlFor="rk-role">Role grant</Label>
              <select
                id="rk-role"
                className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={roleGrant}
                onChange={(e) => setRoleGrant(e.target.value)}
                data-testid="rk-role-grant"
              >
                {ROLE_GRANTS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="rk-email">Assign email (optional)</Label>
              <Input
                id="rk-email" type="email"
                placeholder="user@example.com"
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1" data-testid="rk-email"
              />
            </div>
            <div>
              <Label htmlFor="rk-expires">Expires in days (optional)</Label>
              <Input
                id="rk-expires" type="number" min={1} max={3650}
                placeholder="e.g. 30"
                value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)}
                className="mt-1" data-testid="rk-expires"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="rk-notes">Note (optional)</Label>
            <Input
              id="rk-notes"
              placeholder="Internal note"
              value={notes} onChange={(e) => setNotes(e.target.value)}
              className="mt-1" data-testid="rk-notes"
            />
          </div>
          <Button
            data-testid="rk-generate-btn"
            disabled={generate.isPending || !pepperOk}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? "Generating…" : `Generate ${count || 1} key${Number(count) > 1 ? "s" : ""}`}
          </Button>
        </CardContent>
      </Card>

      {/* One-time raw key reveal */}
      {generatedKeys && generatedKeys.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-warning flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Raw keys are only shown once. Save them now.
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground mb-3">
              These raw keys are not stored. Once you navigate away they cannot be recovered.
            </p>
            {generatedKeys.map((k) => (
              <div key={k.id} className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono text-sm" data-testid={`generated-key-${k.id}`}>
                <span className="flex-1 select-all">{k.rawKey}</span>
                <CopyButton text={k.rawKey} />
              </div>
            ))}
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setGeneratedKeys(null)}>
              I've saved these keys — dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Expiring Soon — in-app twin of the email digest */}
      <Card className="border-warning/40" data-testid="rk-expiring-soon-panel">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              Expiring Soon — next {expiringQuery.data?.windowDays ?? 7} days ({expiringQuery.data?.total ?? 0})
            </span>
            <Button
              size="sm" variant="outline"
              data-testid="rk-send-digest-btn"
              disabled={sendDigest.isPending}
              onClick={() => sendDigest.mutate()}
              title="Run the expiring-keys email digest now (sends nothing if no keys are expiring)"
            >
              {sendDigest.isPending ? "Sending…" : "Send digest now"}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="text-xs text-muted-foreground mb-2">
            PENDING keys lapsing within the digest window, soonest first — the same masked list admins receive by email.
          </p>
          {expiringQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : expiringQuery.isError ? (
            <div className="text-sm text-danger py-3 text-center" data-testid="rk-expiring-soon-error">
              Couldn't load expiring keys{expiringQuery.error instanceof Error ? `: ${expiringQuery.error.message}` : "."}{" "}
              <button type="button" className="underline" onClick={() => expiringQuery.refetch()}>
                Retry
              </button>
            </div>
          ) : (expiringQuery.data?.items.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground py-3 text-center" data-testid="rk-expiring-soon-empty">
              No PENDING keys are expiring in the next {expiringQuery.data?.windowDays ?? 7} days.
            </div>
          ) : (
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="p-1">ID</th>
                  <th className="p-1">Key</th>
                  <th className="p-1">Expires in</th>
                  <th className="p-1">Assigned email</th>
                  <th className="p-1">Role</th>
                  <th className="p-1">Expires</th>
                  <th className="p-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {expiringQuery.data!.items.map((it) => {
                  const tone = it.daysLeft <= 1 ? "text-danger border-danger"
                    : it.daysLeft <= 3 ? "text-warning border-warning"
                    : "text-muted-foreground border-border";
                  return (
                    <tr key={it.id} className="border-t align-top" data-testid={`rk-expiring-row-${it.id}`}>
                      <td className="p-1">{it.id}</td>
                      <td className="p-1 font-mono" data-testid={`rk-expiring-masked-${it.id}`}>
                        <span className="flex items-center gap-1">
                          <span>{it.maskedKey ?? "—"}</span>
                          {it.maskedKey && <CopyButton text={it.maskedKey} />}
                        </span>
                      </td>
                      <td className="p-1">
                        <Badge variant="outline" className={`w-fit ${tone}`} data-testid={`rk-expiring-daysleft-${it.id}`}>
                          {daysLeftLabel(it.daysLeft)}
                        </Badge>
                      </td>
                      <td className="p-1">{it.assignedEmail ?? <span className="text-muted-foreground italic">any</span>}</td>
                      <td className="p-1">{it.roleGrant ?? "USER"}</td>
                      <td className="p-1">{new Date(it.expiresAt).toISOString().slice(0, 10)}</td>
                      <td className="p-1">
                        {digestExtendId === it.id ? (
                          <div className="flex items-center gap-1" data-testid={`rk-expiring-extend-editor-${it.id}`}>
                            <Input
                              type="number" min={1} max={3650}
                              placeholder="days"
                              value={digestExtendDays}
                              onChange={(e) => setDigestExtendDays(e.target.value)}
                              className="h-7 w-20"
                              data-testid={`rk-expiring-extend-input-${it.id}`}
                            />
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiring-extend-save-${it.id}`}
                              disabled={setExpiry.isPending || !digestExtendDays}
                              onClick={() => {
                                const d = Number(digestExtendDays);
                                if (Number.isInteger(d) && d >= 1 && d <= 3650) {
                                  setExpiry.mutate({ id: it.id, expiresInDays: d });
                                  setDigestExtendId(null);
                                  setDigestExtendDays("");
                                } else {
                                  toast({ title: "Invalid expiry", description: "Enter a whole number of days (1–3650).", variant: "destructive" });
                                }
                              }}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiring-extend-cancel-${it.id}`}
                              onClick={() => { setDigestExtendId(null); setDigestExtendDays(""); }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiring-extend-${it.id}`}
                              onClick={() => { setDigestExtendId(it.id); setDigestExtendDays(""); }}
                            >
                              Extend
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiring-revoke-${it.id}`}
                              disabled={revoke.isPending}
                              onClick={() => revoke.mutate(it.id)}
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Keys table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Registration Keys ({keysQuery.data?.total ?? 0})</span>
            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s || "ALL"}
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${statusFilter === s ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
                  data-testid={`rk-filter-${s || "ALL"}`}
                >
                  {s || "ALL"}
                  {keysQuery.data?.byStatus[s] !== undefined && s ? ` (${keysQuery.data.byStatus[s]})` : ""}
                </button>
              ))}
              <button
                onClick={() => setSoonOnly((v) => !v)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${soonOnly ? "bg-warning text-white border-warning" : "border-warning/50 text-warning hover:bg-warning/10"}`}
                data-testid="rk-filter-expiring-soon"
                title="Show only PENDING keys expiring within 7 days, soonest first"
              >
                Expiring soon{soonCount > 0 ? ` (${soonCount})` : ""}
              </button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {keysQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading keys…</div>
          ) : displayKeys.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center" data-testid="rk-empty">
              {soonOnly ? "No PENDING keys are expiring within 7 days." : "No registration keys found."}
            </div>
          ) : (
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="p-1">ID</th>
                  <th className="p-1">Key</th>
                  <th className="p-1">Status</th>
                  <th className="p-1">Assigned email</th>
                  <th className="p-1">Role</th>
                  <th className="p-1">Used by</th>
                  <th className="p-1">Used at</th>
                  <th className="p-1">Expires</th>
                  <th className="p-1">Note</th>
                  <th className="p-1">Created</th>
                  <th className="p-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayKeys.map((k) => (
                  <tr key={k.id} className="border-t align-top" data-testid={`rk-row-${k.id}`}>
                    <td className="p-1">{k.id}</td>
                    <td className="p-1 font-mono" data-testid={`rk-masked-${k.id}`}>
                      <span className="flex items-center gap-1">
                        <span>{k.keyMasked ?? k.inviteCodeMasked ?? "—"}</span>
                        {(k.keyMasked ?? k.inviteCodeMasked) && (
                          <CopyButton text={(k.keyMasked ?? k.inviteCodeMasked)!} />
                        )}
                      </span>
                    </td>
                    <td className="p-1"><StatusBadge status={k.status} expired={k.expired} /></td>
                    <td className="p-1">{k.email ?? <span className="text-muted-foreground italic">any</span>}</td>
                    <td className="p-1">{k.roleGrant ?? "USER"}</td>
                    <td className="p-1">{k.acceptedUserId ?? "—"}</td>
                    <td className="p-1">{k.acceptedAt ? new Date(k.acceptedAt).toISOString().slice(0, 10) : "—"}</td>
                    <td className="p-1" data-testid={`rk-expires-${k.id}`}><ExpiryCell expiresAt={k.expiresAt} status={k.status} /></td>
                    <td className="p-1 max-w-xs truncate text-muted-foreground">{k.notes ?? "—"}</td>
                    <td className="p-1">{new Date(k.invitedAt).toISOString().slice(0, 10)}</td>
                    <td className="p-1">
                      {k.status === "PENDING" && (
                        editingExpiryId === k.id ? (
                          <div className="flex items-center gap-1" data-testid={`rk-expiry-editor-${k.id}`}>
                            <Input
                              type="number" min={1} max={3650}
                              placeholder="days"
                              value={expiryDays}
                              onChange={(e) => setExpiryDays(e.target.value)}
                              className="h-7 w-20"
                              data-testid={`rk-expiry-input-${k.id}`}
                            />
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiry-save-${k.id}`}
                              disabled={setExpiry.isPending || !expiryDays}
                              onClick={() => {
                                const d = Number(expiryDays);
                                if (Number.isInteger(d) && d >= 1 && d <= 3650) {
                                  setExpiry.mutate({ id: k.id, expiresInDays: d });
                                } else {
                                  toast({ title: "Invalid expiry", description: "Enter a whole number of days (1–3650).", variant: "destructive" });
                                }
                              }}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiry-clear-${k.id}`}
                              disabled={setExpiry.isPending}
                              onClick={() => setExpiry.mutate({ id: k.id, expiresInDays: null })}
                            >
                              No expiry
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-expiry-cancel-${k.id}`}
                              onClick={() => { setEditingExpiryId(null); setExpiryDays(""); }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-edit-expiry-${k.id}`}
                              onClick={() => {
                                setEditingExpiryId(k.id);
                                setExpiryDays("");
                              }}
                            >
                              Edit expiry
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              data-testid={`rk-revoke-${k.id}`}
                              disabled={revoke.isPending}
                              onClick={() => revoke.mutate(k.id)}
                            >
                              Revoke
                            </Button>
                          </div>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function AdminBetaControlPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<Cohort>({
    queryKey: ["admin", "beta", "cohort"],
    queryFn: () => jsonFetch<Cohort>("/api/admin/beta/cohort"),
    refetchInterval: 15_000,
  });
  const [email, setEmail] = useState("");
  const [accountMode, setAccountMode] = useState<typeof ACCOUNT_MODES[number]>("DEMO_TESTER");
  const [notes, setNotes] = useState("");

  const invite = useMutation({
    mutationFn: () => jsonFetch<{ invite: Invite; rawCode: string; rawCodeNotice: string }>(
      "/api/admin/beta/invites",
      { method: "POST", body: JSON.stringify({ email, accountMode, notes }) },
    ),
    onSuccess: (res) => {
      setEmail(""); setNotes("");
      qc.invalidateQueries({ queryKey: ["admin", "beta", "cohort"] });
      toast({
        title: "Invite created — copy this code now",
        description: `${res.rawCode}  ·  ${res.rawCodeNotice}`,
        duration: 60_000,
      });
    },
    onError: (e: Error) => toast({ title: "Invite refused", description: e.message, variant: "destructive" }),
  });
  const act = useMutation({
    mutationFn: ({ id, op }: { id: number; op: "revoke" | "pause" | "resume" }) => jsonFetch(`/api/admin/beta/invites/${id}/${op}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "beta", "cohort"] }),
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  const joinReqs = useQuery<JoinRequestsResponse>({
    queryKey: ["admin", "join-requests"],
    queryFn: () => jsonFetch<JoinRequestsResponse>("/api/admin/join-requests"),
    refetchInterval: 15_000,
  });
  const approveReq = useMutation({
    mutationFn: (id: number) => jsonFetch<{ rawCode: string; rawCodeNotice: string }>(
      `/api/admin/join-requests/${id}/approve`,
      { method: "POST", body: JSON.stringify({}) },
    ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["admin", "join-requests"] });
      qc.invalidateQueries({ queryKey: ["admin", "beta", "cohort"] });
      toast({
        title: "Approved — invite created, copy this code now",
        description: `${res.rawCode}  ·  ${res.rawCodeNotice}`,
        duration: 60_000,
      });
    },
    onError: (e: Error) => toast({ title: "Approve refused", description: e.message, variant: "destructive" }),
  });
  const declineReq = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => jsonFetch(
      `/api/admin/join-requests/${id}/decline`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "join-requests"] });
      toast({ title: "Request declined" });
    },
    onError: (e: Error) => toast({ title: "Decline failed", description: e.message, variant: "destructive" }),
  });

  function handleDecline(id: number): void {
    const reason = window.prompt("Reason for declining this request (≥3 characters):")?.trim() ?? "";
    if (reason.length < 3) {
      toast({ title: "Decline cancelled", description: "A reason of at least 3 characters is required.", variant: "destructive" });
      return;
    }
    declineReq.mutate({ id, reason });
  }

  if (isLoading) return <div className="text-sm">Loading…</div>;
  if (error) return <div className="text-sm text-danger">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6 max-w-6xl" data-testid="page-admin-beta-control">
      <div>
        <h1 className="text-2xl font-bold">Beta Control Center</h1>
        <p className="text-sm text-muted-foreground">
          Cohort {data.cohort} · max {data.maxCohortSize} legacy seats ·
          Gate: {data.inviteGateEnabled ? <span className="text-success font-medium">ENABLED</span> : <span className="text-muted-foreground">off</span>} ·
          Pepper: {data.registrationKeyPepperConfigured ? <span className="text-success font-medium">configured</span> : <span className="text-warning font-medium">NOT SET</span>}
        </p>
      </div>

      {/* Join requests (recent first) — surfaced at the top */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Join requests
            {(joinReqs.data?.pendingCount ?? 0) > 0 && (
              <Badge variant="destructive" data-testid="join-requests-pending-badge">
                {joinReqs.data?.pendingCount} pending
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto text-sm">
          {joinReqs.isLoading ? (
            <div className="text-muted-foreground">Loading requests…</div>
          ) : (joinReqs.data?.requests.length ?? 0) === 0 ? (
            <div className="text-muted-foreground" data-testid="join-requests-empty">No join requests yet.</div>
          ) : (
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="p-1">ID</th><th className="p-1">Email</th><th className="p-1">Name</th>
                  <th className="p-1">Note</th><th className="p-1">Status</th><th className="p-1">Requested</th><th className="p-1">Actions</th>
                </tr>
              </thead>
              <tbody>{joinReqs.data?.requests.map((r) => (
                <tr key={r.id} className="border-t align-top" data-testid={`join-request-row-${r.id}`}>
                  <td className="p-1">{r.id}</td>
                  <td className="p-1">{r.email}</td>
                  <td className="p-1">{r.name ?? "—"}</td>
                  <td className="p-1 max-w-xs whitespace-pre-wrap break-words text-muted-foreground">{r.note ?? "—"}</td>
                  <td className="p-1">
                    <Badge variant={r.status === "PENDING" ? "default" : r.status === "APPROVED" ? "secondary" : "outline"}>{r.status}</Badge>
                  </td>
                  <td className="p-1">{new Date(r.createdAt).toISOString().slice(0, 10)}</td>
                  <td className="p-1">
                    {r.status === "PENDING" ? (
                      <div className="flex gap-1">
                        <Button size="sm" data-testid={`join-request-approve-${r.id}`}
                          disabled={approveReq.isPending || declineReq.isPending} onClick={() => approveReq.mutate(r.id)}>Approve</Button>
                        <Button size="sm" variant="ghost" data-testid={`join-request-decline-${r.id}`}
                          disabled={approveReq.isPending || declineReq.isPending} onClick={() => handleDecline(r.id)}>Decline</Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground" data-testid={`join-request-decision-${r.id}`}>
                        {r.status === "DECLINED" && r.declineReason ? `Declined: ${r.declineReason}` : r.status === "APPROVED" ? "Approved" : "—"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {data.waitlistActive && (joinReqs.data?.pendingCount ?? 0) > 0 && (
            <p className="mt-2 text-xs text-warning" data-testid="join-requests-waitlist-note">
              Cohort is at capacity — approving will be refused until a seat frees up.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Registration Keys (primary section) */}
      <section>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Key className="w-4 h-4" />
          Registration Keys
        </h2>
        <RegistrationKeysSection />
      </section>

      {/* Legacy cohort status */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">Legacy cohort status {data.waitlistActive && <Badge variant="destructive">WAITLIST ACTIVE</Badge>}</CardTitle></CardHeader>
        <CardContent className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>Active: <b>{data.activeCount}/{data.maxCohortSize}</b></div>
          <div>Seats remaining: <b>{data.seatsRemaining}</b></div>
          <div>PENDING: <b>{data.byStatus.PENDING ?? 0}</b></div>
          <div>ACCEPTED: <b>{data.byStatus.ACCEPTED ?? 0}</b></div>
          <div>PAUSED: <b>{data.byStatus.PAUSED ?? 0}</b></div>
          <div>REVOKED: <b>{data.byStatus.REVOKED ?? 0}</b></div>
        </CardContent>
      </Card>

      {/* Legacy invite creation */}
      <Card>
        <CardHeader><CardTitle>Invite a legacy beta user (email required, cap enforced)</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="block">Email<input data-testid="beta-invite-email" className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="block">Account mode<select data-testid="beta-invite-mode" className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={accountMode} onChange={(e) => setAccountMode(e.target.value as typeof ACCOUNT_MODES[number])}>
            {ACCOUNT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></label>
          <label className="block">Notes (optional)<input data-testid="beta-invite-notes" className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <Button data-testid="beta-invite-submit" disabled={!email || invite.isPending || data.waitlistActive} onClick={() => invite.mutate()}>
            {data.waitlistActive ? "Waitlist (cap reached)" : "Create legacy invite"}
          </Button>
        </CardContent>
      </Card>

      {/* Legacy invites table */}
      <Card>
        <CardHeader><CardTitle>Legacy invites ({data.invites.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="text-xs w-full"><thead><tr className="text-left text-muted-foreground">
            <th className="p-1">ID</th><th className="p-1">Email</th><th className="p-1">Mode</th>
            <th className="p-1">Status</th><th className="p-1">Invited</th><th className="p-1">Code</th><th className="p-1">Actions</th>
          </tr></thead>
            <tbody>{data.invites.map((r) => (
              <tr key={r.id} className="border-t" data-testid={`beta-invite-row-${r.id}`}>
                <td className="p-1">{r.id}</td>
                <td className="p-1">{r.email ?? "—"}</td>
                <td className="p-1">{r.accountMode}</td>
                <td className="p-1"><Badge>{r.status}</Badge></td>
                <td className="p-1">{new Date(r.invitedAt).toISOString().slice(0, 10)}</td>
                <td className="p-1 font-mono text-muted-foreground">{r.keyMasked ?? r.inviteCodeMasked ?? "—"}</td>
                <td className="p-1 flex gap-1">
                  {r.status === "PENDING" || r.status === "ACCEPTED" ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, op: "pause" })}>Pause</Button> : null}
                  {r.status === "PAUSED" ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, op: "resume" })}>Resume</Button> : null}
                  {r.status !== "REVOKED" ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, op: "revoke" })}>Revoke</Button> : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
