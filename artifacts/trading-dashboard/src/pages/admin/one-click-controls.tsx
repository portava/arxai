// Task #353 — Admin: One-Click Trading Permission Controls
//
// Grants / revokes shared-bridge one-click permission for individual users.
// Auto-disarm fires on revoke. Requires ADMIN or OWNER session.
//
// Data source: GET /api/admin/one-click/shared-bridge-users
// Mutations:   POST /api/admin/one-click/users/:userId/grant
//              POST /api/admin/one-click/users/:userId/revoke
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { Zap, RefreshCw, ShieldCheck, ShieldOff, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useGetAdminOneClickSharedBridgeUsers,
  usePostAdminOneClickUsersGrant,
  usePostAdminOneClickUsersRevoke,
} from "@workspace/api-client-react";

export default function AdminOneClickControlsPage() {
  return (
    <AdminDiagnosticsGate pageTitle="One-Click Trading Controls">
      <OneClickControlsContent />
    </AdminDiagnosticsGate>
  );
}

// Exported so the admin live-approval screen (master-bridge.tsx) can embed the
// SAME status + admin-disable controls without duplicating the data hooks or
// adding a new endpoint. `embedded` drops the standalone page chrome so it sits
// inside another admin page that already provides its own header + gate.
export function OneClickControlsContent({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = useGetAdminOneClickSharedBridgeUsers();
  const grantMutation = usePostAdminOneClickUsersGrant();
  const revokeMutation = usePostAdminOneClickUsersRevoke();
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  const users = data?.users ?? [];
  const loading = isLoading;
  const err = isError
    ? ((error as { data?: { error?: string } | null }).data?.error ?? (error as Error).message)
    : null;

  async function grant(userId: number) {
    const reason = (reasons[userId] ?? "").trim();
    if (reason.length < 3) {
      toast({ title: "Reason required", description: "Enter a reason (min 3 chars).", variant: "destructive" });
      return;
    }
    setBusy((prev) => ({ ...prev, [userId]: true }));
    try {
      await grantMutation.mutateAsync({ userId, data: { reason } });
      toast({ title: "One-click permission granted" });
      setReasons((prev) => ({ ...prev, [userId]: "" }));
      void refetch();
    } catch (e) {
      const data = (e as { data?: { error?: string } | null }).data;
      toast({ title: "Grant failed", description: data?.error ?? (e as Error).message, variant: "destructive" });
    } finally {
      setBusy((prev) => ({ ...prev, [userId]: false }));
    }
  }

  async function revoke(userId: number) {
    const reason = (reasons[userId] ?? "").trim();
    if (reason.length < 3) {
      toast({ title: "Reason required", description: "Enter a reason (min 3 chars).", variant: "destructive" });
      return;
    }
    setBusy((prev) => ({ ...prev, [userId]: true }));
    try {
      const res = await revokeMutation.mutateAsync({ userId, data: { reason } });
      toast({ title: "One-click permission revoked", description: res.autoDisarmed ? "User was also disarmed." : undefined });
      setReasons((prev) => ({ ...prev, [userId]: "" }));
      void refetch();
    } catch (e) {
      const data = (e as { data?: { error?: string } | null }).data;
      toast({ title: "Revoke failed", description: data?.error ?? (e as Error).message, variant: "destructive" });
    } finally {
      setBusy((prev) => ({ ...prev, [userId]: false }));
    }
  }

  return (
    <div className={embedded ? "space-y-6" : "mx-auto w-full max-w-[1100px] space-y-6 p-4 md:p-6 pb-32 md:pb-6"}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className="w-6 h-6 text-warning" />
          <div>
            {embedded
              ? <h2 className="text-lg font-bold">One-Click Trading Controls</h2>
              : <h1 className="text-xl font-bold">One-Click Trading Controls</h1>}
            <p className="text-sm text-muted-foreground">
              Grant or revoke one-click trading permission for shared-bridge users.
              Revoking automatically disarms the user.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Alert className="border-warning/30 bg-warning/5">
        <ShieldCheck className="w-4 h-4 text-warning" />
        <AlertTitle>Scope: shared-bridge users only</AlertTitle>
        <AlertDescription className="text-xs">
          Own-bridge users self-arm from their MT5 Setup page once their bridge is live/ready.
          This page controls shared-bridge one-click permission only. All 16 Phase B safety
          gates remain active regardless of permission state.
        </AlertDescription>
      </Alert>

      {err && (
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Load error</AlertTitle>
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}

      {!loading && users.length === 0 && !err && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground text-sm">
            No users in the master live access table yet.
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {users.map((u) => (
          <Card key={u.userId} className="border border-border">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm text-muted-foreground">#{u.userId}</span>
                  <span>{u.email}</span>
                  {u.name && <span className="text-sm text-muted-foreground">({u.name})</span>}
                </span>
                <div className="flex items-center gap-2">
                  {u.oneClickArmed && (
                    <Badge variant="default" className="bg-success text-xs">
                      <Zap className="w-3 h-3 mr-1" />ARMED
                    </Badge>
                  )}
                  <Badge variant={u.sharedBridgeOneClickPermitted ? "default" : "secondary"} className="text-xs">
                    {u.sharedBridgeOneClickPermitted ? (
                      <><ShieldCheck className="w-3 h-3 mr-1" />Permitted</>
                    ) : (
                      <><ShieldOff className="w-3 h-3 mr-1" />Not permitted</>
                    )}
                  </Badge>
                  {u.oneClickBridgeType && (
                    <Badge variant="outline" className="text-xs" title="Current resolved one-click bridge type">
                      {u.oneClickBridgeType}
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-xs">{u.masterLiveStatus}</Badge>
                </div>
              </CardTitle>
              <CardDescription className="text-xs space-y-0.5">
                {u.sharedBridgeOneClickPermittedAt && (
                  <span className="block text-success">
                    Permitted: {new Date(u.sharedBridgeOneClickPermittedAt).toLocaleString()}
                  </span>
                )}
                {u.sharedBridgeOneClickRevokedAt && (
                  <span className="block text-warning">
                    Last revoked: {new Date(u.sharedBridgeOneClickRevokedAt).toLocaleString()}
                  </span>
                )}
                {u.oneClickArmedAt && (
                  <span className="block text-muted-foreground">
                    Armed: {new Date(u.oneClickArmedAt).toLocaleString()}
                  </span>
                )}
                {u.lastAuditAction && (
                  <span className="block text-muted-foreground">
                    Last action: <span className="font-mono text-xs">{u.lastAuditAction.replace(/_/g, " ")}</span>
                    {u.lastAuditAt ? ` — ${new Date(u.lastAuditAt).toLocaleString()}` : ""}
                  </span>
                )}
                {!!u.lastAuditMetadata?.resultStatus && (
                  <span className="block text-muted-foreground text-xs">
                    Result: <span className="font-mono">{String(u.lastAuditMetadata.resultStatus)}</span>
                    {u.lastAuditMetadata.source ? <> · Source: <span className="font-mono">{String(u.lastAuditMetadata.source)}</span></> : null}
                  </span>
                )}
                {!!u.lastAuditMetadata?.blockReason && (
                  <span className="block text-warning text-xs">
                    Block reason: <span className="font-mono">{String(u.lastAuditMetadata.blockReason)}</span>
                  </span>
                )}
                {!!u.lastAuditMetadata?.bridgeType && !u.lastAuditMetadata?.blockReason && (
                  <span className="block text-muted-foreground text-xs">
                    Bridge type at event: <span className="font-mono">{String(u.lastAuditMetadata.bridgeType)}</span>
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground mb-1 block">Reason (required)</Label>
                  <Input
                    placeholder="Enter reason…"
                    value={reasons[u.userId] ?? ""}
                    onChange={(e) => setReasons((prev) => ({ ...prev, [u.userId]: e.target.value }))}
                    className="h-8 text-sm"
                    disabled={busy[u.userId]}
                  />
                </div>
                {u.sharedBridgeOneClickPermitted ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void revoke(u.userId)}
                    disabled={busy[u.userId]}
                  >
                    <ShieldOff className="w-4 h-4 mr-1" />
                    {busy[u.userId] ? "Revoking…" : "Revoke"}
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void grant(u.userId)}
                    disabled={busy[u.userId] || !u.approvedForMasterLive}
                    title={!u.approvedForMasterLive ? "User must be approved for master live first" : undefined}
                    className="bg-warning hover:bg-warning/15"
                  >
                    <ShieldCheck className="w-4 h-4 mr-1" />
                    {busy[u.userId] ? "Granting…" : "Grant"}
                  </Button>
                )}
              </div>
              {!u.approvedForMasterLive && !u.sharedBridgeOneClickPermitted && (
                <p className="text-xs text-warning">
                  Approve this user for master live trading before granting one-click permission.
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
