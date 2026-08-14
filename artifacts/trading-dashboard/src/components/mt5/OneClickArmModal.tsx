// OneClickArmModal — Task #353: Bridge-type-aware armed one-click trading.
//
// Shows the arm/disarm UI in a dialog. A single "I Agree — Arm One-Click
// Trading" button is the only user gesture required. No typed phrase, no
// repeated warnings. All 16 Phase B gates still run on every dispatch.
//
// ARM logic:
//   - OWN-bridge: self-arm once bridge is live/ready (master-live gate PASS).
//   - SHARED-bridge: admin must grant permission first.
//   - NONE: shown a "no bridge configured" message.
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Zap, ShieldCheck, AlertTriangle, ShieldOff } from "lucide-react";
import {
  usePostMeOneClickArm,
  usePostMeOneClickDisarm,
  type GetMeOneClickStatus200,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

type Props = {
  open: boolean;
  onClose: () => void;
  status: GetMeOneClickStatus200 | null;
  onArmed: () => void;
};

function humanizeBlockReason(reason: string | null | undefined): string {
  if (!reason) return "Cannot arm one-click trading.";
  const map: Record<string, string> = {
    NO_BRIDGE_CONFIGURED: "No trading bridge is configured for your account.",
    SHARED_BRIDGE_ONE_CLICK_NOT_PERMITTED: "Your account requires admin permission before arming one-click trading. Contact your administrator.",
    MASTER_LIVE_USER_ACCESS_BLOCKED: "Your live trading access is not yet fully approved.",
    DEFAULT_VOLUME_NOT_SET: "Set a default lot size in your one-click settings before arming.",
    USER_NOT_APPROVED_FOR_MASTER_LIVE: "Admin live-trading approval required.",
    USER_MASTER_LIVE_TOGGLE_OFF: "Live trading is currently disabled for your account.",
    USER_MASTER_LIVE_SUSPENDED: "Your live account is suspended.",
    USER_MASTER_LIVE_REVOKED: "Your live access has been revoked.",
  };
  return map[reason] ?? reason.replace(/_/g, " ");
}

export function OneClickArmModal({ open, onClose, status, onArmed }: Props) {
  const { toast } = useToast();
  const [agreed, setAgreed] = useState(false);
  const armMutation = usePostMeOneClickArm();
  const disarmMutation = usePostMeOneClickDisarm();
  const busy = armMutation.isPending || disarmMutation.isPending;

  if (!status) return null;

  const bridgeLabel = status.bridgeType === "OWN" ? "Own Bridge" : status.bridgeType === "SHARED" ? "Shared Bridge" : "No Bridge";

  async function handleArm() {
    if (!agreed) return;
    try {
      await armMutation.mutateAsync({ data: { agreed: true } });
      toast({ title: "One-click trading armed", description: "Buy and Sell now execute immediately." });
      setAgreed(false);
      onArmed();
      onClose();
    } catch (e) {
      const data = (e as { data?: { blockReason?: string; error?: string } | null }).data;
      toast({ title: "Arm failed", description: data?.blockReason ?? data?.error ?? (e as Error).message, variant: "destructive" });
    }
  }

  async function handleDisarm() {
    try {
      await disarmMutation.mutateAsync();
      toast({ title: "One-click trading disarmed" });
      onArmed();
      onClose();
    } catch (e) {
      const data = (e as { data?: { error?: string } | null }).data;
      toast({ title: "Disarm failed", description: data?.error ?? (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            {status.armed ? "Disarm One-Click Trading" : "Arm One-Click Trading"}
          </DialogTitle>
          <DialogDescription>
            {status.armed
              ? "Disarming restores the confirmation step before every Buy or Sell."
              : "Once armed, Buy and Sell buttons execute immediately — no extra confirmation."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-2">
            <Badge variant={status.bridgeType === "NONE" ? "destructive" : "secondary"} className="text-xs">
              {bridgeLabel}
            </Badge>
            {status.armed && (
              <Badge variant="default" className="text-xs bg-green-600">
                ARMED
              </Badge>
            )}
          </div>

          {status.armed ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <ShieldOff className="w-4 h-4 text-amber-400" />
              <AlertTitle>Currently armed</AlertTitle>
              <AlertDescription className="text-xs">
                Buy and Sell execute immediately. Disarming restores the per-trade
                confirmation dialog. All 16 safety gates remain active regardless.
              </AlertDescription>
            </Alert>
          ) : !status.canArm ? (
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertTitle>Cannot arm</AlertTitle>
              <AlertDescription className="text-xs">
                {humanizeBlockReason(status.canArmBlockReason)}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Alert className="border-emerald-500/30 bg-emerald-500/5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <AlertTitle>What arming means</AlertTitle>
                <AlertDescription className="text-xs space-y-1">
                  <p>• Buy and Sell execute immediately with your saved defaults (lot: <b>{status.defaultVolume}</b>, symbol: <b>{status.defaultSymbol}</b>).</p>
                  <p>• All 16 Phase B safety gates still run on every trade — arm only removes the manual confirmation step.</p>
                  <p>• You can disarm at any time from this screen.</p>
                </AlertDescription>
              </Alert>

              <div className="flex items-start gap-3 rounded-md border border-border bg-background/40 p-3">
                <Checkbox
                  id="arm-agree"
                  checked={agreed}
                  onCheckedChange={(v) => setAgreed(v === true)}
                  disabled={busy}
                />
                <Label htmlFor="arm-agree" className="text-sm leading-snug cursor-pointer">
                  I understand that Buy and Sell will execute immediately without a
                  confirmation dialog. All backend safety gates remain active.
                </Label>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {status.armed ? (
            <Button variant="destructive" onClick={handleDisarm} disabled={busy}>
              {busy ? "Disarming…" : "Disarm One-Click"}
            </Button>
          ) : (
            <Button
              onClick={handleArm}
              disabled={busy || !status.canArm || !agreed}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {busy ? "Arming…" : "I Agree — Arm One-Click Trading"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
