// Task #705 — Admin Claude Backend Fix Agent (ADMIN/OWNER only).
//
// SAFETY / SCOPE:
//   - Lives under /admin → RouteAccessGuard already requires an effective-admin
//     session; AdminDiagnosticsGate is defence-in-depth for preview-as-user.
//   - ADVISORY / DIAGNOSTIC ONLY. This page asks the backend Fix Agent to
//     diagnose an error or propose a DRY-RUN patch. It NEVER applies a change,
//     places/approves a trade, touches the bridge, or overrides a risk gate.
//   - Inputs are redacted server-side before the model call and before they are
//     persisted. The page surfaces only structured advice + a run ledger.

import { useMemo, useState } from "react";
import {
  useAdminFixAgentHealth,
  useAdminFixAgentDiagnose,
  useAdminFixAgentProposePatch,
  useAdminFixAgentListRuns,
  useAdminFixAgentRecentErrors,
  FixAgentRequestArea,
  FixAgentRequestModel,
  type FixAgentRequest,
  type FixAgentDiagnosis,
  type FixAgentPatchProposal,
  type FixAgentRecentError,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Stethoscope,
  Wrench,
  ShieldAlert,
  History,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const AREA_OPTIONS = Object.values(FixAgentRequestArea);
const MODEL_OPTIONS = Object.values(FixAgentRequestModel);

function severityVariant(
  sev: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (sev === "critical" || sev === "high") return "destructive";
  if (sev === "medium") return "default";
  return "secondary";
}

function HealthBanner() {
  const { data, isLoading } = useAdminFixAgentHealth();
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  const h = data;
  if (!h) return null;
  const ready = h.enabled && h.providerConfigured;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        {ready ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : (
          <XCircle className="h-5 w-5 text-amber-500" />
        )}
        <span className="text-sm font-medium">
          {ready
            ? "Fix Agent ready"
            : h.enabled
              ? "Provider not configured"
              : "Fix Agent disabled"}
        </span>
        <Badge variant="outline">provider: {h.provider}</Badge>
        <Badge variant="outline">model: {h.model}</Badge>
        <Badge variant={h.dryRun ? "secondary" : "destructive"}>
          {h.dryRun ? "dry-run" : "DRY-RUN OFF"}
        </Badge>
      </CardContent>
    </Card>
  );
}

