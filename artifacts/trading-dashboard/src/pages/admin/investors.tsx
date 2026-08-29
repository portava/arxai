import { useMemo, useRef, useState } from "react";
import {
  Users,
  ArrowLeft,
  Plus,
  Wallet,
  ScrollText,
  Settings2,
  CheckCircle2,
  XCircle,
  PauseCircle,
  PlayCircle,
  FileText,
  ExternalLink,
  Pencil,
  Trash2,
  History,
  RotateCcw,
  MoreVertical,
  Upload,
  TrendingUp,
  CalendarDays,
  Send,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  useListAdminInvestors,
  useGetAdminInvestor,
  useCreateAdminInvestor,
  useCreateAdminInvestorLedgerEntry,
  useBulkPostAdminInvestorPerformance,
  useListAdminInvestorPerformanceBatches,
  useReverseAdminInvestorPerformanceBatch,
  useApproveAdminInvestorAllocation,
  useRejectAdminInvestorAllocation,
  usePauseAdminInvestorAllocation,
  useCreateAdminInvestorStatement,
  useCreateAdminInvestorStatementUploadUrl,
  useUpdateAdminInvestorStatement,
  useChangeAdminInvestorStatementStatus,
  useGetAdminInvestorStrategyConfig,
  useUpdateAdminInvestorStrategyConfig,
  useGetAdminWeeklyReports,
  useGenerateAdminWeeklyReport,
  usePublishAdminWeeklyReport,
} from "@workspace/api-client-react";

function fmtMoney(n: number | null | undefined, ccy = "USD"): string {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(n);
  } catch {
    return `${n.toFixed(2)} ${ccy}`;
  }
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function errMsg(e: unknown, fallback: string): string {
  return (e as { data?: { message?: string } })?.data?.message ?? fallback;
}

