import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield, CheckCircle, XCircle, AlertTriangle,
  RotateCcw, Plus, ChevronRight, Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { PageShell } from "@/components/ss/PageShell";
import { useAssistantName } from "@/lib/assistant-name";

const apiFetch = (url: string) =>
  fetch(url, { credentials: "include" }).then((r) => r.json());

const apiPost = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

type Version = {
  id: number; versionId: string; versionName: string;
  changeType: string; changeSummary: string;
  dataQualityScore: number | null; walkForwardScore: number | null;
  shadowAccuracy: number | null; shadowSampleSize: number | null;
  dataValidated: boolean; walkForwardPassed: boolean; shadowValidated: boolean;
  adminApproved: boolean; liveAllowed: boolean; isActive: boolean;
  rolledBack: boolean; deployedAt: string | null; createdAt: string;
  adminNotes: string | null;
};

function GateBadge({ passed, label }: { passed: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${passed ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`}>
      {passed ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </div>
  );
}

function VersionCard({ v, onApprove, onRollback }: {
  v: Version;
  onApprove: (v: Version) => void;
  onRollback: (v: Version) => void;
}) {
  const allGatesPassed = v.dataValidated && v.walkForwardPassed && v.shadowValidated;

  return (
    <Card className={v.isActive ? "border-primary" : v.rolledBack ? "opacity-60" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-sm">{v.versionName}</CardTitle>
              {v.isActive && <Badge className="text-xs">Active</Badge>}
              {v.liveAllowed && !v.rolledBack && <Badge variant="default" className="text-xs bg-success">Live</Badge>}
              {v.rolledBack && <Badge variant="destructive" className="text-xs">Rolled Back</Badge>}
              {!v.liveAllowed && !v.rolledBack && <Badge variant="secondary" className="text-xs">Pending</Badge>}
            </div>
            <CardDescription className="mt-0.5 text-xs">{v.changeSummary}</CardDescription>
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {new Date(v.createdAt).toLocaleDateString()}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Scores */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded border p-2 text-center">
            <div className="text-muted-foreground mb-0.5">Data Quality</div>
            <div className={`font-mono font-medium ${(v.dataQualityScore ?? 0) >= 60 ? "text-success" : "text-danger"}`}>
              {v.dataQualityScore ?? "—"}/100
            </div>
          </div>
          <div className="rounded border p-2 text-center">
            <div className="text-muted-foreground mb-0.5">Walk-Forward</div>
            <div className={`font-mono font-medium ${(v.walkForwardScore ?? 0) >= 52 ? "text-success" : "text-danger"}`}>
              {v.walkForwardScore != null ? `${v.walkForwardScore}%` : "—"}
            </div>
          </div>
          <div className="rounded border p-2 text-center">
            <div className="text-muted-foreground mb-0.5">Shadow ({v.shadowSampleSize ?? 0})</div>
            <div className={`font-mono font-medium ${(v.shadowAccuracy ?? 0) >= 50 ? "text-success" : "text-danger"}`}>
              {v.shadowAccuracy != null ? `${v.shadowAccuracy}%` : "—"}
            </div>
          </div>
        </div>

        {/* Gates */}
        <div className="flex flex-wrap gap-1.5">
          <GateBadge passed={v.dataValidated}    label="Data" />
          <GateBadge passed={v.walkForwardPassed} label="Walk-Forward" />
          <GateBadge passed={v.shadowValidated}   label="Shadow" />
          <GateBadge passed={v.adminApproved}     label="Admin" />
        </div>

        {/* Actions */}
        {!v.rolledBack && (
          <div className="flex gap-2">
            {!v.liveAllowed && allGatesPassed && (
              <Button size="sm" onClick={() => onApprove(v)}>
                Approve for Live
              </Button>
            )}
            {!v.liveAllowed && !allGatesPassed && (
              <p className="text-xs text-muted-foreground">
                Waiting for all gates to pass before approval is available.
              </p>
            )}
            {v.liveAllowed && (
              <Button size="sm" variant="destructive" onClick={() => onRollback(v)}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Rollback
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminLearningVersionsPage() {
  const { name } = useAssistantName();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [approveTarget, setApproveTarget] = useState<Version | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<Version | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const [newVersion, setNewVersion] = useState({
    versionName: "", changeType: "global_signal_edges", changeSummary: "",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "learning", "versions"],
    queryFn:  () => apiFetch("/api/admin/learning/versions"),
    refetchInterval: 30_000,
  });

  const { data: activeData } = useQuery({
    queryKey: ["admin", "learning", "active"],
    queryFn:  () => apiFetch("/api/admin/learning/active"),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof newVersion) => apiPost("/api/admin/learning/versions", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "learning"] });
      setShowCreate(false);
      setNewVersion({ versionName: "", changeType: "global_signal_edges", changeSummary: "" });
    },
  });

  const approveMut = useMutation({
    mutationFn: ({ versionId, notes }: { versionId: string; notes?: string }) =>
      apiPost(`/api/admin/learning/versions/${versionId}/approve`, { adminNotes: notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "learning"] });
      setApproveTarget(null);
    },
  });

  const rollbackMut = useMutation({
    mutationFn: ({ versionId, reason }: { versionId: string; reason: string }) =>
      apiPost(`/api/admin/learning/versions/${versionId}/rollback`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "learning"] });
      setRollbackTarget(null);
      setRollbackReason("");
    },
  });

  const versions = (data?.versions ?? []) as Version[];
  const active = activeData?.activeVersion as Version | null;

  return (
    <PageShell
      title="Learning Model Versions"
      description="Govern global learning updates. All 4 gates must pass before a version influences live recommendations."
      icon={<Shield className="h-6 w-6" />}
    >
      {/* Active version banner */}
      {active ? (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertTitle>Active version: {active.versionName}</AlertTitle>
          <AlertDescription>
            Shadow accuracy {active.shadowAccuracy ?? "—"}% · Deployed{" "}
            {active.deployedAt ? new Date(active.deployedAt).toLocaleDateString() : "—"}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>No active version</AlertTitle>
          <AlertDescription>
            {name} is using individual user history only. Create and approve a version to enable global insights.
          </AlertDescription>
        </Alert>
      )}

      {/* Gate legend */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Validation Gates</CardTitle>
          <CardDescription className="text-xs">All 4 must pass. Admin approval is the final step.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {[
            { label: "Data Quality",  threshold: "Score ≥ 60"   },
            { label: "Walk-Forward",  threshold: "Win rate ≥ 52%" },
            { label: "Shadow Mode",   threshold: "Accuracy ≥ 50% from 20+ predictions" },
            { label: "Admin Approval",threshold: "Explicit operator sign-off" },
          ].map((g) => (
            <div key={g.label} className="rounded border p-2">
              <div className="font-medium mb-0.5">{g.label}</div>
              <div className="text-muted-foreground">{g.threshold}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Create button */}
      <Button onClick={() => setShowCreate(true)} className="w-full sm:w-auto">
        <Plus className="h-4 w-4 mr-1.5" />
        Record New Learning Update
      </Button>

      {/* Versions list */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading versions…</div>
      ) : versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">No versions recorded yet.</div>
      ) : (
        <div className="space-y-3">
          {versions.map((v) => (
            <VersionCard
              key={v.versionId}
              v={v}
              onApprove={setApproveTarget}
              onRollback={setRollbackTarget}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Learning Update</DialogTitle>
            <DialogDescription>
              This creates a version record and computes current gate scores. No changes are deployed yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Version name</label>
              <Input
                value={newVersion.versionName}
                onChange={(e) => setNewVersion((n) => ({ ...n, versionName: e.target.value }))}
                placeholder="e.g. Global edge update May 2025"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Change type</label>
              <Select
                value={newVersion.changeType}
                onValueChange={(v) => setNewVersion((n) => ({ ...n, changeType: v }))}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="global_signal_edges">Global Signal Edges</SelectItem>
                  <SelectItem value="confidence_calibration">Confidence Calibration</SelectItem>
                  <SelectItem value="scanner_scoring">Scanner Scoring</SelectItem>
                  <SelectItem value="dna_weights">DNA Weights</SelectItem>
                  <SelectItem value="ruby_behavior">{name} Behavior</SelectItem>
                  <SelectItem value="risk_thresholds">Risk Thresholds</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">What changed</label>
              <Textarea
                value={newVersion.changeSummary}
                onChange={(e) => setNewVersion((n) => ({ ...n, changeSummary: e.target.value }))}
                placeholder="Describe what was updated and why…"
                className="mt-1 resize-none"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              disabled={!newVersion.versionName || !newVersion.changeSummary || createMut.isPending}
              onClick={() => createMut.mutate(newVersion)}
            >
              {createMut.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Create Version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve dialog */}
      {approveTarget && (
        <Dialog open onOpenChange={() => setApproveTarget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Approve for Live?</DialogTitle>
              <DialogDescription>
                This will activate <strong>{approveTarget.versionName}</strong> and allow it to
                influence {name}'s global learning insights. All previous active versions will be
                deactivated. This action is logged.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setApproveTarget(null)}>Cancel</Button>
              <Button
                disabled={approveMut.isPending}
                onClick={() => approveMut.mutate({ versionId: approveTarget.versionId })}
              >
                {approveMut.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Rollback dialog */}
      {rollbackTarget && (
        <Dialog open onOpenChange={() => { setRollbackTarget(null); setRollbackReason(""); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <RotateCcw className="h-4 w-4" /> Rollback this version?
              </DialogTitle>
              <DialogDescription>
                This immediately deactivates <strong>{rollbackTarget.versionName}</strong> and removes
                it from live recommendations. {name} reverts to individual user history only.
              </DialogDescription>
            </DialogHeader>
            <div>
              <label className="text-sm font-medium">Reason (required)</label>
              <Textarea
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                placeholder="Why are you rolling back this version?"
                className="mt-1 resize-none"
                rows={2}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => { setRollbackTarget(null); setRollbackReason(""); }}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!rollbackReason.trim() || rollbackMut.isPending}
                onClick={() => rollbackMut.mutate({ versionId: rollbackTarget.versionId, reason: rollbackReason })}
              >
                {rollbackMut.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Rollback
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageShell>
  );
}
