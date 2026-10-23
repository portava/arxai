// Admin Bridge Allocations Page
//
// SAFETY (inviolable):
// - This page NEVER places live trades.
// - This page NEVER modifies kill switches or platform settings.
// - All actions use Confirm/Cancel modals only — no typed phrases.
// - Only ADMIN or OWNER can reach this page.

import { useEffect, useState, useCallback, useRef } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete, markApiStart, markApiEnd } from "@/lib/perf";

// ── Types ──────────────────────────────────────────────────────────────────────
type Attachment = {
  attached: boolean;
  sharedMasterAccountId: number | null;
  virtualAccountId: number | null;
  virtualBalance: number;
  virtualEquity: number;
  shellSynced: boolean;
  status: string | null;
  masterLiveStatus: string | null;
  approvedForMasterLive: boolean;
};
type UserAlloc = {
  id: number; userId: number; email: string | null;
  bridgeConnectionId: number;
  totalAllocation: number; manualAllocationBalance: number;
  aiManagedAllocationBalance: number; availableBalance: number;
  reservedRisk: number; realizedPnl: number; unrealizedPnl: number;
  openPositionsCount?: number;
  dailyLossLimitUsd?: number | null;
  aiAvailableBalance: number; aiAutoTradingEnabled: boolean;
  aiWatchOnly: boolean; aiStrategyMode: string;
  aiMaxLot: number | null; aiMaxOpenTrades: number | null; aiMaxDailyLoss: number | null;
  allocationStatus: string; tradingFrozen: boolean; aiTradingFrozen: boolean;
  closeOnlyMode: boolean; freezeReason: string | null; frozenAt: string | null;
  currency: string; updatedAt: string;
  attachment?: Attachment;
};
type EligibleUser = { userId: number; email: string | null; name: string | null; role: string; allocatedFunds: number };

// Per-user reconciliation summary of OPEN live positions. genuineOpen =
// reconcile_state IS NULL (real exposure); reconciledCount = ghost rows the
// operator already resolved (IGNORED/EXTERNAL/IMPORTED). Surfaced as a
// compact badge so accumulating ghosts are easy to spot.
type ReconcileUser = {
  userId: number;
  totalOpen: number; genuineOpen: number; reconciledCount: number;
  byState: { IGNORED: number; EXTERNAL: number; IMPORTED: number; OTHER: number };
};

// ── Sortable columns ────────────────────────────────────────────────────────────
// Maps a sortable column header to the numeric field on UserAlloc it sorts by.
// Only exposure-relevant numeric columns are sortable; User/Status/Shell/AI
// Mode/Actions are not. Sorting is client-side over already-fetched rows.
type SortKey = "totalAllocation" | "manualAllocationBalance" | "aiManagedAllocationBalance"
  | "availableBalance" | "reservedRisk" | "realizedPnl" | "openPositionsCount" | "unrealizedPnl";
const SORTABLE_COLUMNS: Record<string, SortKey> = {
  "Total": "totalAllocation",
  "Manual": "manualAllocationBalance",
  "AI": "aiManagedAllocationBalance",
  "Available": "availableBalance",
  "Reserved": "reservedRisk",
  "P/L": "realizedPnl",
  "Open": "openPositionsCount",
  "Floating P/L": "unrealizedPnl",
};

type Summary = { totalAllocated: number; totalFrozen: number; userCount: number; frozenCount: number };
type MasterInfo = {
  configured: boolean;          // pinned in arx_master_account_config
  available: boolean;           // real broker balance present (pinned OR auto-detected)
  source: "pinned" | "auto-detected" | "none";
  masterConnectionId: number | null;
  balance: number; equity: number; margin: number; freeMargin: number; marginLevelPct: number | null;
  currency: string | null;
  accountNumberMasked: string | null;
  brokerName: string | null;
  serverName: string | null;
  leverage: number | null;
  eaVersion: string | null;
  accountType: string | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatAgeMs: number | null;
  isStale: boolean;
  headroom: number | null;
  detectorBlockedReason: string | null;
};

// ── Modal ─────────────────────────────────────────────────────────────────────
type ModalProps = { title: string; onConfirm: () => void; onCancel: () => void; busy: boolean; children: React.ReactNode; danger?: boolean };
function Modal({ title, onConfirm, onCancel, busy, children, danger }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="space-y-3">{children}</div>
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 rounded-lg border border-border bg-secondary py-2 text-sm text-txt-secondary hover:bg-secondary/80 disabled:opacity-50 transition">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold text-foreground disabled:opacity-50 transition ${danger ? "bg-danger hover:bg-danger/80 border border-danger" : "bg-cyan-700 hover:bg-cyan-600 border border-cyan-600"}`}>
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-txt-secondary mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type = "text", placeholder = "" }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    className="w-full rounded bg-card border border-border px-2 py-1.5 text-sm text-foreground" />;
}

// ── Daily-loss-cap risk ─────────────────────────────────────────────────────────
// Flags a user whose OPEN floating loss is eating into their configured
// daily-loss cap. Returns null when the cap is unknown (never fabricated)
// or when the user has no floating loss. amber ≥ 80% of cap, red ≥ 100%.
type CapRisk = { level: "warn" | "breach"; pct: number; floatingLoss: number; cap: number };
function dailyLossCapRisk(a: UserAlloc): CapRisk | null {
  const cap = a.dailyLossLimitUsd;
  if (cap == null || cap <= 0) return null;
  const floatingLoss = Math.max(0, -(a.unrealizedPnl ?? 0));
  if (floatingLoss <= 0) return null;
  const pct = floatingLoss / cap;
  if (pct >= 1) return { level: "breach", pct, floatingLoss, cap };
  if (pct >= 0.8) return { level: "warn", pct, floatingLoss, cap };
  return null;
}