function DiagnosisView({ d }: { d: FixAgentDiagnosis }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant={severityVariant(d.severity)}>severity: {d.severity}</Badge>
        <Badge variant="outline">confidence: {d.confidence}</Badge>
        {d.raw ? <Badge variant="outline">unstructured</Badge> : null}
      </div>
      <p className="whitespace-pre-wrap text-sm">{d.summary}</p>
      {d.likelyCauses.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Likely causes</p>
          <ul className="ml-4 list-disc text-sm">
            {d.likelyCauses.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {d.affectedAreas.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Affected areas</p>
          <div className="flex flex-wrap gap-1">
            {d.affectedAreas.map((a, i) => (
              <Badge key={i} variant="secondary">{a}</Badge>
            ))}
          </div>
        </div>
      )}
      {d.suggestedChecks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Suggested checks</p>
          <ul className="ml-4 list-disc text-sm">
            {d.suggestedChecks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PatchView({ p }: { p: FixAgentPatchProposal }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">dry-run (never applied)</Badge>
        {p.raw ? <Badge variant="outline">unstructured</Badge> : null}
      </div>
      <p className="whitespace-pre-wrap text-sm">{p.summary}</p>
      {p.rationale && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{p.rationale}</p>}
      {p.proposedChanges.map((c, i) => (
        <div key={i} className="rounded-md border p-3">
          <p className="text-sm font-semibold">{c.file}</p>
          {c.description && <p className="text-sm text-muted-foreground">{c.description}</p>}
          {c.diff && (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
              <code>{c.diff}</code>
            </pre>
          )}
        </div>
      ))}
      {p.risks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Risks</p>
          <ul className="ml-4 list-disc text-sm">
            {p.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {p.testSuggestions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Test suggestions</p>
          <ul className="ml-4 list-disc text-sm">
            {p.testSuggestions.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RunsTable() {
  const { data, isLoading } = useAdminFixAgentListRuns({ limit: 25 });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  const runs = data?.runs ?? [];
  if (runs.length === 0)
    return <p className="text-sm text-muted-foreground">No runs recorded yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Area</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Latency</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{r.id}</TableCell>
            <TableCell>{r.mode}</TableCell>
            <TableCell>{r.area ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs">{r.model}</TableCell>
            <TableCell>
              <Badge variant={r.status === "completed" ? "secondary" : "destructive"}>
                {r.status}
              </Badge>
            </TableCell>
            <TableCell>{r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(r.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RecentErrorsCard({
  onLoad,
}: {
  onLoad: (e: FixAgentRecentError) => void;
}) {
  const { data, isLoading, refetch, isFetching } = useAdminFixAgentRecentErrors({
    limit: 25,
  });
  const errors = data?.errors ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Recent server errors
            </CardTitle>
            <CardDescription>
              Failing API requests (HTTP ≥ 400) captured in-process — newest first. Live
              in-memory signal; not a full deployment log. Click “Load” to drop one into the
              diagnose form.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : errors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent failing requests captured.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Badge variant={e.status >= 500 ? "destructive" : "secondary"}>
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {e.action ?? "—"}
                  </TableCell>
                  <TableCell>{e.totalMs}ms</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.recordedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => onLoad(e)}>
                      Load
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminAiFixAgentPage() {
  const queryClient = useQueryClient();
  const [area, setArea] = useState<string>(FixAgentRequestArea.other);
  const [model, setModel] = useState<string>(FixAgentRequestModel["claude-sonnet-4-6"]);
  const [errorText, setErrorText] = useState("");
  const [contextText, setContextText] = useState("");
  const [logsText, setLogsText] = useState("");

  const diagnose = useAdminFixAgentDiagnose();
  const propose = useAdminFixAgentProposePatch();

  const busy = diagnose.isPending || propose.isPending;
  const canSubmit = errorText.trim().length > 0 && !busy;

  const request = useMemo<FixAgentRequest>(
    () => ({
      area: area as FixAgentRequest["area"],
      model: model as FixAgentRequest["model"],
      errorText,
      contextText: contextText || undefined,
      logsText: logsText || undefined,
    }),
    [area, model, errorText, contextText, logsText],
  );

  const invalidateRuns = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/admin/ai/fix-agent/runs"] });
  };

  const diagnosis = diagnose.data?.result;
  const patch = propose.data?.result;
  const errorMsg =
    (diagnose.error as Error | null)?.message ?? (propose.error as Error | null)?.message ?? null;

  return (
    <AdminDiagnosticsGate pageTitle="Backend Fix Agent">
      <div className="mx-auto max-w-5xl space-y-6 p-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wrench className="h-6 w-6" /> Claude Backend Fix Agent
          </h1>
          <p className="text-sm text-muted-foreground">
            Advisory diagnosis and dry-run patch proposals for backend errors. Nothing here is
            ever applied, and it never touches trading, the bridge, or any risk gate.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Advisory only. Patch suggestions are <strong>dry-run</strong> — review and apply changes
            yourself. Paste-in text is redacted server-side before it reaches the model.
          </span>
        </div>

        <HealthBanner />

        <RecentErrorsCard
          onLoad={(e) => {
            setErrorText(e.errorText);
            setArea(e.area);
            if (typeof window !== "undefined") {
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
          }}
        />

        <Card>
          <CardHeader>
            <CardTitle>Describe the problem</CardTitle>
            <CardDescription>
              Paste the error/stack. Context and logs are optional. Secrets are stripped before the
              call.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Backend area</Label>
                <Select value={area} onValueChange={setArea}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AREA_OPTIONS.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Model</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_OPTIONS.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Error / stack trace *</Label>
              <Textarea
                rows={6}
                value={errorText}
                onChange={(e) => setErrorText(e.target.value)}
                placeholder="Paste the error message or stack trace…"
              />
            </div>
            <div className="space-y-1">
              <Label>Context (optional)</Label>
              <Textarea
                rows={3}
                value={contextText}
                onChange={(e) => setContextText(e.target.value)}
                placeholder="What were you doing, recent changes, affected route…"
              />
            </div>
            <div className="space-y-1">
              <Label>Logs (optional)</Label>
              <Textarea
                rows={4}
                value={logsText}
                onChange={(e) => setLogsText(e.target.value)}
                placeholder="Relevant log excerpt…"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!canSubmit}
                onClick={() =>
                  diagnose.mutate({ data: request }, { onSuccess: invalidateRuns })
                }
              >
                <Stethoscope className="mr-2 h-4 w-4" />
                {diagnose.isPending ? "Diagnosing…" : "Diagnose"}
              </Button>
              <Button
                variant="secondary"
                disabled={!canSubmit}
                onClick={() =>
                  propose.mutate({ data: request }, { onSuccess: invalidateRuns })
                }
              >
                <Wrench className="mr-2 h-4 w-4" />
                {propose.isPending ? "Proposing…" : "Propose dry-run patch"}
              </Button>
            </div>

            {errorMsg && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span>{errorMsg}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {diagnosis && (
          <Card>
            <CardHeader>
              <CardTitle>Diagnosis</CardTitle>
            </CardHeader>
            <CardContent>
              <DiagnosisView d={diagnosis} />
            </CardContent>
          </Card>
        )}

        {patch && (
          <Card>
            <CardHeader>
              <CardTitle>Dry-run patch proposal</CardTitle>
            </CardHeader>
            <CardContent>
              <PatchView p={patch} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Recent runs
            </CardTitle>
            <CardDescription>Append-only ledger of diagnoses and patch proposals.</CardDescription>
          </CardHeader>
          <CardContent>
            <RunsTable />
          </CardContent>
        </Card>
      </div>
    </AdminDiagnosticsGate>
  );
}