// ── Create / link investor ──────────────────────────────────────────────────
function CreateInvestorCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const create = useCreateAdminInvestor();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({ data: { email, displayName: displayName || undefined, reason: reason || undefined } });
      setEmail("");
      setDisplayName("");
      setReason("");
      qc.invalidateQueries();
      onDone();
    } catch (e) {
      setError(errMsg(e, "Could not create investor."));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Plus className="h-4 w-4" /> Create / link investor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Link an existing account (by email) to the view-only investor role.
        </p>
        <Input placeholder="investor@email.com" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-email" />
        <Input placeholder="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="input-display-name" />
        <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-create-reason" />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button onClick={submit} disabled={!email || create.isPending} data-testid="button-create-investor">
          {create.isPending ? "Linking…" : "Link investor"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Strategy config card ────────────────────────────────────────────────────
type ProfileDraft = {
  profileKey: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  label: string;
  description: string | null;
  conservativePct: number;
  balancedPct: number;
  aggressivePct: number;
};

function StrategyConfigCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetAdminInvestorStrategyConfig();
  const update = useUpdateAdminInvestorStrategyConfig();
  const [maxAgg, setMaxAgg] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<ProfileDraft[] | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const effMax = maxAgg ?? data?.maxAggressivePct ?? 50;
  const effDrafts: ProfileDraft[] = drafts ?? (data?.profiles as ProfileDraft[] | undefined) ?? [];

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;

  function setField(key: string, field: keyof ProfileDraft, value: string | number) {
    setSaved(false);
    setDrafts(
      effDrafts.map((p) => (p.profileKey === key ? { ...p, [field]: value } : p)),
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        data: {
          maxAggressivePct: effMax,
          reason: reason || undefined,
          profiles: effDrafts.map((p) => ({
            profileKey: p.profileKey,
            label: p.label,
            description: p.description ?? undefined,
            conservativePct: Number(p.conservativePct),
            balancedPct: Number(p.balancedPct),
            aggressivePct: Number(p.aggressivePct),
          })),
        },
      });
      setSaved(true);
      setDrafts(null);
      setMaxAgg(null);
      setReason("");
      qc.invalidateQueries();
    } catch (e) {
      setError(errMsg(e, "Could not save strategy config."));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Settings2 className="h-4 w-4" /> Strategy profiles & cap
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">
            Max aggressive % cap
          </label>
          <Input
            type="number"
            min={0}
            max={100}
            value={effMax}
            onChange={(e) => { setMaxAgg(Math.max(0, Math.min(100, Number(e.target.value) || 0))); setSaved(false); }}
            data-testid="input-max-aggressive"
            className="w-32"
          />
        </div>

        {effDrafts.map((p) => {
          const sum = Number(p.conservativePct) + Number(p.balancedPct) + Number(p.aggressivePct);
          return (
            <div key={p.profileKey} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.profileKey}</span>
                <span className={sum === 100 ? "text-xs text-muted-foreground" : "text-xs text-danger"}>
                  Sum {sum}%
                </span>
              </div>
              <Input
                value={p.label}
                onChange={(e) => setField(p.profileKey, "label", e.target.value)}
                placeholder="Label"
                data-testid={`input-label-${p.profileKey}`}
              />
              <div className="grid grid-cols-3 gap-2">
                {(["conservativePct", "balancedPct", "aggressivePct"] as const).map((f) => (
                  <div key={f} className="space-y-1">
                    <label className="text-[11px] capitalize text-muted-foreground">{f.replace("Pct", "")}</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={p[f]}
                      onChange={(e) => setField(p.profileKey, f, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                      data-testid={`input-${p.profileKey}-${f}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-strategy-reason" />
        {error && <p className="text-sm text-danger">{error}</p>}
        {saved && <p className="text-sm text-success">Saved.</p>}
        <Button onClick={save} disabled={update.isPending} data-testid="button-save-strategy">
          {update.isPending ? "Saving…" : "Save strategy config"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Statement file field (upload to object storage OR paste an external link) ─
// The text input keeps the link-only fallback path working; the Upload button
// uploads a real PDF/CSV to object storage and sets fileUrl to the "/objects/…"
// path, which the investor/admin download routes then serve scoped + expiring.
function StatementFileField({
  userId,
  value,
  onChange,
  testIdPrefix,
}: {
  userId: number;
  value: string;
  onChange: (next: string) => void;
  testIdPrefix: string;
}) {
  const uploadUrl = useCreateAdminInvestorStatementUploadUrl();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const isUploaded = value.startsWith("/objects/");

  // Mirror the server-side limits so we can reject before spending an upload.
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

  // Resolve a reliable PDF/CSV content type. Browsers often leave file.type
  // empty for CSV (or report a vendor variant), so fall back to the extension.
  function resolveContentType(file: File): string | null {
    const name = file.name.toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) return "application/pdf";
    if (
      name.endsWith(".csv") ||
      file.type === "text/csv" ||
      file.type === "application/csv" ||
      file.type === "application/vnd.ms-excel"
    ) {
      return "text/csv";
    }
    return null;
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadErr(null);

    const contentType = resolveContentType(file);
    if (!contentType) {
      setUploadErr("Only PDF or CSV files are allowed.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadErr("File is too large. The maximum is 25 MB.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    setUploading(true);
    try {
      const { uploadURL, objectPath } = await uploadUrl.mutateAsync({ id: userId });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}).`);
      onChange(objectPath);
    } catch (err) {
      setUploadErr(errMsg(err, "Could not upload file."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder="File or link URL (optional)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`${testIdPrefix}-fileurl`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.csv,application/pdf,text/csv"
          className="hidden"
          onChange={onPick}
          data-testid={`${testIdPrefix}-file-input`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          data-testid={`${testIdPrefix}-upload-button`}
        >
          <Upload className="mr-1 h-4 w-4" />
          {uploading ? "Uploading…" : "Upload PDF/CSV"}
        </Button>
        {isUploaded && (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3 w-3" /> File attached
          </span>
        )}
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            data-testid={`${testIdPrefix}-clear`}
          >
            Clear
          </Button>
        )}
      </div>
      {uploadErr && <p className="text-xs text-danger">{uploadErr}</p>}
      <p className="text-[11px] text-muted-foreground">
        Upload a PDF or CSV (max 25 MB) to attach the real file, or paste an external link above.
      </p>
    </div>
  );
}

// ── Published statement row (with edit / remove) ────────────────────────────
type StatementType = "STATEMENT" | "AGREEMENT" | "TAX" | "OTHER";

type StatementStatusAction = "CORRECT" | "REPLACE" | "REMOVE" | "RESTORE" | "SUPERSEDE";

const STATEMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  CORRECTED: "Corrected",
  REPLACED: "Replaced",
  REMOVED: "Removed",
  SUPERSEDED: "Superseded",
  DRAFT: "Draft",
  PENDING_REVIEW: "Pending Review",
};

function statementStatusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "ACTIVE": return "default";
    case "CORRECTED": return "secondary";
    case "REMOVED": return "destructive";
    case "REPLACED":
    case "SUPERSEDED": return "outline";
    default: return "secondary";
  }
}

const STATEMENT_ACTION_META: Record<
  StatementStatusAction,
  { label: string; title: string; description: string; needsReplacement: boolean }
> = {
  CORRECT: {
    label: "Mark corrected",
    title: "Mark statement as corrected",
    description:
      "Marks this statement as corrected. The investor will see a clear note explaining the correction.",
    needsReplacement: false,
  },
  REPLACE: {
    label: "Replace",
    title: "Replace statement",
    description:
      "Marks this statement as replaced by another statement. The investor will see a note pointing to the current statement.",
    needsReplacement: true,
  },
  REMOVE: {
    label: "Remove",
    title: "Remove statement",
    description:
      "Removes this statement from the investor's Documents. The record is retained and download is disabled. This can be restored later.",
    needsReplacement: false,
  },
  RESTORE: {
    label: "Restore",
    title: "Restore statement",
    description:
      "Restores this statement to Active and makes it available to the investor again.",
    needsReplacement: false,
  },
  SUPERSEDE: {
    label: "Supersede",
    title: "Supersede statement",
    description:
      "Marks this statement as no longer current. Optionally point to the newer statement that supersedes it.",
    needsReplacement: false,
  },
};

function StatementRow({
  userId,
  statement,
  siblings,
  events,
  onChanged,
}: {
  userId: number;
  statement: {
    id: number;
    title: string;
    periodLabel?: string | null;
    statementType: string;
    summary?: string | null;
    fileUrl?: string | null;
    status: string;
    statusReason?: string | null;
    statusChangedAt?: string | null;
    replacementStatementId?: number | null;
    createdAt: string;
  };
  siblings: { id: number; title: string; status: string }[];
  events: {
    id: number;
    statementId: number;
    action: string;
    previousStatus?: string | null;
    newStatus: string;
    reason: string;
    createdAt: string;
  }[];
  onChanged: () => void;
}) {
  const update = useUpdateAdminInvestorStatement();
  const changeStatus = useChangeAdminInvestorStatementStatus();

  const [editOpen, setEditOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<StatementStatusAction | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [replacementId, setReplacementId] = useState<string>("");

  const isRemoved = statement.status === "REMOVED";
  const rowEvents = events.filter((e) => e.statementId === statement.id);
  const replacementOptions = siblings.filter(
    (s) => s.id !== statement.id && s.status !== "REMOVED",
  );

  function openStatus(action: StatementStatusAction) {
    setStatusAction(action);
    setStatusReason("");
    setReplacementId("");
    setError(null);
  }

  async function confirmStatus() {
    if (!statusAction) return;
    setError(null);
    const meta = STATEMENT_ACTION_META[statusAction];
    if (statusReason.trim().length < 3) {
      setError("A reason of at least 3 characters is required.");
      return;
    }
    if (meta.needsReplacement && !replacementId) {
      setError("Select the statement that replaces this one.");
      return;
    }
    try {
      await changeStatus.mutateAsync({
        id: userId,
        statementId: statement.id,
        data: {
          action: statusAction,
          reason: statusReason.trim(),
          ...(replacementId ? { replacementStatementId: Number(replacementId) } : {}),
        },
      });
      setStatusAction(null);
      onChanged();
    } catch (e) {
      setError(errMsg(e, "Could not update statement status."));
    }
  }

  const [type, setType] = useState<StatementType>(
    (["STATEMENT", "AGREEMENT", "TAX", "OTHER"].includes(statement.statementType)
      ? statement.statementType
      : "STATEMENT") as StatementType,
  );
  const [title, setTitle] = useState(statement.title);
  const [period, setPeriod] = useState(statement.periodLabel ?? "");
  const [summary, setSummary] = useState(statement.summary ?? "");
  const [fileUrl, setFileUrl] = useState(statement.fileUrl ?? "");
  const [editReason, setEditReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function openEdit() {
    setType(
      (["STATEMENT", "AGREEMENT", "TAX", "OTHER"].includes(statement.statementType)
        ? statement.statementType
        : "STATEMENT") as StatementType,
    );
    setTitle(statement.title);
    setPeriod(statement.periodLabel ?? "");
    setSummary(statement.summary ?? "");
    setFileUrl(statement.fileUrl ?? "");
    setEditReason("");
    setError(null);
    setEditOpen(true);
  }

  async function saveEdit() {
    setError(null);
    if (title.trim().length < 1) {
      setError("A title is required.");
      return;
    }
    try {
      await update.mutateAsync({
        id: userId,
        statementId: statement.id,
        data: {
          statementType: type,
          title: title.trim(),
          periodLabel: period.trim() || null,
          summary: summary.trim() || null,
          fileUrl: fileUrl.trim() || null,
          reason: editReason.trim() || undefined,
        },
      });
      setEditOpen(false);
      onChanged();
    } catch (e) {
      setError(errMsg(e, "Could not update statement."));
    }
  }

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
      data-testid={`statement-row-${statement.id}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium">{statement.title}</p>
          <Badge
            variant={statementStatusBadgeVariant(statement.status)}
            data-testid={`statement-status-${statement.id}`}
          >
            {STATEMENT_STATUS_LABEL[statement.status] ?? statement.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {statement.statementType}
          {statement.periodLabel ? ` · ${statement.periodLabel}` : ""}
        </p>
        {statement.summary && (
          <p className="truncate text-xs text-muted-foreground">{statement.summary}</p>
        )}
        {statement.status !== "ACTIVE" && statement.statusReason && (
          <p className="text-xs text-warning" data-testid={`statement-status-reason-${statement.id}`}>
            {STATEMENT_STATUS_LABEL[statement.status] ?? statement.status}
            {statement.statusChangedAt ? ` · ${fmtDate(statement.statusChangedAt)}` : ""} — {statement.statusReason}
          </p>
        )}
        {statement.fileUrl && (
          <a
            href={
              statement.fileUrl.startsWith("/objects/")
                ? `/api/admin/investors/${userId}/statements/${statement.id}/file`
                : statement.fileUrl
            }
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> View file
          </a>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{fmtDate(statement.createdAt)}</span>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => { setHistoryOpen(true); }}
          data-testid={`button-history-statement-${statement.id}`}
          title="View change history"
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={openEdit}
          data-testid={`button-edit-statement-${statement.id}`}
          title="Edit statement"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              data-testid={`button-status-menu-${statement.id}`}
              title="Change status"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isRemoved ? (
              <DropdownMenuItem
                onClick={() => openStatus("RESTORE")}
                data-testid={`menu-restore-statement-${statement.id}`}
              >
                <RotateCcw className="mr-2 h-4 w-4" /> Restore
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => openStatus("CORRECT")}
                  data-testid={`menu-correct-statement-${statement.id}`}
                >
                  Mark corrected
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openStatus("REPLACE")}
                  data-testid={`menu-replace-statement-${statement.id}`}
                >
                  Replace…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openStatus("SUPERSEDE")}
                  data-testid={`menu-supersede-statement-${statement.id}`}
                >
                  Supersede…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger focus:text-danger"
                  onClick={() => openStatus("REMOVE")}
                  data-testid={`menu-remove-statement-${statement.id}`}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit statement</DialogTitle>
            <DialogDescription>
              Changes appear immediately in the investor's view-only Documents tab.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select value={type} onValueChange={(v) => setType(v as StatementType)}>
                <SelectTrigger data-testid={`edit-statement-type-${statement.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STATEMENT">Statement</SelectItem>
                  <SelectItem value="AGREEMENT">Agreement</SelectItem>
                  <SelectItem value="TAX">Tax</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Period label (e.g. May 2026)"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                data-testid={`edit-statement-period-${statement.id}`}
              />
            </div>
            <Input
              placeholder="Title (required)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid={`edit-statement-title-${statement.id}`}
            />
            <Textarea
              placeholder="Summary (optional)"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              data-testid={`edit-statement-summary-${statement.id}`}
            />
            <StatementFileField
              userId={userId}
              value={fileUrl}
              onChange={setFileUrl}
              testIdPrefix={`edit-statement-${statement.id}`}
            />
            <Input
              placeholder="Reason for change (optional, recorded in audit log)"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              data-testid={`edit-statement-reason-${statement.id}`}
            />
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveEdit}
              disabled={!title.trim() || update.isPending}
              data-testid={`button-save-statement-${statement.id}`}
            >
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status change dialog (correct / replace / remove / restore / supersede) */}
      <Dialog
        open={statusAction !== null}
        onOpenChange={(o) => { if (!o) setStatusAction(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statusAction ? STATEMENT_ACTION_META[statusAction].title : ""}</DialogTitle>
            <DialogDescription>
              {statusAction ? STATEMENT_ACTION_META[statusAction].description : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {statusAction && STATEMENT_ACTION_META[statusAction].needsReplacement && (
              <Select value={replacementId} onValueChange={setReplacementId}>
                <SelectTrigger data-testid={`status-replacement-${statement.id}`}>
                  <SelectValue placeholder="Select the replacement statement" />
                </SelectTrigger>
                <SelectContent>
                  {replacementOptions.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No other statements available
                    </SelectItem>
                  ) : (
                    replacementOptions.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.title}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
            {statusAction === "SUPERSEDE" && (
              <Select value={replacementId} onValueChange={setReplacementId}>
                <SelectTrigger data-testid={`status-replacement-${statement.id}`}>
                  <SelectValue placeholder="Newer statement (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {replacementOptions.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Textarea
              placeholder="Reason (required, at least 3 characters — shown to the investor)"
              value={statusReason}
              onChange={(e) => setStatusReason(e.target.value)}
              data-testid={`status-reason-${statement.id}`}
            />
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusAction(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmStatus}
              disabled={statusReason.trim().length < 3 || changeStatus.isPending}
              data-testid={`button-confirm-status-${statement.id}`}
            >
              {changeStatus.isPending ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change history */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Statement change history</DialogTitle>
            <DialogDescription>
              Every status change to "{statement.title}", with the reason recorded at the time.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto" data-testid={`statement-history-${statement.id}`}>
            {rowEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
            ) : (
              rowEvents.map((ev) => (
                <div key={ev.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {STATEMENT_STATUS_LABEL[ev.newStatus] ?? ev.newStatus}
                      {ev.previousStatus
                        ? ` (from ${STATEMENT_STATUS_LABEL[ev.previousStatus] ?? ev.previousStatus})`
                        : ""}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(ev.createdAt)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{ev.reason}</p>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Weekly account stories (admin) ──────────────────────────────────────────
function weeklyStatusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "PUBLISHED") return "default";
  if (status === "DRAFT") return "secondary";
  return "outline";
}

function WeeklyReportsAdminCard({ userId }: { userId: number }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useGetAdminWeeklyReports(userId);
  const generate = useGenerateAdminWeeklyReport();
  const publish = usePublishAdminWeeklyReport();

  const [periodKey, setPeriodKey] = useState("");
  const [genReason, setGenReason] = useState("");
  const [pubReason, setPubReason] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  function invalidate() {
    qc.invalidateQueries();
    refetch();
  }

  async function doGenerate() {
    setError(null);
    if (!/^\d{4}-W\d{2}$/.test(periodKey.trim())) {
      setError("Enter an ISO week key like 2026-W23.");
      return;
    }
    if (genReason.trim().length < 3) {
      setError("A reason (3+ characters) is required.");
      return;
    }
    try {
      await generate.mutateAsync({
        userId,
        data: { periodKey: periodKey.trim(), reason: genReason.trim() },
      });
      setPeriodKey("");
      setGenReason("");
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not generate report."));
    }
  }

  async function doPublish(id: number) {
    setError(null);
    const reason = pubReason[id] ?? "";
    if (reason.trim().length < 3) {
      setError("A reason (3+ characters) is required to publish.");
      return;
    }
    try {
      await publish.mutateAsync({ id, data: { reason: reason.trim() } });
      setPubReason((p) => ({ ...p, [id]: "" }));
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not publish report."));
    }
  }

  const reports = data?.reports ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarDays className="h-4 w-4" /> Weekly account stories
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Generate a point-in-time DRAFT from this investor's own recorded Fund Book data, then
          publish it. Published reports are read-only snapshots and never recomputed. Each generate
          mints a new version; each action is reason-logged.
        </p>

        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="text-xs">ISO week</Label>
            <Input
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value)}
              placeholder="2026-W23"
              data-testid="input-weekly-period"
            />
          </div>
          <div className="flex-[2]">
            <Label className="text-xs">Reason</Label>
            <Input
              value={genReason}
              onChange={(e) => setGenReason(e.target.value)}
              placeholder="Reason for generating"
              data-testid="input-weekly-gen-reason"
            />
          </div>
          <Button onClick={doGenerate} disabled={generate.isPending} data-testid="button-weekly-generate">
            <Plus className="mr-1 h-4 w-4" /> Generate draft
          </Button>
        </div>

        {error && <p className="text-xs text-danger" data-testid="weekly-admin-error">{error}</p>}

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No weekly reports generated yet.</p>
        ) : (
          <div className="space-y-2" data-testid="weekly-admin-list">
            {reports.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`weekly-admin-row-${r.id}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.periodKey}</span>
                    <span className="text-xs text-muted-foreground">v{r.version}</span>
                    <Badge variant={weeklyStatusVariant(r.status)}>{r.status}</Badge>
                    <Badge variant="outline">{r.freshness}</Badge>
                    {r.navStatus === "UNDER_REVIEW" && (
                      <Badge variant="outline">Under review</Badge>
                    )}
                    {!r.baselineAvailable && <Badge variant="outline">Baseline week</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{r.headline}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {r.publishedAt ? `Published ${fmtDate(r.publishedAt)}` : `Created ${fmtDate(r.createdAt)}`}
                  </p>
                </div>
                {r.status === "DRAFT" && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Input
                      value={pubReason[r.id] ?? ""}
                      onChange={(e) => setPubReason((p) => ({ ...p, [r.id]: e.target.value }))}
                      placeholder="Publish reason"
                      className="w-44"
                      data-testid={`input-weekly-pub-reason-${r.id}`}
                    />
                    <Button
                      size="sm"
                      onClick={() => doPublish(r.id)}
                      disabled={publish.isPending}
                      data-testid={`button-weekly-publish-${r.id}`}
                    >
                      <Send className="mr-1 h-4 w-4" /> Publish
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Investor detail ─────────────────────────────────────────────────────────
function InvestorDetail({ userId, onBack }: { userId: number; onBack: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useGetAdminInvestor(userId);
  const ledger = useCreateAdminInvestorLedgerEntry();
  const approve = useApproveAdminInvestorAllocation();
  const reject = useRejectAdminInvestorAllocation();
  const pause = usePauseAdminInvestorAllocation();
  const publishStatement = useCreateAdminInvestorStatement();

  const [entryType, setEntryType] = useState<
    "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT" | "PERFORMANCE"
  >("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [ledgerReason, setLedgerReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [rejectNotes, setRejectNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [stmtType, setStmtType] = useState<"STATEMENT" | "AGREEMENT" | "TAX" | "OTHER">("STATEMENT");
  const [stmtTitle, setStmtTitle] = useState("");
  const [stmtPeriod, setStmtPeriod] = useState("");
  const [stmtSummary, setStmtSummary] = useState("");
  const [stmtFileUrl, setStmtFileUrl] = useState("");
  const [stmtError, setStmtError] = useState<string | null>(null);
  const [stmtSaved, setStmtSaved] = useState(false);

  function invalidate() {
    qc.invalidateQueries();
    refetch();
  }

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return null;
  const ccy = data.baseCurrency;
  const paused = data.status === "paused";

  async function addLedger() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || (entryType !== "ADJUSTMENT" && amt === 0)) {
      setError("Enter a valid amount.");
      return;
    }
    if (ledgerReason.trim().length < 3) {
      setError("A reason (3+ characters) is required.");
      return;
    }
    try {
      await ledger.mutateAsync({ id: userId, data: { entryType, amount: amt, reason: ledgerReason } });
      setAmount("");
      setLedgerReason("");
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not record ledger entry."));
    }
  }

  async function doApprove(prefId: number) {
    setError(null);
    try {
      await approve.mutateAsync({ id: userId, prefId, data: {} });
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not approve."));
    }
  }
  async function doReject(prefId: number) {
    setError(null);
    const note = rejectNotes[prefId] ?? "";
    if (note.trim().length < 3) {
      setError("A rejection note (3+ characters) is required.");
      return;
    }
    try {
      await reject.mutateAsync({ id: userId, prefId, data: { note } });
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not reject."));
    }
  }
  async function doPause(next: boolean) {
    setError(null);
    if (pauseReason.trim().length < 3) {
      setError("A reason (3+ characters) is required to pause/resume.");
      return;
    }
    try {
      await pause.mutateAsync({ id: userId, data: { paused: next, reason: pauseReason } });
      setPauseReason("");
      invalidate();
    } catch (e) {
      setError(errMsg(e, "Could not update."));
    }
  }

  async function doPublishStatement() {
    setStmtError(null);
    setStmtSaved(false);
    if (stmtTitle.trim().length < 1) {
      setStmtError("A title is required.");
      return;
    }
    try {
      await publishStatement.mutateAsync({
        id: userId,
        data: {
          statementType: stmtType,
          title: stmtTitle.trim(),
          periodLabel: stmtPeriod.trim() || undefined,
          summary: stmtSummary.trim() || undefined,
          fileUrl: stmtFileUrl.trim() || undefined,
        },
      });
      setStmtTitle("");
      setStmtPeriod("");
      setStmtSummary("");
      setStmtFileUrl("");
      setStmtType("STATEMENT");
      setStmtSaved(true);
      invalidate();
    } catch (e) {
      setStmtError(errMsg(e, "Could not publish statement."));
    }
  }

  return (
    <div className="space-y-4" data-testid="admin-investor-detail">
      <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back">
        <ArrowLeft className="mr-1 h-4 w-4" /> Back to investors
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-black">{data.displayName ?? data.email ?? `Investor #${data.userId}`}</h2>
          <p className="text-sm text-muted-foreground">{data.email}</p>
        </div>
        <Badge className={paused ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}>
          {paused ? "Paused" : "Active"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Current Value" value={fmtMoney(data.currentValue, ccy)} />
        <Stat label="Deposited" value={fmtMoney(data.depositedTotal, ccy)} />
        <Stat label="Withdrawn" value={fmtMoney(data.withdrawnTotal, ccy)} />
        <Stat label="Risk Profile" value={data.currentRiskProfile ?? "Not set"} />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Ledger entry */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="h-4 w-4" /> Record ledger entry
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={entryType} onValueChange={(v) => setEntryType(v as typeof entryType)}>
              <SelectTrigger data-testid="select-entry-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DEPOSIT">Deposit</SelectItem>
                <SelectItem value="WITHDRAWAL">Withdrawal</SelectItem>
                <SelectItem value="ADJUSTMENT">Adjustment</SelectItem>
                <SelectItem value="PERFORMANCE">Performance (gain/loss)</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              placeholder={
                entryType === "ADJUSTMENT" || entryType === "PERFORMANCE"
                  ? "Amount (+/-)"
                  : "Amount"
              }
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="input-amount"
            />
            <Textarea placeholder="Reason (required)" value={ledgerReason} onChange={(e) => setLedgerReason(e.target.value)} data-testid="input-ledger-reason" />
            <Button onClick={addLedger} disabled={ledger.isPending} data-testid="button-add-ledger">
              {ledger.isPending ? "Recording…" : "Record entry"}
            </Button>
          </CardContent>
        </Card>

        {/* Pause / resume */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {paused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
              {paused ? "Resume allocation" : "Pause allocation"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {paused
                ? "Resuming lets the investor submit allocation requests again."
                : "Pausing blocks the investor from submitting allocation requests."}
            </p>
            <Textarea placeholder="Reason (required)" value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} data-testid="input-pause-reason" />
            <Button
              variant={paused ? "default" : "destructive"}
              onClick={() => doPause(!paused)}
              disabled={pause.isPending}
              data-testid="button-toggle-pause"
            >
              {pause.isPending ? "Updating…" : paused ? "Resume" : "Pause"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Allocation requests */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Allocation requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.allocations.length === 0 && (
            <p className="text-sm text-muted-foreground">No allocation requests yet.</p>
          )}
          {data.allocations.map((a) => (
            <div key={a.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-semibold">{a.profileKey}</span>{" "}
                  <span className="text-sm text-muted-foreground">
                    {a.conservativePct}/{a.balancedPct}/{a.aggressivePct}
                  </span>
                </div>
                <Badge className="capitalize">{a.status.replace(/_/g, " ").toLowerCase()}</Badge>
              </div>
              {a.reviewNote && <p className="text-xs text-muted-foreground">Note: {a.reviewNote}</p>}
              <p className="text-[11px] text-muted-foreground">Submitted {fmtDate(a.submittedAt)}</p>
              {a.status === "PENDING_APPROVAL" && (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Rejection note (required to reject)"
                    value={rejectNotes[a.id] ?? ""}
                    onChange={(e) => setRejectNotes((m) => ({ ...m, [a.id]: e.target.value }))}
                    data-testid={`input-reject-note-${a.id}`}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => doApprove(a.id)} disabled={approve.isPending} data-testid={`button-approve-${a.id}`}>
                      <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => doReject(a.id)} disabled={reject.isPending} data-testid={`button-reject-${a.id}`}>
                      <XCircle className="mr-1 h-4 w-4" /> Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Publish statement */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4" /> Publish statement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Share a statement or document with this investor. It appears in their
            view-only Documents tab.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select value={stmtType} onValueChange={(v) => setStmtType(v as typeof stmtType)}>
              <SelectTrigger data-testid="select-statement-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="STATEMENT">Statement</SelectItem>
                <SelectItem value="AGREEMENT">Agreement</SelectItem>
                <SelectItem value="TAX">Tax</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Period label (e.g. May 2026)"
              value={stmtPeriod}
              onChange={(e) => { setStmtPeriod(e.target.value); setStmtSaved(false); }}
              data-testid="input-statement-period"
            />
          </div>
          <Input
            placeholder="Title (required)"
            value={stmtTitle}
            onChange={(e) => { setStmtTitle(e.target.value); setStmtSaved(false); }}
            data-testid="input-statement-title"
          />
          <Textarea
            placeholder="Summary (optional)"
            value={stmtSummary}
            onChange={(e) => { setStmtSummary(e.target.value); setStmtSaved(false); }}
            data-testid="input-statement-summary"
          />
          <StatementFileField
            userId={userId}
            value={stmtFileUrl}
            onChange={(next) => { setStmtFileUrl(next); setStmtSaved(false); }}
            testIdPrefix="input-statement"
          />
          {stmtError && <p className="text-sm text-danger">{stmtError}</p>}
          {stmtSaved && <p className="text-sm text-success">Statement published.</p>}
          <Button onClick={doPublishStatement} disabled={!stmtTitle.trim() || publishStatement.isPending} data-testid="button-publish-statement">
            {publishStatement.isPending ? "Publishing…" : "Publish statement"}
          </Button>
        </CardContent>
      </Card>

      {/* Published statements */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Published statements</CardTitle>
        </CardHeader>
        <CardContent>
          {data.statements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No statements published yet.</p>
          ) : (
            <div className="space-y-2" data-testid="admin-investor-statements">
              {data.statements.map((s) => (
                <StatementRow
                  key={s.id}
                  userId={userId}
                  statement={s}
                  siblings={data.statements.map((x) => ({ id: x.id, title: x.title, status: x.status }))}
                  events={data.statementEvents ?? []}
                  onChanged={invalidate}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ledger history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Ledger history</CardTitle>
        </CardHeader>
        <CardContent>
          {data.ledger.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ledger entries.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.ledger.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.entryType}</TableCell>
                    <TableCell className={e.signedAmount < 0 ? "text-danger" : "text-success"}>
                      {fmtMoney(e.signedAmount, e.currency)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{e.reason}</TableCell>
                    <TableCell>{fmtDate(e.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Weekly account stories */}
      <WeeklyReportsAdminCard userId={userId} />

      {/* Audit history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="h-4 w-4" /> Audit history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No admin actions recorded.</p>
          ) : (
            <div className="space-y-1">
              {data.audit.map((a) => (
                <div key={a.id} className="flex items-center justify-between border-b border-border/40 py-1.5 text-xs last:border-0">
                  <span className="font-medium">{a.action}</span>
                  <span className="text-muted-foreground">
                    {a.reason ? `${a.reason} · ` : ""}
                    {fmtDate(a.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-lg font-black tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

// ── Bulk PERFORMANCE posting ────────────────────────────────────────────────
type BulkInvestor = {
  userId: number;
  email: string | null;
  displayName: string | null;
  currentValue: number;
  baseCurrency: string;
};

function BulkPerformanceCard({ investors }: { investors: BulkInvestor[] }) {
  const qc = useQueryClient();
  const bulk = useBulkPostAdminInvestorPerformance();

  const [mode, setMode] = useState<"FIXED" | "PRO_RATA">("PRO_RATA");
  const [value, setValue] = useState("");
  const [periodLabel, setPeriodLabel] = useState("");
  const [reason, setReason] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{
    postedCount: number;
    skippedCount: number;
    failedCount: number;
    results: Array<{
      userId: number;
      email?: string | null;
      displayName?: string | null;
      amount: number;
      currency?: string | null;
      status: string;
    }>;
  } | null>(null);

  const numericValue = Number(value);
  const validValue = Number.isFinite(numericValue) && numericValue !== 0;

  function toggle(userId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }
  function toggleAll() {
    setSelectedIds((prev) =>
      prev.size === investors.length ? new Set() : new Set(investors.map((i) => i.userId)),
    );
  }

  // Honest client-side preview of what WILL be posted. The server recomputes
  // PRO_RATA from each investor's real current value at commit time — this is a
  // preview, not a guarantee. Mirrors the server: PRO_RATA on a non-positive
  // base produces 0 → skipped.
  const preview = useMemo(() => {
    const selected = investors.filter((i) => selectedIds.has(i.userId));
    return selected.map((inv) => {
      let amount = 0;
      if (mode === "FIXED") amount = Math.round(numericValue * 100) / 100;
      else if (inv.currentValue > 0)
        amount = Math.round(((inv.currentValue * numericValue) / 100) * 100) / 100;
      return { ...inv, amount, willSkip: Math.round(amount * 100) / 100 === 0 };
    });
  }, [investors, selectedIds, mode, numericValue]);

  const willPost = preview.filter((p) => !p.willSkip);
  const willSkip = preview.filter((p) => p.willSkip);

  function openConfirm() {
    setError(null);
    setResult(null);
    if (selectedIds.size === 0) {
      setError("Select at least one investor.");
      return;
    }
    if (!validValue) {
      setError(mode === "FIXED" ? "Enter a non-zero figure." : "Enter a non-zero percentage.");
      return;
    }
    if (periodLabel.trim().length < 1) {
      setError("A period label is required.");
      return;
    }
    if (reason.trim().length < 3) {
      setError("A reason (3+ characters) is required.");
      return;
    }
    if (willPost.length === 0) {
      setError("Nothing to post — every selected investor would receive a zero figure.");
      return;
    }
    setConfirmOpen(true);
  }

  async function commit() {
    setError(null);
    try {
      const resp = await bulk.mutateAsync({
        data: {
          periodLabel: periodLabel.trim(),
          mode,
          value: numericValue,
          reason: reason.trim(),
          userIds: [...selectedIds],
        },
      });
      setResult({
        postedCount: resp.postedCount,
        skippedCount: resp.skippedCount,
        failedCount: resp.failedCount,
        results: resp.results,
      });
      setConfirmOpen(false);
      setSelectedIds(new Set());
      setValue("");
      setReason("");
      qc.invalidateQueries();
    } catch (e) {
      setError(errMsg(e, "Could not post performance figures."));
      setConfirmOpen(false);
    }
  }

  return (
    <Card data-testid="bulk-performance-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <TrendingUp className="h-4 w-4" /> Post period performance (bulk)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Record this period's PERFORMANCE figure to many investors at once. Each
          investor gets one individually attributed, dated, audited ledger row.
          Nothing is projected or guaranteed.
        </p>

        {investors.length === 0 ? (
          <p className="text-sm text-muted-foreground">No investors to post to yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Period label</Label>
                <Input
                  placeholder="e.g. May 2026"
                  value={periodLabel}
                  onChange={(e) => setPeriodLabel(e.target.value)}
                  data-testid="input-bulk-period"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Mode</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                  <SelectTrigger data-testid="select-bulk-mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRO_RATA">Pro-rata (% of value)</SelectItem>
                    <SelectItem value="FIXED">Fixed (same figure each)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                {mode === "FIXED" ? "Figure per investor (+/-)" : "Percentage of current value (+/-)"}
              </Label>
              <Input
                type="number"
                placeholder={mode === "FIXED" ? "e.g. 500 or -120" : "e.g. 2.5 or -1.0"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                data-testid="input-bulk-value"
              />
            </div>

            <Textarea
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="input-bulk-reason"
            />

            <div className="rounded-md border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={toggleAll}
                  data-testid="button-bulk-toggle-all"
                >
                  {selectedIds.size === investors.length ? "Clear all" : "Select all"}
                </button>
                <span className="text-xs text-muted-foreground">
                  {selectedIds.size} of {investors.length} selected
                </span>
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto p-2">
                {investors.map((inv) => (
                  <label
                    key={inv.userId}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted/50"
                    data-testid={`bulk-investor-${inv.userId}`}
                  >
                    <Checkbox
                      checked={selectedIds.has(inv.userId)}
                      onCheckedChange={() => toggle(inv.userId)}
                    />
                    <span className="flex-1 truncate text-sm">
                      {inv.displayName ?? inv.email ?? `#${inv.userId}`}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {fmtMoney(inv.currentValue, inv.baseCurrency)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {result && (
              <div className="rounded-md border border-border p-3 text-xs" data-testid="bulk-result">
                <p className="font-medium">
                  Posted {result.postedCount} · Skipped {result.skippedCount} · Failed {result.failedCount}
                </p>
                {result.failedCount > 0 && (
                  <p className="mt-1 text-danger">
                    Some rows failed and were not recorded. Review the audit log and retry.
                  </p>
                )}
              </div>
            )}

            <Button onClick={openConfirm} disabled={bulk.isPending} data-testid="button-bulk-review">
              Review &amp; post…
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm bulk performance posting</DialogTitle>
            <DialogDescription>
              Review exactly what will be recorded before committing. This writes one
              dated, audited PERFORMANCE ledger row per investor.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-muted-foreground">Period:</span> {periodLabel}</div>
              <div><span className="text-muted-foreground">Mode:</span> {mode === "FIXED" ? "Fixed figure" : "Pro-rata %"}</div>
              <div className="col-span-2"><span className="text-muted-foreground">Reason:</span> {reason}</div>
            </div>

            <div className="max-h-60 overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Investor</TableHead>
                    <TableHead className="text-right">Figure</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {willPost.map((p) => (
                    <TableRow key={p.userId} data-testid={`bulk-confirm-row-${p.userId}`}>
                      <TableCell className="truncate">{p.displayName ?? p.email ?? `#${p.userId}`}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(p.amount, p.baseCurrency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-xs text-muted-foreground">
              {willPost.length} investor{willPost.length === 1 ? "" : "s"} will be posted.
              {willSkip.length > 0 && ` ${willSkip.length} will be skipped (zero figure).`}
              {mode === "PRO_RATA" &&
                " Pro-rata figures are recomputed from each investor's real current value at commit."}
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} data-testid="button-bulk-cancel">
              Cancel
            </Button>
            <Button onClick={commit} disabled={bulk.isPending} data-testid="button-bulk-confirm">
              {bulk.isPending ? "Posting…" : `Post to ${willPost.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Bulk-performance batch history + one-click reversal (Task #107) ──────────
type PerfBatch = {
  batchId: string;
  periodLabel: string;
  mode: string;
  value: number;
  currency?: string | null;
  reason: string;
  postedCount: number;
  skippedCount: number;
  failedCount: number;
  status: string;
  isReversal: boolean;
  reversesBatchId?: string | null;
  reversedByBatchId?: string | null;
  reversedAt?: string | null;
  createdAt: string;
};

function PerformanceBatchesCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useListAdminInvestorPerformanceBatches();
  const reverse = useReverseAdminInvestorPerformanceBatch();

  const batches = useMemo<PerfBatch[]>(() => data?.batches ?? [], [data]);

  const [target, setTarget] = useState<PerfBatch | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function openReverse(b: PerfBatch) {
    setError(null);
    setNote(null);
    setReason("");
    setTarget(b);
  }

  async function commitReverse() {
    if (!target) return;
    setError(null);
    if (reason.trim().length < 3) {
      setError("A reason (3+ characters) is required.");
      return;
    }
    try {
      const resp = await reverse.mutateAsync({
        batchId: target.batchId,
        data: { reason: reason.trim() },
      });
      setNote(
        `Reversed ${resp.reversedCount} row${resp.reversedCount === 1 ? "" : "s"}` +
          (resp.failedCount > 0 ? ` · ${resp.failedCount} failed` : "") +
          ".",
      );
      setTarget(null);
      qc.invalidateQueries();
    } catch (e) {
      setError(errMsg(e, "Could not reverse the batch."));
    }
  }

  function fmtFigure(b: PerfBatch): string {
    if (b.mode === "PRO_RATA") return `${b.value > 0 ? "+" : ""}${b.value}%`;
    return fmtMoney(b.value, b.currency ?? "USD");
  }

  return (
    <Card data-testid="performance-batches-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="h-4 w-4" /> Performance posting history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Every bulk performance post is recorded here. Reversing a batch writes
          one offsetting, individually-attributed, audited ledger row per
          originally-posted investor — the append-only ledger is never deleted.
        </p>

        {note && <p className="text-sm text-success" data-testid="batch-reverse-note">{note}</p>}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="batches-empty">
            No bulk performance posts yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">Figure</TableHead>
                  <TableHead className="text-right">Posted</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.batchId} data-testid={`batch-row-${b.batchId}`}>
                    <TableCell>
                      <div className="font-medium">{b.periodLabel}</div>
                      <div className="max-w-[14rem] truncate text-xs text-muted-foreground">{b.reason}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.isReversal ? "Reversal" : b.mode === "PRO_RATA" ? "Pro-rata" : "Fixed"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtFigure(b)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.postedCount}
                      {(b.skippedCount > 0 || b.failedCount > 0) && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          ({b.skippedCount} skip{b.failedCount > 0 ? `, ${b.failedCount} fail` : ""})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{fmtDate(b.createdAt)}</TableCell>
                    <TableCell>
                      {b.isReversal ? (
                        <Badge className="bg-primary/15 text-primary">Reversal</Badge>
                      ) : b.status === "REVERSED" ? (
                        <Badge className="bg-warning/15 text-warning" data-testid={`batch-status-${b.batchId}`}>
                          Reversed
                        </Badge>
                      ) : (
                        <Badge className="bg-success/15 text-success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!b.isReversal && b.status === "ACTIVE" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:text-danger"
                          onClick={() => openReverse(b)}
                          data-testid={`button-reverse-${b.batchId}`}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reverse
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={target != null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse this performance batch?</DialogTitle>
            <DialogDescription>
              This writes one offsetting PERFORMANCE ledger row (the exact
              negative) for each originally-posted investor. Nothing is deleted;
              every offsetting row is dated and audited.
            </DialogDescription>
          </DialogHeader>

          {target && (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Period:</span> {target.periodLabel}</div>
                <div><span className="text-muted-foreground">Mode:</span> {target.mode === "PRO_RATA" ? "Pro-rata %" : "Fixed figure"}</div>
                <div><span className="text-muted-foreground">Figure:</span> {fmtFigure(target)}</div>
                <div><span className="text-muted-foreground">Posted to:</span> {target.postedCount} investor{target.postedCount === 1 ? "" : "s"}</div>
              </div>
              <Textarea
                placeholder="Reason for reversal (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="input-reverse-reason"
              />
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} data-testid="button-reverse-cancel">
              Cancel
            </Button>
            <Button
              className="bg-danger/90 text-foreground hover:bg-danger"
              onClick={commitReverse}
              disabled={reverse.isPending}
              data-testid="button-reverse-confirm"
            >
              {reverse.isPending ? "Reversing…" : "Reverse batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function AdminInvestorsPage() {
  const { data, isLoading } = useListAdminInvestors();
  const [selected, setSelected] = useState<number | null>(null);

  const investors = useMemo(() => data?.investors ?? [], [data]);

  if (selected != null) {
    return (
      <div className="mx-auto mt-6 max-w-5xl">
        <InvestorDetail userId={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-32 md:pb-6" data-testid="admin-investors">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Users className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Investor Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage view-only investor accounts, ledgers, and allocation approvals.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Investors</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : investors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No investors yet. Link one on the right.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Investor</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Profile</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Pending</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {investors.map((inv) => (
                      <TableRow
                        key={inv.userId}
                        className="cursor-pointer"
                        onClick={() => setSelected(inv.userId)}
                        data-testid={`row-investor-${inv.userId}`}
                      >
                        <TableCell>
                          <div className="font-medium">{inv.displayName ?? inv.email ?? `#${inv.userId}`}</div>
                          <div className="text-xs text-muted-foreground">{inv.email}</div>
                        </TableCell>
                        <TableCell className="tabular-nums">{fmtMoney(inv.currentValue, inv.baseCurrency)}</TableCell>
                        <TableCell>{inv.currentRiskProfile ?? "—"}</TableCell>
                        <TableCell>
                          <Badge className={inv.status === "paused" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}>
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {inv.pendingRequests > 0 ? (
                            <Badge className="bg-warning/15 text-warning">{inv.pendingRequests}</Badge>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <CreateInvestorCard onDone={() => undefined} />
          <BulkPerformanceCard
            investors={investors.map((i) => ({
              userId: i.userId,
              email: i.email ?? null,
              displayName: i.displayName ?? null,
              currentValue: i.currentValue,
              baseCurrency: i.baseCurrency ?? "USD",
            }))}
          />
          <StrategyConfigCard />
        </div>
      </div>

      <PerformanceBatchesCard />
    </div>
  );
}