// Individual reconciled (ghost) row behind the badge count — returned by the
// read-only GET /api/admin/live-positions/:userId/reconcile-detail endpoint.
type ReconcileDetailRow = {
  id: number; symbol: string; side: string; volume: number; brokerTicket: string;
  reconcileState: string | null; reconcileNote: string | null; reconcileReason: string | null;
  reconciledByAdminId: number | null; reconciledAt: string | null; openedAt: string | null;
};

// ── Ghost-positions badge ───────────────────────────────────────────────────────
// Compact reconciliation summary for one user's OPEN live positions. Shows
// "N reconciled" (ghost rows already resolved via IGNORED/EXTERNAL/IMPORTED)
// and "M genuine open" (reconcile_state IS NULL — real exposure). Only renders
// when there is at least one reconciled ghost row so operators can quickly spot
// accumulation; a user with only genuine open rows shows nothing extra here.
// Clicking it opens a read-only per-user drilldown of the individual ghost rows
// (Task #311) so operators can act in one click instead of navigating manually.
function GhostBadge({ r, onClick }: { r: ReconcileUser | undefined; onClick: () => void }) {
  if (!r || r.reconciledCount <= 0) return null;
  const parts: string[] = [];
  if (r.byState.IGNORED) parts.push(`${r.byState.IGNORED} ignored`);
  if (r.byState.EXTERNAL) parts.push(`${r.byState.EXTERNAL} external`);
  if (r.byState.IMPORTED) parts.push(`${r.byState.IMPORTED} imported`);
  if (r.byState.OTHER) parts.push(`${r.byState.OTHER} other`);
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="ghost-badge"
      title={`Ghost positions — ${parts.join(", ")}. Genuine open (live exposure): ${r.genuineOpen}. Click to review the individual rows.`}
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/40 hover:bg-amber-800/50 hover:border-amber-600/60 cursor-pointer transition">
      👻 {r.reconciledCount} reconciled · {r.genuineOpen} genuine open
    </button>
  );
}

