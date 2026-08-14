// User-facing — Request Live Bridge Access (Phase 22V Part 2)
//
// Shows the user their request status and provides a friendly Request
// button + risk-disclosure checkbox + optional note. NEVER shows admin
// labels, broker labels, env names, audit, kill switch, or other users.
//
// Status states:
//   NOT_REQUESTED   → big "Request Live Bridge Access" button
//   PENDING         → "Pending review" badge
//   APPROVED        → "Live Bridge Access: Approved" + execution route hint
//   DENIED          → friendly denial reason
//   REVOKED         → friendly revocation reason
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { CheckCircle2, Clock, ShieldCheck, ShieldAlert, XCircle, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type RequestState = "NOT_REQUESTED" | "PENDING" | "APPROVED" | "DENIED" | "REVOKED";

type AccessResponse = {
  ok: boolean;
  canTrade: boolean;
  status: string;
  defaultExecutionRoute: string;
  // Phase 22V Part 3 — server-advertised default trading mode + friendly
  // template name. "LIVE_SHARED_BRIDGE" when approved, "PAPER" otherwise.
  defaultTradingMode?: "LIVE_SHARED_BRIDGE" | "PAPER";
  riskTemplateName?: string | null;
  blockReason: string | null;
  message: string | null;
  request: {
    requestState: RequestState;
    requestedAt: string | null;
    requestNote: string | null;
    deniedReason: string | null;
    deniedAt: string | null;
    revokedAt: string | null;
    revokedReason: string | null;
  };
};

const STATE_META: Record<RequestState, { label: string; badge: string; Icon: React.ComponentType<{ className?: string }>; }> = {
  NOT_REQUESTED: { label: "Not requested", badge: "bg-slate-500/20 text-slate-300", Icon: ShieldAlert },
  PENDING:       { label: "Pending review", badge: "bg-amber-500/30 text-amber-200", Icon: Clock },
  APPROVED:      { label: "Approved", badge: "bg-emerald-500/30 text-emerald-200", Icon: CheckCircle2 },
  DENIED:        { label: "Not approved", badge: "bg-rose-500/30 text-rose-200", Icon: XCircle },
  REVOKED:       { label: "Access revoked", badge: "bg-rose-600/30 text-rose-200", Icon: XCircle },
};

export function RequestLiveBridgeAccessCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [ackRisk, setAckRisk] = useState(false);

  const query = useQuery<AccessResponse>({
    queryKey: ["me-master-live-access"],
    queryFn: async () => {
      const r = await fetch("/api/me/master-live/access", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/me/master-live/request-access", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: note.trim() || undefined,
          riskDisclosureAccepted: true,
        }),
      });
      const json = await r.json();
      if (!r.ok || !json.ok) {
        throw new Error(json.message ?? json.error ?? "Request failed");
      }
      return json;
    },
    onSuccess: () => {
      toast({
        title: "Request submitted",
        description: "Your live bridge access request has been sent for review.",
      });
      setOpen(false);
      setNote("");
      setAckRisk(false);
      void qc.invalidateQueries({ queryKey: ["me-master-live-access"] });
    },
    onError: (e: Error) => {
      toast({
        title: "Could not submit request",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const data = query.data;
  const state: RequestState = data?.request?.requestState ?? "NOT_REQUESTED";
  const meta = STATE_META[state];
  const Icon = meta.Icon;

  return (
    <Card data-testid="card-request-live-bridge">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Live Trading Access
          <Badge className={meta.badge}>
            <Icon className="w-3 h-3 mr-1" />
            {meta.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          Live trading on the shared bridge requires approval. Submit a
          request and you'll be notified once it's reviewed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === "APPROVED" && (
          <Alert className="border-emerald-600/40 bg-emerald-600/10" data-testid="alert-approved-live-bridge">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <AlertTitle>Live Bridge Access: Approved</AlertTitle>
            <AlertDescription className="text-xs space-y-1">
              <div>
                You're set to use the shared live bridge by default. Live
                orders still require the bridge to be connected and every
                safety check to pass before they're sent.
              </div>
              <ul className="text-[11px] space-y-0.5 pt-1">
                <li>
                  <span className="text-muted-foreground">Default Mode:</span>{" "}
                  <span className="text-emerald-300 font-medium" data-testid="text-default-trading-mode">
                    {data?.defaultTradingMode === "LIVE_SHARED_BRIDGE" ? "Live Shared Bridge" : "Demo"}
                  </span>
                </li>
                {data?.riskTemplateName && (
                  <li>
                    <span className="text-muted-foreground">Risk Template:</span>{" "}
                    <span className="font-medium" data-testid="text-risk-template-name">{data.riskTemplateName}</span>
                  </li>
                )}
                <li>
                  <span className="text-muted-foreground">Execution Route:</span>{" "}
                  <span className="font-medium">Shared Master Bridge</span>
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {state === "PENDING" && (
          <Alert className="border-amber-500/40 bg-amber-500/10">
            <Clock className="w-4 h-4 text-amber-300" />
            <AlertTitle>Your request is pending review</AlertTitle>
            <AlertDescription className="text-xs">
              Submitted{" "}
              {data?.request?.requestedAt
                ? new Date(data.request.requestedAt).toLocaleString()
                : "recently"}
              . You'll be notified once it's reviewed.
            </AlertDescription>
          </Alert>
        )}

        {state === "DENIED" && (
          <Alert className="border-rose-500/40 bg-rose-500/10">
            <XCircle className="w-4 h-4 text-rose-300" />
            <AlertTitle>Your request was not approved</AlertTitle>
            <AlertDescription className="text-xs">
              {data?.request?.deniedReason ?? "Please contact support if you have questions."}
            </AlertDescription>
          </Alert>
        )}

        {state === "REVOKED" && (
          <Alert className="border-rose-500/40 bg-rose-500/10">
            <XCircle className="w-4 h-4 text-rose-300" />
            <AlertTitle>Your live bridge access was revoked</AlertTitle>
            <AlertDescription className="text-xs">
              {data?.request?.revokedReason ?? "Please contact support if you have questions."}
            </AlertDescription>
          </Alert>
        )}

        {(state === "NOT_REQUESTED" || state === "DENIED" || state === "REVOKED") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button
                size="lg"
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
                data-testid="btn-request-live-bridge"
              >
                <Send className="w-4 h-4 mr-2" />
                Request Live Bridge Access
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Request Live Bridge Access</DialogTitle>
                <DialogDescription>
                  Once approved, live orders will be placed against a real
                  trading account. Trading involves risk and you may lose
                  money. Approved accounts start with conservative limits
                  (small lot size, single open position, daily loss cap).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium">Why do you want access? (optional)</label>
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 1000))}
                    placeholder="Tell the reviewer a bit about your trading background or goals."
                    rows={3}
                    data-testid="input-request-note"
                  />
                  <div className="text-[10px] text-muted-foreground text-right">{note.length}/1000</div>
                </div>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={ackRisk}
                    onCheckedChange={(c) => setAckRisk(c === true)}
                    data-testid="cb-ack-risk"
                  />
                  <span>
                    I understand that live trading carries real financial
                    risk, that approved accounts start with conservative
                    safety limits, and that I'm responsible for my own
                    trading decisions.
                  </span>
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
                  Cancel
                </Button>
                <Button
                  onClick={() => mutation.mutate()}
                  disabled={!ackRisk || mutation.isPending}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white"
                  data-testid="btn-confirm-request"
                >
                  {mutation.isPending ? "Submitting…" : "Submit Request"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {state === "PENDING" && (
          <Button size="sm" variant="outline" disabled className="w-full">
            <Clock className="w-3 h-3 mr-2" />
            Request submitted — pending review
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
