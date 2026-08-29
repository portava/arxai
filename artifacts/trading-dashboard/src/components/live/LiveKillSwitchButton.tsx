import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertOctagon, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function LiveKillSwitchButton() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const arming = useQuery<{ arming: { isArmed: boolean; killSwitchEngaged: boolean; killSwitchReason: string | null } | null }>({
    queryKey: ["live", "arming"],
    queryFn: () => fetch(`${BASE}/api/me/live/arming`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 10_000,
  });

  const engage = useMutation({
    mutationFn: () => fetch(`${BASE}/api/me/live/kill-switch/engage`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || "manual_engage" }),
    }).then((r) => r.json()),
    onSuccess: () => {
      toast({ variant: "destructive", title: "Kill switch engaged", description: "New live trades blocked. Demo trading unaffected." });
      setOpen(false); setReason("");
      qc.invalidateQueries({ queryKey: ["live"] });
      // Kill-switch flips userCanManualTrade in the unified envelope.
      qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
    },
  });

  const release = useMutation({
    mutationFn: () => fetch(`${BASE}/api/me/live/kill-switch/release`, {
      method: "POST", credentials: "include",
    }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Kill switch released" });
      qc.invalidateQueries({ queryKey: ["live"] });
      qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
    },
  });

  const killed = !!arming.data?.arming?.killSwitchEngaged;

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-danger">
          <ShieldAlert className="h-5 w-5" /> Emergency Live Kill Switch
        </CardTitle>
        <CardDescription>
          Immediately disables all NEW live trade commands for your account.
          Demo trading is not affected. Re-arm required after release.
        </CardDescription>
        {/* WHICH STOP IS THIS? — the platform carries several stop surfaces and
            each one now names its own reach, so an operator cannot pull the
            wrong lever in a hurry. This is the per-user arming switch that the
            live dispatch pipeline reads (arx_live_arming.kill_switch_engaged). */}
        <p className="text-xs text-muted-foreground" data-testid="live-kill-scope">
          Scope: <strong>your account only</strong> — it halts your live order dispatch, not other
          users&apos;. To halt live dispatch for everyone, use the{" "}
          <a href="/emergency" className="underline">platform Emergency kill switch</a>.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {killed && (
          <Alert variant="destructive">
            <AlertOctagon className="h-4 w-4" />
            <AlertTitle>Kill switch ENGAGED</AlertTitle>
            <AlertDescription>{arming.data?.arming?.killSwitchReason ?? "No reason recorded"}</AlertDescription>
          </Alert>
        )}
        {killed ? (
          <Button variant="outline" onClick={() => release.mutate()} disabled={release.isPending} data-testid="btn-release-kill">
            Release kill switch
          </Button>
        ) : (
          <Button
            variant="destructive"
            size="lg"
            className="w-full sm:w-auto bg-danger hover:bg-danger/15 text-white font-bold uppercase tracking-wide"
            onClick={() => setOpen(true)}
            data-testid="btn-engage-kill"
          >
            <AlertOctagon className="h-5 w-5 mr-2" /> Engage live kill switch
          </Button>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-danger">Confirm kill switch</DialogTitle>
            <DialogDescription>
              This disables every NEW live trade. Existing open positions remain
              open — close them manually on this page or in MT5.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="kill-reason">Reason (logged to audit)</Label>
            <Input id="kill-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unusual market behavior" data-testid="input-kill-reason" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => engage.mutate()} disabled={engage.isPending} data-testid="btn-confirm-kill">
              Engage now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