// ── Ghost-detail drilldown ──────────────────────────────────────────────────────
// Read-only modal opened from the GhostBadge. Lists the individual reconciled
// rows (state + note/reason) behind the count for one user, scoped server-side
// to that userId. NO mutation surface lives here — resolving genuinely-orphaned
// rows still happens in the Reconciliation Center (Bridge Diagnostics), linked
// at the bottom. Pure navigation + read-through.
function ghostStateBadge(state: string | null) {
  const s = (state ?? "").toUpperCase();
  const map: Record<string, string> = {
    IGNORED: "bg-secondary text-txt-secondary border-border",
    EXTERNAL: "bg-blue-900/40 text-blue-300 border-blue-700/40",
    IMPORTED: "bg-success/30 text-success border-success/40",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold border ${map[s] ?? "bg-amber-900/40 text-amber-300 border-amber-700/40"}`}>
      {s || "—"}
    </span>
  );
}

function GhostDetailModal({
  user, rows, genuineOpen, loading, error, onClose,
}: {
  user: UserAlloc;
  rows: ReconcileDetailRow[];
  genuineOpen: number | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const fmtWhen = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="ghost-detail-modal">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              👻 Ghost positions — {user.email ?? `User ${user.userId}`}
            </h2>
            <p className="text-xs text-txt-secondary mt-1">
              Reconciled rows already resolved (ignored / external / imported).
              {genuineOpen != null && <> Genuine open exposure: <span className="font-mono text-foreground">{genuineOpen}</span>.</>}
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs text-txt-secondary hover:bg-secondary/80 transition">
            Close
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-txt-muted">Loading reconciled rows…</div>
        ) : error ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-xs text-txt-muted" data-testid="ghost-detail-empty">
            No reconciled rows for this user.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="rounded-md border border-amber-700/30 bg-amber-900/10 p-2.5 text-xs" data-testid={`ghost-row-${row.id}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  {ghostStateBadge(row.reconcileState)}
                  <span className="font-medium text-foreground">{row.symbol}</span>
                  <span className="text-txt-muted uppercase">{row.side}</span>
                  <span className="font-mono text-txt-secondary">{row.volume} lot</span>
                  <span className="text-txt-muted">ticket {row.brokerTicket}</span>
                </div>
                {(row.reconcileNote || row.reconcileReason) && (
                  <div className="text-txt-secondary mt-1.5">
                    {row.reconcileNote && <div><span className="text-txt-muted">Note: </span>{row.reconcileNote}</div>}
                    {row.reconcileReason && <div><span className="text-txt-muted">Reason: </span>{row.reconcileReason}</div>}
                  </div>
                )}
                <div className="text-txt-muted mt-1.5">
                  Resolved {fmtWhen(row.reconciledAt)}
                  {row.reconciledByAdminId != null && <> by admin #{row.reconciledByAdminId}</>}
                  {" · "}opened {fmtWhen(row.openedAt)}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border pt-3 text-[11px] text-txt-muted">
          These rows are already resolved and read-only here. To resolve a genuinely
          orphaned position (ignore / mark external / import-link / close), open the{" "}
          <a href={`${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/admin/bridge-diagnostics`}
            className="text-cyan-400 hover:text-cyan-300 underline" data-testid="ghost-detail-recon-link">
            Reconciliation Center
          </a>.
        </div>
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status, tradingFrozen, aiTradingFrozen }: { status: string; tradingFrozen: boolean; aiTradingFrozen: boolean }) {
  if (status === "frozen") return <span className="text-[10px] rounded px-1.5 py-0.5 bg-danger/40 text-danger border border-danger/40">Frozen</span>;
  if (tradingFrozen)       return <span className="text-[10px] rounded px-1.5 py-0.5 bg-warning/40 text-warning border border-warning/40">Trading Frozen</span>;
  if (aiTradingFrozen)     return <span className="text-[10px] rounded px-1.5 py-0.5 bg-purple-900/40 text-purple-300 border border-purple-700/40">AI Frozen</span>;
  return <span className="text-[10px] rounded px-1.5 py-0.5 bg-success/40 text-success border border-success/40">Active</span>;
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdminAllocationsPage() {
  const { user } = useCurrentUser();
  const isAdmin = ["ADMIN","OWNER"].includes(String(user?.role ?? "").toUpperCase());

  const [allocs, setAllocs] = useState<UserAlloc[]>([]);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reconcileByUser, setReconcileByUser] = useState<Map<number, ReconcileUser>>(new Map());
  const [master, setMaster] = useState<MasterInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Modal state
  const [modal, setModal] = useState<string | null>(null);
  const [target, setTarget] = useState<UserAlloc | null>(null);

  // Ghost-detail drilldown state (read-only)
  const [ghostUser, setGhostUser] = useState<UserAlloc | null>(null);
  const [ghostRows, setGhostRows] = useState<ReconcileDetailRow[]>([]);
  const [ghostGenuineOpen, setGhostGenuineOpen] = useState<number | null>(null);
  const [ghostLoading, setGhostLoading] = useState(false);
  const [ghostError, setGhostError] = useState<string | null>(null);

  const openGhostDetail = useCallback(async (a: UserAlloc) => {
    setGhostUser(a);
    setGhostRows([]);
    setGhostGenuineOpen(null);
    setGhostError(null);
    setGhostLoading(true);
    const pid = markActionStart("admin.allocations.ghostDetail", { page: "/admin/allocations" });
    markApiStart(pid, "GET /api/admin/live-positions/:userId/reconcile-detail");
    try {
      const r = await fetch(`/api/admin/live-positions/${a.userId}/reconcile-detail`, { credentials: "include" });
      const d = await r.json();
      markApiEnd(pid, "GET /api/admin/live-positions/:userId/reconcile-detail");
      if (d.ok) {
        setGhostRows((d.rows ?? []) as ReconcileDetailRow[]);
        setGhostGenuineOpen(typeof d.genuineOpen === "number" ? d.genuineOpen : null);
        markRenderComplete(pid);
      } else {
        setGhostError(d.error ?? "Failed to load reconciled rows");
      }
    } catch {
      markApiEnd(pid, "GET /api/admin/live-positions/:userId/reconcile-detail");
      setGhostError("Failed to load reconciled rows");
    } finally {
      setGhostLoading(false);
      markActionEnd(pid);
    }
  }, []);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [freezeType, setFreezeType] = useState<"full"|"trading"|"ai">("full");
  const [aiAmount, setAiAmount] = useState("");
  const [aiMode, setAiMode] = useState("watch_only");
  const [aiAutoEnabled, setAiAutoEnabled] = useState(false);
  const [aiMaxLot, setAiMaxLot] = useState("");
  const [aiMaxLoss, setAiMaxLoss] = useState("");

  // Attach-user panel state
  const [eligibleQuery, setEligibleQuery] = useState("");
  const [eligible, setEligible] = useState<EligibleUser[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [attachTarget, setAttachTarget] = useState<EligibleUser | null>(null);
  // Cancellation + generation guard for the debounced eligible-user search.
  // The AbortController cancels in-flight fetches when the user keeps typing;
  // the generation token discards any response that arrives after a newer
  // request has already taken over, so the dropdown can never flash stale rows.
  const eligibleAbortRef = useRef<AbortController | null>(null);
  const eligibleGenRef = useRef<number>(0);
  const loadEligible = useCallback(async (q: string) => {
    const pid = markActionStart("admin.allocations.searchEligible", { page: "/admin/allocations" });
    setEligibleLoading(true);
    markUiFeedback(pid);
    markApiStart(pid, "GET /api/admin/allocations/users-eligible");
    // Cancel any in-flight request and tag this one with a generation
    // token so a slow older response can never overwrite a newer one.
    eligibleAbortRef.current?.abort();
    const ctrl = new AbortController();
    eligibleAbortRef.current = ctrl;
    const myGen = ++eligibleGenRef.current;
    try {
      const r = await fetch(`/api/admin/allocations/users-eligible?q=${encodeURIComponent(q)}`, { credentials: "include", signal: ctrl.signal });
      const d = await r.json();
      markApiEnd(pid, "GET /api/admin/allocations/users-eligible");
      if (myGen !== eligibleGenRef.current) return; // stale — drop
      if (d.ok) setEligible(d.users ?? []);
      markRenderComplete(pid);
    } catch (e) {
      markApiEnd(pid, "GET /api/admin/allocations/users-eligible");
      if ((e as Error)?.name === "AbortError") return;
    }
    finally { if (myGen === eligibleGenRef.current) setEligibleLoading(false); markActionEnd(pid); }
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    // 300ms debounce — within the 250-400ms target window. Stale fetches
    // are cancelled by the AbortController above; the gen-token guard
    // ensures out-of-order responses never overwrite newer ones.
    const t = setTimeout(() => loadEligible(eligibleQuery), 300);
    return () => clearTimeout(t);
  }, [isAdmin, eligibleQuery, loadEligible]);

  const load = useCallback(async () => {
    const pid = markActionStart("admin.allocations.loadShell", { page: "/admin/allocations" });
    setLoading(true);
    markUiFeedback(pid);
    markApiStart(pid, "GET /api/admin/allocations");
    try {
      const r = await fetch("/api/admin/allocations", { credentials: "include" });
      const d = await r.json();
      markApiEnd(pid, "GET /api/admin/allocations");
      if (d.ok) { setAllocs(d.users ?? []); setSummary(d.summary ?? null); setMaster(d.master ?? null); markRenderComplete(pid); }
    } catch { markApiEnd(pid, "GET /api/admin/allocations"); setErr("Failed to load allocations"); }
    finally { setLoading(false); markActionEnd(pid); }
    // Reconciliation summary (open ghost vs genuine positions) is a separate,
    // non-blocking read — a failure here must never break the allocations table.
    try {
      const rr = await fetch("/api/admin/live-positions/reconcile-summary", { credentials: "include" });
      const dd = await rr.json();
      if (dd.ok) {
        const m = new Map<number, ReconcileUser>();
        for (const u of (dd.users ?? []) as ReconcileUser[]) m.set(u.userId, u);
        setReconcileByUser(m);
      }
    } catch { /* non-fatal: badge simply won't render */ }
    // Also refresh the eligible-users list so an attach/detach elsewhere
    // (or a freshly-onboarded user) doesn't leave it stale until the
    // next debounced search keystroke.
    loadEligible(eligibleQuery);
  }, [loadEligible, eligibleQuery]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  if (!isAdmin) return (
    <div className="flex min-h-[40vh] items-center justify-center p-6">
      <div className="rounded-xl border border-danger/40 bg-danger/20 p-8 text-center max-w-md">
        <div className="text-3xl mb-3">🔒</div>
        <h2 className="text-base font-semibold text-danger mb-2">Admin Access Only</h2>
        <p className="text-sm text-txt-secondary">Allocation controls are restricted to administrators.</p>
      </div>
    </div>
  );

  const api = async (path: string, body: object) => {
    // Bucket admin mutations into one synthetic action keyed by route so
    // the timing matrix shows attach/freeze/transfer/add-funds separately.
    // Numeric IDs and UUIDs are collapsed to a `:id` placeholder so a
    // path like /api/admin/allocations/123/freeze does NOT explode the
    // perf-action cardinality (one label per user). Query strings are
    // stripped for the same reason.
    const sanitised = path
      .split("?")[0]!
      .replace(/^\/api\/admin\/allocations\/?/, "")
      .split("/")
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg) ? ":id" : seg))
      .filter(Boolean)
      .join(".");
    const actionName = `admin.allocations.${sanitised || "post"}`;
    const pid = markActionStart(actionName, { page: "/admin/allocations" });
    setBusy(true); setErr(null); setMsg(null);
    markUiFeedback(pid);
    markApiStart(pid, `POST ${path}`);
    try {
      const r = await fetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      markApiEnd(pid, `POST ${path}`);
      if (!d.ok) { setErr(d.message ?? d.error ?? "Request failed"); markActionEnd(pid, { bottleneck: "api" }); return false; }
      setMsg("Done."); markRenderComplete(pid); load(); markActionEnd(pid); return true;
    } catch (e) { markApiEnd(pid, `POST ${path}`); markActionEnd(pid, { bottleneck: "network" }); setErr((e as Error).message); return false; }
    finally { setBusy(false); setModal(null); }
  };

  const openModal = (type: string, alloc: UserAlloc) => {
    setTarget(alloc); setModal(type); setAmount(""); setNote("");
    setAiAmount(String(alloc.aiManagedAllocationBalance ?? 0));
    setAiMode(alloc.aiStrategyMode ?? "watch_only");
    setAiAutoEnabled(alloc.aiAutoTradingEnabled ?? false);
    setAiMaxLot(alloc.aiMaxLot ? String(alloc.aiMaxLot) : "");
    setAiMaxLoss(alloc.aiMaxDailyLoss ? String(alloc.aiMaxDailyLoss) : "");
  };

  // Server resolves the active master bridge from arx_master_account_config
  // and ignores this field. Sent for back-compat with prior callers; if
  // the row has no bridge yet, omit it rather than fabricate one.
  const bridgeId = target?.bridgeConnectionId ?? 0;

  // Client-side sort over the already-fetched rows. When no sort column is
  // active we preserve the server's default (updated-at) ordering. Clicking a
  // sortable header sets that column; clicking the active column toggles
  // asc/desc. Missing numeric values are treated as 0 so they sort sanely.
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) { setSortDir(d => (d === "asc" ? "desc" : "asc")); }
    else { setSortKey(key); setSortDir("desc"); }
  };
  const sortedAllocs = sortKey
    ? [...allocs].sort((a, b) => {
        const av = (a[sortKey] ?? 0) as number;
        const bv = (b[sortKey] ?? 0) as number;
        return sortDir === "asc" ? av - bv : bv - av;
      })
    : allocs;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6 pb-32 md:pb-6">
      {/* Header */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h1 className="text-base font-semibold text-foreground mb-1">Bridge Allocations</h1>
        <p className="text-xs text-txt-secondary">Manage operator-funded allocations on the shared master bridge. No live trades are placed from this page.</p>
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            {[
              { label: "Total Allocated", value: `$${summary.totalAllocated.toFixed(2)}` },
              { label: "Frozen Allocation", value: `$${summary.totalFrozen.toFixed(2)}`, red: summary.totalFrozen > 0 },
              { label: "Users", value: summary.userCount },
              { label: "Frozen Users", value: summary.frozenCount, red: summary.frozenCount > 0 },
            ].map(s => (
              <div key={s.label} className="rounded-lg border border-border bg-card p-2.5">
                <div className="text-[10px] text-txt-muted">{s.label}</div>
                <div className={`text-sm font-semibold mt-0.5 ${s.red ? "text-danger" : "text-foreground"}`}>{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {master && master.source === "none" && (
        <div className="rounded-xl border border-danger/40 bg-danger/20 p-4 text-xs text-danger">
          <div className="font-semibold text-danger mb-1">No live master MT5 bridge detected</div>
          <p>No active master bridge could be found. Allocation funding actions (Add, Set, Transfer, AI sleeve) will refuse until a live MT5 bridge is connected and reports a fresh heartbeat. Freeze/Unfreeze still work.</p>
          {master.detectorBlockedReason && <p className="mt-1 text-danger/80 font-mono">Detector: {master.detectorBlockedReason}</p>}
          <p className="mt-1 text-danger/80">Operator action: attach EA v1.27 to the LIVE master MT5 chart and confirm a heartbeat under ARX → MT5 Setup.</p>
        </div>
      )}
      {master && master.available && master.isStale && (
        <div className="rounded-xl border border-warning/30 bg-warning/15 p-3 text-xs text-warning">
          Master bridge heartbeat is stale{master.lastHeartbeatAgeMs != null ? ` (${Math.round(master.lastHeartbeatAgeMs / 1000)}s ago)` : ""}. Funding actions will refuse until a fresh heartbeat is received.
        </div>
      )}
      {master && master.available && !master.isStale && master.headroom != null && master.headroom < 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/20 p-3 text-xs text-danger">
          Over-allocated by ${Math.abs(master.headroom).toFixed(2)}. Total user allocation exceeds master balance.
        </div>
      )}
      {master && master.available && (
        <div className={`rounded-xl border p-4 space-y-3 ${master.source === "pinned" ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${master.source === "pinned" ? "bg-success/40 text-success border border-success/40" : "bg-warning/40 text-warning border border-warning/40"}`}>
                {master.source === "pinned" ? "PINNED" : "AUTO-DETECTED"}
              </span>
              <span className="text-txt-secondary">
                Master bridge <span className="font-mono text-foreground">{master.accountNumberMasked ?? `conn#${master.masterConnectionId ?? "?"}`}</span>
                {master.brokerName ? <> · <span className="text-txt-secondary">{master.brokerName}</span></> : null}
                {master.serverName ? <> · <span className="text-txt-muted">{master.serverName}</span></> : null}
              </span>
            </div>
            {master.source === "auto-detected" && (
              <button type="button" onClick={async () => {
                setBusy(true); setErr(null); setMsg(null);
                try {
                  const r = await fetch("/api/admin/allocations/pin-master", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
                  const d = await r.json();
                  if (d.ok) { setMsg(d.alreadyPinned ? "Master bridge already pinned." : "Master bridge pinned."); load(); }
                  else setErr(d.error ?? "PIN_FAILED");
                } catch (e) { setErr((e as Error).message); }
                finally { setBusy(false); }
              }} disabled={busy}
                className="rounded-lg bg-warning hover:bg-warning text-foreground text-xs px-3 py-1.5 border border-warning disabled:opacity-50">
                Pin this master bridge
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="text-[10px] text-txt-muted">Balance</div>
              <div className="text-sm font-mono font-semibold text-foreground mt-0.5">{master.currency ?? "$"} {master.balance.toFixed(2)}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="text-[10px] text-txt-muted">Equity</div>
              <div className="text-sm font-mono text-foreground mt-0.5">{master.currency ?? "$"} {master.equity.toFixed(2)}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="text-[10px] text-txt-muted">Free margin</div>
              <div className="text-sm font-mono text-foreground mt-0.5">{master.currency ?? "$"} {master.freeMargin.toFixed(2)}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="text-[10px] text-txt-muted">Headroom</div>
              <div className={`text-sm font-mono mt-0.5 ${master.headroom != null && master.headroom < 0 ? "text-danger" : "text-success"}`}>
                {master.headroom != null ? `${master.currency ?? "$"} ${master.headroom.toFixed(2)}` : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="text-[10px] text-txt-muted">Heartbeat</div>
              <div className={`text-sm mt-0.5 ${master.isStale ? "text-warning" : "text-foreground"}`}>
                {master.lastHeartbeatAgeMs != null ? `${Math.round(master.lastHeartbeatAgeMs / 1000)}s ago` : "—"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-txt-muted">
            {master.accountType && <span>Type: <span className="text-txt-secondary">{master.accountType}</span></span>}
            {master.leverage && <span>Leverage: <span className="text-txt-secondary">1:{master.leverage}</span></span>}
            {master.eaVersion && <span>EA: <span className="text-txt-secondary">v{master.eaVersion}</span></span>}
            {master.marginLevelPct != null && <span>Margin level: <span className="text-txt-secondary">{master.marginLevelPct.toFixed(1)}%</span></span>}
            {master.lastHeartbeatAt && <span>Last sync: <span className="text-txt-secondary">{new Date(master.lastHeartbeatAt).toLocaleTimeString()}</span></span>}
          </div>
        </div>
      )}
      {err && <div className="rounded-xl border border-danger/30 bg-danger/20 p-3 text-xs text-danger">{err}</div>}
      {msg && <div className="rounded-xl border border-success/30 bg-success/20 p-3 text-xs text-success">{msg}</div>}

      {/* Attach user to SHARED_MASTER_MT5 */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Attach user to SHARED_MASTER_MT5</h2>
            <p className="text-[11px] text-txt-muted mt-0.5">Seeds the user's virtual account on the active master bridge so their dashboard updates from zero. No trades are placed.</p>
          </div>
          <input value={eligibleQuery} onChange={(e) => setEligibleQuery(e.target.value)} placeholder="Search by email or name…"
            className="w-64 rounded bg-card border border-border px-2 py-1.5 text-xs text-foreground" />
        </div>
        <div className="rounded-lg border border-border bg-card max-h-56 overflow-y-auto">
          {eligibleLoading ? (
            <div className="p-3 text-center text-[11px] text-txt-muted">Searching…</div>
          ) : eligible.length === 0 ? (
            <div className="p-3 text-center text-[11px] text-txt-muted">
  {eligibleQuery
    ? <>No match for "<span className="font-mono">{eligibleQuery}</span>". The user may already be attached — check the User Allocations list below.</>
    : <>No unattached users found.</>}
</div>
          ) : (
            <ul className="divide-y divide-border">
              {eligible.map((u) => (
                <li key={u.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-xs text-foreground truncate">{u.email ?? `User ${u.userId}`}</div>
                    <div className="text-[10px] text-txt-muted truncate">
                      {u.name ?? "—"} · {u.role} · alloc <span className="font-mono">${u.allocatedFunds.toFixed(2)}</span>
                    </div>
                  </div>
                  <button type="button" disabled={busy || !master?.available}
                    onClick={() => { setAttachTarget(u); setNote(""); setModal("attach"); }}
                    className="rounded px-2 py-1 text-[10px] bg-cyan-800/50 text-cyan-200 hover:bg-cyan-700/60 border border-cyan-700/40 disabled:opacity-50">
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!master?.available && (
          <div className="text-[10px] text-warning/80">Attach is disabled until a master bridge is connected with a fresh heartbeat.</div>
        )}
      </div>

      {/* User allocation table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold text-txt-secondary">User Allocations ({allocs.length})</span>
          <button type="button" onClick={load} className="text-xs text-txt-secondary hover:text-foreground">Refresh</button>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-txt-muted">Loading…</div>
        ) : allocs.length === 0 ? (
          <div className="p-6 text-center text-xs text-txt-muted">No allocations yet. Approved users will appear here after their first allocation.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-card border-b border-border">
                <tr>
                  {["User","Total","Manual","AI","Available","Reserved","P/L","Open","Floating P/L","Status","Shell","AI Mode","Actions"].map(h => {
                    const key = SORTABLE_COLUMNS[h];
                    if (!key) return (
                      <th key={h} className="px-3 py-2 text-left text-txt-secondary font-medium whitespace-nowrap">{h}</th>
                    );
                    const active = sortKey === key;
                    return (
                      <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                        <button type="button" onClick={() => toggleSort(key)}
                          className={`inline-flex items-center gap-1 hover:text-foreground transition ${active ? "text-cyan-300" : "text-txt-secondary"}`}
                          title={`Sort by ${h}`}>
                          {h}
                          <span className="text-[9px] leading-none">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedAllocs.map(a => {
                  const capRisk = dailyLossCapRisk(a);
                  const rowTint = capRisk?.level === "breach"
                    ? "bg-danger/30 hover:bg-danger/40"
                    : capRisk?.level === "warn"
                      ? "bg-warning/20 hover:bg-warning/30"
                      : "hover:bg-card";
                  return (
                  <tr key={a.id} className={`border-b border-border ${rowTint}`}>
                    <td className="px-3 py-2 text-txt-secondary max-w-[140px] truncate">{a.email ?? `User ${a.userId}`}</td>
                    <td className="px-3 py-2 font-mono text-foreground">${a.totalAllocation.toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-txt-secondary">${(a.manualAllocationBalance ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-purple-300">${(a.aiManagedAllocationBalance ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-success">${a.availableBalance.toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-warning">${(a.reservedRisk ?? 0).toFixed(2)}</td>
                    <td className={`px-3 py-2 font-mono ${(a.realizedPnl ?? 0) >= 0 ? "text-success" : "text-danger"}`}>
                      ${(a.realizedPnl ?? 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 font-mono text-txt-secondary">
                      <div className="flex flex-col gap-1 items-start">
                        {(a.openPositionsCount ?? 0) > 0 ? (
                          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-secondary text-foreground border border-border">{a.openPositionsCount}</span>
                        ) : (
                          <span className="text-txt-muted">0</span>
                        )}
                        <GhostBadge r={reconcileByUser.get(a.userId)} onClick={() => openGhostDetail(a)} />
                      </div>
                    </td>
                    <td className={`px-3 py-2 font-mono ${(a.unrealizedPnl ?? 0) > 0 ? "text-success" : (a.unrealizedPnl ?? 0) < 0 ? "text-danger" : "text-txt-muted"}`}>
                      <div className="flex items-center gap-1.5">
                        <span>
                          {(a.openPositionsCount ?? 0) > 0 || (a.unrealizedPnl ?? 0) !== 0
                            ? `${(a.unrealizedPnl ?? 0) >= 0 ? "+" : "−"}$${Math.abs(a.unrealizedPnl ?? 0).toFixed(2)}`
                            : "—"}
                        </span>
                        {capRisk && (
                          <span
                            title={`Floating loss $${capRisk.floatingLoss.toFixed(2)} is ${Math.round(capRisk.pct * 100)}% of daily-loss cap $${capRisk.cap.toFixed(2)}`}
                            className={`text-[9px] rounded px-1 py-0.5 font-semibold border ${
                              capRisk.level === "breach"
                                ? "bg-danger/50 text-danger border-danger/50"
                                : "bg-warning/50 text-warning border-warning/50"
                            }`}>
                            {capRisk.level === "breach" ? "CAP BREACH" : "NEAR CAP"} · {Math.round(capRisk.pct * 100)}%
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={a.allocationStatus} tradingFrozen={a.tradingFrozen} aiTradingFrozen={a.aiTradingFrozen} /></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {a.attachment?.attached ? (
                          <span className="text-[10px] rounded px-1.5 py-0.5 bg-cyan-900/40 text-cyan-300 border border-cyan-700/40">Attached</span>
                        ) : (
                          <span className="text-[10px] rounded px-1.5 py-0.5 bg-secondary text-txt-secondary border border-border">Not attached</span>
                        )}
                        {a.attachment?.attached && (
                          a.attachment.shellSynced
                            ? <span className="text-[10px] rounded px-1.5 py-0.5 bg-success/40 text-success border border-success/40" title={`vBal $${a.attachment.virtualBalance.toFixed(2)}`}>Synced</span>
                            : <span className="text-[10px] rounded px-1.5 py-0.5 bg-warning/40 text-warning border border-warning/40" title={`vBal $${a.attachment.virtualBalance.toFixed(2)}`}>Drift</span>
                        )}
                        {a.attachment?.approvedForMasterLive && (
                          <span className="text-[10px] rounded px-1.5 py-0.5 bg-violet-900/40 text-violet-300 border border-violet-700/40">Approved</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-txt-secondary capitalize">{a.aiStrategyMode?.replace("_"," ")}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button type="button" onClick={() => openModal("add", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-success/40 text-success hover:bg-success/70/40 border border-success/30">+Add</button>
                        <button type="button" onClick={() => openModal("remove", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-danger/40 text-danger hover:bg-danger/40 border border-danger/30">-Remove</button>
                        <button type="button" onClick={() => openModal("set", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-secondary text-txt-secondary hover:bg-secondary/80 border border-border">Set</button>
                        <button type="button" onClick={() => openModal("transfer", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-primary/40 text-primary hover:bg-primary/40 border border-primary/30">Transfer</button>
                        <button type="button" onClick={() => openModal("ai", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-purple-900/40 text-purple-300 hover:bg-purple-800/40 border border-purple-700/30">AI</button>
                        {a.attachment?.attached && (
                          <button type="button" onClick={() => openModal("refresh", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-cyan-900/40 text-cyan-300 hover:bg-cyan-800/40 border border-cyan-700/30">Refresh</button>
                        )}
                        {a.attachment?.attached && (
                          <button type="button" onClick={() => openModal("detach", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-secondary text-txt-secondary hover:bg-secondary/80 border border-border">Detach</button>
                        )}
                        {a.allocationStatus !== "frozen" && !a.tradingFrozen ? (
                          <button type="button" onClick={() => { openModal("freeze", a); setFreezeType("full"); }} className="rounded px-1.5 py-0.5 text-[10px] bg-danger/40 text-danger hover:bg-danger/40 border border-danger/30">Freeze</button>
                        ) : (
                          <button type="button" onClick={() => openModal("unfreeze", a)} className="rounded px-1.5 py-0.5 text-[10px] bg-success/40 text-success hover:bg-success/40 border border-success/30">Unfreeze</button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────────── */}

      {modal === "add" && target && (
        <Modal title={`Add Allocation — ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/add`, { bridgeConnectionId: bridgeId, amount: parseFloat(amount), note })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="Amount to add ($)"><Input type="number" value={amount} onChange={setAmount} placeholder="e.g. 500" /></Field>
          <div className="text-xs text-txt-secondary">Current allocation: <span className="text-foreground font-mono">${target.totalAllocation.toFixed(2)}</span> → New: <span className="text-success font-mono">${(target.totalAllocation + (parseFloat(amount) || 0)).toFixed(2)}</span></div>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} placeholder="e.g. Initial allocation" /></Field>
        </Modal>
      )}

      {modal === "remove" && target && (
        <Modal title={`Remove Allocation — ${target.email ?? `User ${target.userId}`}`} danger
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/remove`, { bridgeConnectionId: bridgeId, amount: parseFloat(amount), note })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="Amount to remove ($)"><Input type="number" value={amount} onChange={setAmount} placeholder="e.g. 200" /></Field>
          <div className="text-xs text-txt-secondary">Available (unreserved): <span className="font-mono text-warning">${Math.max(0, target.availableBalance - target.reservedRisk).toFixed(2)}</span></div>
          <div className="text-xs text-txt-muted">Removed allocation returns to the unallocated pool.</div>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "set" && target && (
        <Modal title={`Set Exact Allocation — ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/set`, { bridgeConnectionId: bridgeId, amount: parseFloat(amount), note })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="New exact allocation ($)"><Input type="number" value={amount} onChange={setAmount} placeholder={String(target.totalAllocation)} /></Field>
          <div className="text-xs text-txt-secondary">Current: <span className="font-mono text-foreground">${target.totalAllocation.toFixed(2)}</span></div>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "transfer" && target && (
        <Modal title={`Transfer Allocation from ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/transfer`, { bridgeConnectionId: bridgeId, toUserId: parseInt(toUserId), amount: parseFloat(amount), note })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="Amount ($)"><Input type="number" value={amount} onChange={setAmount} /></Field>
          <Field label="Destination User ID">
            <select value={toUserId} onChange={e => setToUserId(e.target.value)}
              className="w-full rounded bg-card border border-border px-2 py-1.5 text-sm text-foreground">
              <option value="">Select user…</option>
              {allocs.filter(a => a.userId !== target.userId).map(a => (
                <option key={a.userId} value={a.userId}>{a.email ?? `User ${a.userId}`}</option>
              ))}
            </select>
          </Field>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "freeze" && target && (
        <Modal title={`Freeze — ${target.email ?? `User ${target.userId}`}`} danger
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/freeze`, { bridgeConnectionId: bridgeId, freezeType, reason: note || "Admin freeze" })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="Freeze type">
            <select value={freezeType} onChange={e => setFreezeType(e.target.value as any)}
              className="w-full rounded bg-card border border-border px-2 py-1.5 text-sm text-foreground">
              <option value="full">Full account freeze — no trading, no AI</option>
              <option value="trading">Trading freeze — no manual trades</option>
              <option value="ai">AI freeze — AI cannot open trades</option>
            </select>
          </Field>
          <Field label="Reason (required)"><Input value={note} onChange={setNote} placeholder="e.g. Risk limit breach" /></Field>
        </Modal>
      )}

      {modal === "unfreeze" && target && (
        <Modal title={`Unfreeze — ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/unfreeze`, { bridgeConnectionId: bridgeId, unfreezeType: "full", note })}
          onCancel={() => setModal(null)} busy={busy}>
          <p className="text-xs text-txt-secondary">This will unfreeze all trading and AI trading for <strong className="text-foreground">{target.email}</strong>.</p>
          {target.freezeReason && <div className="text-xs text-txt-muted">Freeze reason: {target.freezeReason}</div>}
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "attach" && attachTarget && (
        <Modal title={`Attach to SHARED_MASTER_MT5 — ${attachTarget.email ?? `User ${attachTarget.userId}`}`}
          onConfirm={async () => {
            const ok = await api(`/api/admin/allocations/${attachTarget.userId}/attach-shared-master`, {
              accountType: "demo",
              note,
            });
            if (ok) { setAttachTarget(null); loadEligible(eligibleQuery); }
          }}
          onCancel={() => { setModal(null); setAttachTarget(null); }} busy={busy}>
          <p className="text-xs text-txt-secondary">Seeds the user's virtual demo account on the active master bridge. Their dashboard will immediately reflect their currently allocated funds.</p>
          <div className="text-xs text-txt-secondary">
            Seed balance: <span className="font-mono text-foreground">${attachTarget.allocatedFunds.toFixed(2)}</span> <span className="text-txt-muted">(= current allocated funds)</span>
          </div>
          <div className="text-[11px] text-txt-muted">To change the shell balance, use Add/Set after attaching, or Refresh to reconcile drift.</div>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} placeholder="e.g. Onboarding allocation" /></Field>
        </Modal>
      )}

      {modal === "refresh" && target && (
        <Modal title={`Refresh shell — ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/refresh-shell`, { note })}
          onCancel={() => setModal(null)} busy={busy}>
          <p className="text-xs text-txt-secondary">Corrective sync. Forces virtual balance = allocated funds + virtual P&L. Used when the shell has drifted from the admin-set allocation.</p>
          <div className="text-xs text-txt-secondary">
            Allocated: <span className="font-mono text-foreground">${target.totalAllocation.toFixed(2)}</span>
            {target.attachment && <> · Current vBal: <span className="font-mono text-foreground">${target.attachment.virtualBalance.toFixed(2)}</span></>}
          </div>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "detach" && target && (
        <Modal title={`Detach from SHARED_MASTER_MT5 — ${target.email ?? `User ${target.userId}`}`} danger
          onConfirm={async () => {
            const ok = await api(`/api/admin/allocations/${target.userId}/detach-shared-master`, { note });
            if (ok) loadEligible(eligibleQuery);
          }}
          onCancel={() => setModal(null)} busy={busy}>
          <p className="text-xs text-txt-secondary">Marks the user's virtual account as <strong className="text-foreground">closed</strong>. Their shell will revert to zero. The allocation row and history are preserved. Refuses if open positions exist.</p>
          <Field label="Reason (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {modal === "ai" && target && (
        <Modal title={`AI Allocation — ${target.email ?? `User ${target.userId}`}`}
          onConfirm={() => api(`/api/admin/allocations/${target.userId}/ai`, {
            bridgeConnectionId: bridgeId,
            aiAmount: parseFloat(aiAmount) || 0,
            aiAutoTradingEnabled: aiAutoEnabled,
            aiWatchOnly: aiMode === "watch_only",
            aiStrategyMode: aiMode,
            aiMaxLot: aiMaxLot ? parseFloat(aiMaxLot) : null,
            aiMaxDailyLoss: aiMaxLoss ? parseFloat(aiMaxLoss) : null,
            note,
          })}
          onCancel={() => setModal(null)} busy={busy}>
          <Field label="AI-managed allocation ($)"><Input type="number" value={aiAmount} onChange={setAiAmount} placeholder="0" /></Field>
          <div className="text-xs text-txt-secondary">Total allocation: <span className="font-mono text-foreground">${target.totalAllocation.toFixed(2)}</span></div>
          <Field label="AI strategy mode">
            <select value={aiMode} onChange={e => setAiMode(e.target.value)}
              className="w-full rounded bg-card border border-border px-2 py-1.5 text-sm text-foreground">
              <option value="watch_only">Suggest only — AI proposes ideas, no auto-trades</option>
              <option value="conservative">Conservative — AI trades with minimal risk</option>
              <option value="balanced">Balanced — standard AI trading</option>
              <option value="aggressive">Aggressive — higher risk AI mode</option>
            </select>
          </Field>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="ai-auto" checked={aiAutoEnabled} onChange={e => setAiAutoEnabled(e.target.checked)} className="h-3.5 w-3.5" />
            <label htmlFor="ai-auto" className="text-xs text-txt-secondary">Enable AI auto-trading (off by default)</label>
          </div>
          {aiAutoEnabled && <div className="rounded bg-warning/20 border border-warning/30 p-2 text-xs text-warning">AI auto-trading enabled. AI will submit orders within the AI allocation, subject to all live gates.</div>}
          <Field label="AI max lot (optional)"><Input type="number" value={aiMaxLot} onChange={setAiMaxLot} placeholder="e.g. 0.1" /></Field>
          <Field label="AI max daily loss (optional)"><Input type="number" value={aiMaxLoss} onChange={setAiMaxLoss} placeholder="e.g. 50" /></Field>
          <Field label="Note (optional)"><Input value={note} onChange={setNote} /></Field>
        </Modal>
      )}

      {ghostUser && (
        <GhostDetailModal
          user={ghostUser}
          rows={ghostRows}
          genuineOpen={ghostGenuineOpen}
          loading={ghostLoading}
          error={ghostError}
          onClose={() => setGhostUser(null)}
        />
      )}
    </div>
  );
}
