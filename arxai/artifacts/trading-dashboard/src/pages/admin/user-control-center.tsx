import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { useAssistantName } from "@/lib/assistant-name";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, Loader2, ShieldCheck, Users, Layers, Settings, KeyRound,
  FileText, RefreshCw, CheckCircle2, XCircle, UserCog,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────
// fetch helpers
// ──────────────────────────────────────────────────────────────────────────
async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function apiJson<T>(method: string, url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method, credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const j = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || j?.ok === false) {
    const err = new Error(j?.error ?? `HTTP ${r.status}`);
    (err as Error & { payload?: unknown }).payload = j;
    throw err;
  }
  return j;
}

// ──────────────────────────────────────────────────────────────────────────
// shared types
// ──────────────────────────────────────────────────────────────────────────
interface UserRow {
  userId: number;
  email: string;
  name: string | null;
  role: string;
  isSystemUser: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  accountStatus: "ACTIVE" | "PENDING" | "INVITED" | "SUSPENDED" | "DISABLED";
  disabledReason: string | null;
  tradingMode: "PAPER" | "DEMO" | "LIVE";
  liveTradingApproved: boolean;
  liveTradingStatus: string;
  sharedBridgeApproved: boolean;
  personalBridgeEnabled: boolean;
  riskTemplateId: number | null;
  caps: null | {
    maxLot: number; dailyLossLimitUsd: number; maxOpenPositions: number;
    allowedSymbols: string[]; requireStopLoss: boolean;
  };
  toggles: null | {
    aiTradingEnabled: boolean; aiAutoCloseEnabled: boolean;
    rubyVoiceEnabled: boolean; newsIntelligenceEnabled: boolean;
    historicalBacktestEnabled: boolean; blockedSymbols: string[];
    minRewardRiskRatio: number | null; stopLossRequired: boolean;
    takeProfitRequired: boolean;
  };
  currentExposureLots: number;
  currentFloatingPlUsd: number;
  openTradesCount: number;
  lastTradeAt: string | null;
  adminMemo: string | null;
  lastSettingsPushAt: string | null;
}
interface UserListResp { ok: true; users: UserRow[]; total: number; limit: number; offset: number; }

interface RiskTemplate {
  id: number; name: string; description: string | null;
  payload: Record<string, unknown>; isArchived: boolean;
  createdBy: number; createdAt: string; updatedAt: string;
}
interface TemplatesResp { ok: true; templates: RiskTemplate[]; }

interface PreviewResp {
  ok: true;
  affected: Array<{ userId: number; email: string; name: string | null }>;
  effectivePayload: Record<string, unknown>;
  dangerousFields: string[];
  confirmationRequired: boolean;
}

// Reusable modal-confirm prompt — replaces typed-phrase inputs throughout.
function ConfirmPrompt({ open, title, description, danger, confirmLabel, onConfirm, onCancel }: {
  open: boolean; title: string; description: React.ReactNode;
  danger?: boolean; confirmLabel?: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md" data-testid="confirm-prompt">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {danger && <AlertTriangle className="h-4 w-4 text-destructive" />}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onCancel} data-testid="confirm-cancel">Cancel</Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm}
            data-testid="confirm-ok">
            {confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Presets — one-click bundles. Live approval is intentionally NEVER in a
// preset; it requires admin click on the Live Access page with proper caps.
// ──────────────────────────────────────────────────────────────────────────
type PresetKey =
  | "paper_only" | "demo_tester" | "demo_scanner"
  | "live_conservative" | "live_standard"
  | "disable_trading" | "emergency_lockdown";

interface Preset {
  label: string;
  description: string;
  tone: "default" | "secondary" | "destructive";
  payload: Record<string, unknown>;
  alsoSetScannerLive?: boolean;
  alsoSetAccountStatus?: "ACTIVE" | "SUSPENDED" | "DISABLED";
}
const PRESETS: Record<PresetKey, Preset> = {
  paper_only: {
    label: "Disable trading (AI on)",
    description: "Demo and live disabled. Scanner read-only. AI assistant on.",
    tone: "secondary",
    payload: {
      aiTradingEnabled: true, rubyVoiceEnabled: true,
      newsIntelligenceEnabled: true, historicalBacktestEnabled: true,
      stopLossRequired: true, takeProfitRequired: false,
    },
    alsoSetScannerLive: false,
  },
  demo_tester: {
    label: "Demo Tester",
    description: "Scanner-live on, AI on, conservative defaults. No live trading.",
    tone: "default",
    payload: {
      aiTradingEnabled: true, rubyVoiceEnabled: true,
      newsIntelligenceEnabled: true, historicalBacktestEnabled: true,
      stopLossRequired: true,
    },
    alsoSetScannerLive: true,
  },
  demo_scanner: {
    label: "Demo + Scanner",
    description: "Same as Demo Tester + news + backtest enabled.",
    tone: "default",
    payload: {
      aiTradingEnabled: true, rubyVoiceEnabled: true,
      newsIntelligenceEnabled: true, historicalBacktestEnabled: true,
      stopLossRequired: true,
    },
    alsoSetScannerLive: true,
  },
  live_conservative: {
    label: "Live — Conservative",
    description: "Tight caps (0.01 lot, $50 daily loss). Live approval is granted separately.",
    tone: "default",
    payload: {
      maxLotSize: 0.01, maxDailyLossUsd: 50,
      stopLossRequired: true, takeProfitRequired: true,
      aiAutoCloseEnabled: false, minRewardRiskRatio: 2,
    },
  },
  live_standard: {
    label: "Live — Standard",
    description: "Standard caps (0.05 lot, $200 daily loss). Live approval is granted separately.",
    tone: "default",
    payload: {
      maxLotSize: 0.05, maxDailyLossUsd: 200,
      stopLossRequired: true, takeProfitRequired: false,
      aiAutoCloseEnabled: false, minRewardRiskRatio: 1.5,
    },
  },
  disable_trading: {
    label: "Disable Trading",
    description: "Suspends the user. Scanner live off. Keeps AI for explanations.",
    tone: "destructive",
    payload: {
      aiTradingEnabled: false,
    },
    alsoSetScannerLive: false,
    alsoSetAccountStatus: "SUSPENDED",
  },
  emergency_lockdown: {
    label: "Emergency Lockdown",
    description: "Disables the user. All AI/scanner off. Existing positions are NOT auto-closed.",
    tone: "destructive",
    payload: {
      aiTradingEnabled: false, rubyVoiceEnabled: false,
      newsIntelligenceEnabled: false, historicalBacktestEnabled: false,
    },
    alsoSetScannerLive: false,
    alsoSetAccountStatus: "DISABLED",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// shared user-list hook
// ──────────────────────────────────────────────────────────────────────────
function useUserList(filters: Record<string, string> = {}) {
  const qp = new URLSearchParams(filters);
  return useQuery({
    queryKey: ["admin/user-control/users", filters],
    queryFn: () => apiGet<UserListResp>(`/api/admin/user-control/users?${qp.toString()}`),
    refetchInterval: 20_000,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// PAGE — mobile-friendly tabs (horizontal scroll on small, dropdown on xs)
// ──────────────────────────────────────────────────────────────────────────
const TABS: Array<{ value: string; label: string; icon: typeof Users }> = [
  { value: "users", label: "User Directory", icon: Users },
  { value: "approvals", label: "Approvals", icon: KeyRound },
  { value: "push", label: "Push Settings", icon: Settings },
  { value: "trading", label: "Trading Access", icon: Layers },
  { value: "templates", label: "Risk Templates", icon: FileText },
  { value: "audit", label: "Audit Log", icon: ShieldCheck },
];

export default function UserControlCenterPage() {
  const [tab, setTab] = useState("users");
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6 pb-32 md:pb-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-7 w-7 text-primary" />
          <h1 className="text-xl sm:text-2xl font-semibold">User Control Center</h1>
          <Badge variant="outline" className="ml-2">Admin</Badge>
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Search any user. Manage their access from one panel. Live
          trading and shared-bridge approval always require an explicit
          per-user confirmation.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        {/* Mobile dropdown tab selector */}
        <div className="sm:hidden">
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger data-testid="select-mobile-tab" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABS.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Desktop / tablet horizontal scroll pill tabs */}
        <div
          role="tablist"
          className="hidden sm:flex flex-nowrap gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.value;
            return (
              <button
                key={t.value} role="tab" type="button"
                onClick={() => setTab(t.value)}
                data-testid={`tab-${t.value}`}
                aria-selected={isActive}
                className={
                  "shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition " +
                  (isActive
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        <TabsContent value="users"><DirectoryTab /></TabsContent>
        <TabsContent value="approvals"><ApprovalsTab /></TabsContent>
        <TabsContent value="push"><PushSettingsTab /></TabsContent>
        <TabsContent value="trading"><TradingAccessTab /></TabsContent>
        <TabsContent value="templates"><RiskTemplatesTab /></TabsContent>
        <TabsContent value="audit"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// shared user list filter bar — Real / Pending / Active / Disabled / Test
// ──────────────────────────────────────────────────────────────────────────
type ScopeKey = "real" | "pending" | "active" | "disabled" | "system";
function useScopedUserList(q: string, scope: ScopeKey) {
  const params: Record<string, string> = { q };
  if (scope === "system") params.onlySystem = "true";
  const data = useUserList(params);
  const rows = data.data?.users ?? [];
  const filtered = useMemo(() => {
    if (scope === "real" || scope === "system") return rows;
    if (scope === "pending") return rows.filter((u) => u.accountStatus === "PENDING" || u.accountStatus === "INVITED");
    if (scope === "active") return rows.filter((u) => u.accountStatus === "ACTIVE");
    if (scope === "disabled") return rows.filter((u) => u.accountStatus === "DISABLED" || u.accountStatus === "SUSPENDED");
    return rows;
  }, [rows, scope]);
  return { ...data, users: filtered };
}

function ScopeChips({ scope, setScope }: { scope: ScopeKey; setScope: (s: ScopeKey) => void }) {
  const chips: Array<{ key: ScopeKey; label: string }> = [
    { key: "real", label: "All real users" },
    { key: "active", label: "Active" },
    { key: "pending", label: "Pending" },
    { key: "disabled", label: "Disabled/Suspended" },
    { key: "system", label: "Test / System" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button
          key={c.key} type="button"
          data-testid={`chip-${c.key}`}
          onClick={() => setScope(c.key)}
          className={
            "rounded-full border px-3 py-1 text-xs transition " +
            (scope === c.key
              ? "bg-foreground text-background"
              : "bg-background text-foreground hover:bg-accent")
          }
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// USER DIRECTORY — the new home tab. One row per user, quick actions, and
// Risk Profile section — switches between Owner Unrestricted Live,
// First Live Test Mode, and Approved Shared Bridge Default. Server
// rejects OWNER_UNRESTRICTED_LIVE unless the caller's role is OWNER.
function RiskProfileSection({ userId, userEmail }: { userId: number; userEmail: string | null }) {
  const qc = useQueryClient();
  const [pendingProfile, setPendingProfile] = useState<null | "OWNER_UNRESTRICTED_LIVE" | "FIRST_LIVE_TEST_MODE" | "APPROVED_SHARED_BRIDGE_DEFAULT">(null);
  const profileQ = useQuery<{ ok: boolean; current: { templateId: number | null; templateName: string | null; isOwnerUnrestricted: boolean } }>({
    queryKey: ["admin", "user-risk-profile", userId],
    queryFn: async () => (await fetch(`/api/admin/users/${userId}/risk-profile`, { credentials: "include" })).json(),
  });
  const applyMut = useMutation({
    mutationFn: async (profile: string) => {
      const r = await fetch(`/api/admin/users/${userId}/risk-profile`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, confirm: true }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.detail ?? j.error ?? "Apply failed");
      return j;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "user-risk-profile", userId] });
      setPendingProfile(null);
    },
  });
  const cur = profileQ.data?.current;
  const desc: Record<string, string> = {
    OWNER_UNRESTRICTED_LIVE: `Removes app-level caps for ${userEmail ?? "this user"} (no symbol allowlist, no lot cap, no SL/TP/daily-loss enforcement). EVERY other safety gate still runs: 16-gate evaluator, kill switch, master switch, bridge heartbeat, manual confirmation, audit, per-user isolation. OWNER role only.`,
    FIRST_LIVE_TEST_MODE: `Tightens to the safest possible limits: max 1 open, 0.01 lot, EURUSD only, SL required, $10 daily-loss cap. Use for the very first live test.`,
    APPROVED_SHARED_BRIDGE_DEFAULT: `Restores the standard approved-shared-bridge defaults (0.01 lot, EURUSD + GBPUSD, SL+TP required).`,
  };
  return (
    <Section title="Live Risk Profile">
      <div className="text-xs text-muted-foreground">
        Active profile: <strong>{cur?.templateName ?? "—"}</strong>
        {cur?.isOwnerUnrestricted && <span className="ml-2 inline-block rounded bg-warning/20 px-1.5 py-0.5 text-warning font-mono text-[10px]">UNRESTRICTED</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive"
          onClick={() => setPendingProfile("OWNER_UNRESTRICTED_LIVE")}
          data-testid="ma-button-profile-unrestricted"
          disabled={applyMut.isPending || cur?.isOwnerUnrestricted}>
          Apply Owner Unrestricted Live
        </Button>
        <Button size="sm" variant="outline"
          onClick={() => setPendingProfile("FIRST_LIVE_TEST_MODE")}
          data-testid="ma-button-profile-fltm"
          disabled={applyMut.isPending}>
          Revert to First Live Test Mode
        </Button>
        <Button size="sm" variant="outline"
          onClick={() => setPendingProfile("APPROVED_SHARED_BRIDGE_DEFAULT")}
          data-testid="ma-button-profile-default"
          disabled={applyMut.isPending}>
          Revert to Approved Shared Bridge Default
        </Button>
      </div>
      {applyMut.error && (
        <p className="text-xs text-destructive">{(applyMut.error as Error).message}</p>
      )}
      <Dialog open={pendingProfile != null} onOpenChange={(o) => !o && setPendingProfile(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply risk profile?</DialogTitle>
            <DialogDescription className="text-xs">
              {pendingProfile ? desc[pendingProfile] : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingProfile(null)}>Cancel</Button>
            <Button variant="destructive"
              onClick={() => pendingProfile && applyMut.mutate(pendingProfile)}
              disabled={applyMut.isPending}
              data-testid="ma-button-profile-confirm">
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

// a single Manage Access dialog with all the sections.
// ──────────────────────────────────────────────────────────────────────────
function DirectoryTab() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<ScopeKey>("real");
  const list = useScopedUserList(q, scope);
  const [manageUserId, setManageUserId] = useState<number | null>(null);
  // Always re-source the managed user from the latest list cache so
  // Manage Access switches reflect saved state without a reopen.
  const manageUser = useMemo(
    () => list.users.find((u) => u.userId === manageUserId) ?? null,
    [list.users, manageUserId],
  );

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle>User Directory</CardTitle>
        <CardDescription>
          Search any user, then click <strong>Manage Access</strong> for
          one-panel control over their account, trading mode, bridge,
          features, and risk limits.
        </CardDescription>
        <div className="space-y-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by email, name, id, role, status, or mode…"
            data-testid="input-search-directory"
          />
          <ScopeChips scope={scope} setScope={setScope} />
        </div>
      </CardHeader>
      <CardContent>
        {list.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {!list.isLoading && list.users.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {scope === "system"
              ? "No test/system users match this search."
              : "No real users found for this search."}
          </p>
        )}
        <ul className="divide-y rounded border">
          {list.users.map((u) => (
            <li key={u.userId} className="p-3" data-testid={`user-row-${u.userId}`}>
              <UserRowCard user={u} onManage={() => setManageUserId(u.userId)} />
            </li>
          ))}
        </ul>
      </CardContent>
      <ManageAccessDialog
        user={manageUser}
        open={!!manageUser}
        onClose={() => setManageUserId(null)}
      />
    </Card>
  );
}

function UserRowCard({ user, onManage }: { user: UserRow; onManage: () => void }) {
  const qc = useQueryClient();
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const setStatus = useMutation({
    mutationFn: ({ status, reason, confirmed }: {
      status: "ACTIVE" | "SUSPENDED" | "DISABLED"; reason?: string; confirmed?: boolean;
    }) => apiJson<unknown>("POST",
      `/api/admin/user-control/users/${user.userId}/status`,
      { status, reason, confirmedDangerous: confirmed === true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });
  const setScanner = useMutation({
    mutationFn: (enabled: boolean) => apiJson<unknown>(
      "POST", `/api/admin/user-control/users/${user.userId}/scanner-live`,
      { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{user.email}</span>
          {user.isSystemUser && <Badge variant="outline" className="text-xs">test/system</Badge>}
          {user.role === "ADMIN" && <Badge variant="default" className="text-xs">admin</Badge>}
          {user.role === "OWNER" && <Badge variant="default" className="text-xs">owner</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>id #{user.userId}</span>
          <span>·</span>
          <StatusBadge status={user.accountStatus} />
          <span>·</span>
          <ModeBadge mode={user.tradingMode} />
          {user.liveTradingApproved && (
            <>
              <span>·</span>
              <Badge variant="default" className="text-xs">live ✓</Badge>
            </>
          )}
          {user.sharedBridgeApproved && (
            <>
              <span>·</span>
              <Badge variant="default" className="text-xs">shared bridge ✓</Badge>
            </>
          )}
          {user.lastLoginAt && (
            <>
              <span>·</span>
              <span>last login {new Date(user.lastLoginAt).toLocaleDateString()}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={onManage}
          data-testid={`button-manage-${user.userId}`}>
          <UserCog className="mr-1 h-3.5 w-3.5" />Manage Access
        </Button>
        {(user.accountStatus === "PENDING" || user.accountStatus === "INVITED") && (
          <Button size="sm" variant="default"
            onClick={() => setStatus.mutate({ status: "ACTIVE" })}
            data-testid={`button-approve-user-${user.userId}`}>
            Approve User
          </Button>
        )}
        {user.tradingMode === "PAPER" && (
          <Button size="sm" variant="outline"
            onClick={() => setScanner.mutate(true)}
            data-testid={`button-enable-demo-${user.userId}`}>
            Enable Demo
          </Button>
        )}
        {user.tradingMode === "DEMO" && !user.liveTradingApproved && (
          <Link to="/admin/live-shared">
            <Button size="sm" variant="outline"
              data-testid={`button-request-live-${user.userId}`}>
              Request / Approve Live ➜
            </Button>
          </Link>
        )}
        {user.accountStatus === "ACTIVE" && (
          <Button size="sm" variant="ghost"
            onClick={() => setConfirmSuspend(true)}
            data-testid={`button-suspend-${user.userId}`}>
            Suspend
          </Button>
        )}
      </div>
      <ConfirmPrompt
        open={confirmSuspend}
        title="Suspend this user?"
        description={<>This will block <strong>{user.email}</strong> from signing in until you reactivate the account. Audit log records the change.</>}
        danger confirmLabel="Suspend user"
        onCancel={() => setConfirmSuspend(false)}
        onConfirm={() => {
          setStatus.mutate({ status: "SUSPENDED",
            reason: "Quick suspend from directory", confirmed: true });
          setConfirmSuspend(false);
        }} />
    </div>
  );
}

function StatusBadge({ status }: { status: UserRow["accountStatus"] }) {
  if (status === "ACTIVE") return <Badge variant="default" className="text-xs">active</Badge>;
  if (status === "PENDING") return <Badge variant="secondary" className="text-xs">pending</Badge>;
  if (status === "INVITED") return <Badge variant="secondary" className="text-xs">invited</Badge>;
  if (status === "SUSPENDED") return <Badge variant="outline" className="text-xs">suspended</Badge>;
  return <Badge variant="destructive" className="text-xs">disabled</Badge>;
}
function ModeBadge({ mode }: { mode: UserRow["tradingMode"] }) {
  if (mode === "LIVE") return <Badge variant="default" className="text-xs">live</Badge>;
  if (mode === "DEMO") return <Badge variant="secondary" className="text-xs">demo</Badge>;
  return <Badge variant="outline" className="text-xs">paper</Badge>;
}

// ──────────────────────────────────────────────────────────────────────────
// MANAGE ACCESS — the unified per-user dialog
// ──────────────────────────────────────────────────────────────────────────
function ManageAccessDialog({ user, open, onClose }: {
  user: UserRow | null; open: boolean; onClose: () => void;
}) {
  const { name } = useAssistantName();
  const qc = useQueryClient();
  const [presetKey, setPresetKey] = useState<PresetKey | "">("");
  const [presetPreview, setPresetPreview] = useState<PreviewResp | null>(null);
  const [memo, setMemo] = useState("");
  // Single confirmation modal state — used by Disable, Suspend, Approve
  // Shared Bridge, raise caps, Apply dangerous preset.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string; description: React.ReactNode; danger?: boolean;
    confirmLabel?: string; onConfirm: () => void;
  } | null>(null);

  const detail = useQuery({
    enabled: !!user,
    queryKey: ["admin/user-control/users/detail", user?.userId],
    queryFn: () => apiGet<{ ok: true; advanced: { adminMemo: string | null } }>(
      `/api/admin/user-control/users/${user!.userId}`),
  });

  // Reset state when user changes
  useMemo(() => {
    setPresetKey(""); setPresetPreview(null); setPendingConfirm(null);
    setMemo(detail.data?.advanced?.adminMemo ?? user?.adminMemo ?? "");
    return null;
  }, [user?.userId, detail.data]);

  const updateAdv = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiJson<unknown>(
      "PUT", `/api/admin/user-control/users/${user!.userId}/advanced`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin/user-control/users"] });
      qc.invalidateQueries({ queryKey: ["admin/user-control/users/detail"] });
    },
  });
  const setScanner = useMutation({
    mutationFn: (enabled: boolean) => apiJson<unknown>(
      "POST", `/api/admin/user-control/users/${user!.userId}/scanner-live`,
      { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });
  const setStatus = useMutation({
    mutationFn: ({ status, reason, confirmed }: {
      status: "ACTIVE" | "SUSPENDED" | "DISABLED"; reason?: string; confirmed?: boolean;
    }) => apiJson<unknown>("POST",
      `/api/admin/user-control/users/${user!.userId}/status`,
      { status, reason, confirmedDangerous: confirmed === true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });
  const setBridge = useMutation({
    mutationFn: ({ approved, confirmed }: { approved: boolean; confirmed?: boolean }) =>
      apiJson<unknown>("POST",
        `/api/admin/user-control/users/${user!.userId}/shared-bridge`,
        { approved, confirmedDangerous: confirmed === true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });

  const previewPreset = useMutation({
    mutationFn: () => apiJson<PreviewResp>(
      "POST", "/api/admin/user-control/push-settings/preview",
      {
        targets: { kind: "user", userId: user!.userId },
        payload: PRESETS[presetKey as PresetKey].payload,
      }),
    onSuccess: (data) => { setPresetPreview(data); },
  });
  const applyPreset = useMutation({
    mutationFn: async () => {
      const preset = PRESETS[presetKey as PresetKey];
      const need = (presetPreview?.dangerousFields ?? []).length > 0;
      const r = await apiJson<unknown>("POST", "/api/admin/user-control/push-settings", {
        targets: { kind: "user", userId: user!.userId },
        payload: preset.payload,
        reason: `Preset: ${preset.label}`,
        confirmedDangerous: need,
      });
      // Apply scanner-live + status side effects
      if (preset.alsoSetScannerLive !== undefined) {
        await apiJson<unknown>(
          "POST", `/api/admin/user-control/users/${user!.userId}/scanner-live`,
          { enabled: preset.alsoSetScannerLive });
      }
      if (preset.alsoSetAccountStatus && preset.alsoSetAccountStatus !== "DISABLED") {
        await apiJson<unknown>(
          "POST", `/api/admin/user-control/users/${user!.userId}/status`,
          { status: preset.alsoSetAccountStatus,
            reason: `Preset: ${preset.label}`,
            // Operator already confirmed via the preset modal, and SUSPENDED
            // requires confirmedDangerous on the server.
            confirmedDangerous: preset.alsoSetAccountStatus === "SUSPENDED" });
      }
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin/user-control/users"] });
      setPresetKey(""); setPresetPreview(null);
    },
  });

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage Access — {user.email}</DialogTitle>
          <DialogDescription>
            One panel for everything. Dangerous changes show a quick
            Confirm / Cancel prompt. Live trading approval is on its own
            page.
          </DialogDescription>
        </DialogHeader>

        {/* SECTION: Account Access */}
        <Section title="Account Access">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Current status:</span>
            <StatusBadge status={user.accountStatus} />
          </div>
          <div className="flex flex-wrap gap-2">
            {user.accountStatus !== "ACTIVE" && (
              <Button size="sm"
                onClick={() => setStatus.mutate({ status: "ACTIVE" })}
                data-testid="ma-button-approve-user">
                Approve User
              </Button>
            )}
            {user.accountStatus === "ACTIVE" && (
              <Button size="sm" variant="outline"
                onClick={() => setPendingConfirm({
                  title: "Suspend this user?",
                  description: <>This blocks <strong>{user.email}</strong> from signing in until reactivated.</>,
                  danger: true, confirmLabel: "Suspend user",
                  onConfirm: () => setStatus.mutate({ status: "SUSPENDED",
                    reason: "Suspended from Manage Access", confirmed: true }),
                })}
                data-testid="ma-button-suspend">
                Suspend
              </Button>
            )}
            <Button size="sm" variant="destructive"
              onClick={() => setPendingConfirm({
                title: "Disable this user?",
                description: <>This fully disables <strong>{user.email}</strong>. They will not be able to sign in, trade, or use the bridge until you reactivate the account. Audit log records this change.</>,
                danger: true, confirmLabel: "Disable user",
                onConfirm: () => setStatus.mutate({ status: "DISABLED",
                  reason: "Disabled from Manage Access", confirmed: true }),
              })}
              data-testid="ma-button-disable">
              Disable User
            </Button>
          </div>
          {setStatus.error && (
            <p className="text-xs text-destructive">
              {(setStatus.error as Error).message}
            </p>
          )}
        </Section>

        {/* SECTION: Trading Access */}
        <Section title="Trading Access">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Mode:</span><ModeBadge mode={user.tradingMode} />
            {user.liveTradingApproved && (
              <Badge variant="default" className="text-xs">live approved</Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm"
              variant="outline"
              onClick={() => setScanner.mutate(false)}
              data-testid="ma-button-scanner-off">
              Scanner Off
            </Button>
            <Button size="sm"
              variant={user.tradingMode === "DEMO" ? "default" : "outline"}
              onClick={() => setScanner.mutate(true)}
              data-testid="ma-button-demo">
              Enable Demo
            </Button>
            <Link to="/admin/live-shared">
              <Button size="sm" variant="outline" data-testid="ma-button-live-link">
                {user.liveTradingApproved ? "Manage Live Access ➜" : "Request / Approve Live ➜"}
              </Button>
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Live trading approval is granted on the Live Shared Account
            page with its own caps and confirmations.
          </p>
        </Section>

        {/* SECTION: Bridge Access */}
        <Section title="Bridge Access">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Personal bridge:</span>
            <Switch checked={user.personalBridgeEnabled}
              onCheckedChange={(v) => updateAdv.mutate({ personalBridgeEnabled: v })}
              data-testid="ma-switch-personal-bridge" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
            <div>
              <div className="text-sm">Shared / Master Bridge</div>
              <div className="text-xs text-muted-foreground">
                {user.sharedBridgeApproved
                  ? "Approved — user can route through the shared master bridge."
                  : "Not approved — user uses their personal bridge only."}
              </div>
            </div>
            <Switch checked={user.sharedBridgeApproved}
              disabled={setBridge.isPending}
              onCheckedChange={(want) => {
                if (want) {
                  setPendingConfirm({
                    title: "Approve shared bridge?",
                    description: <>This lets <strong>{user.email}</strong> route trades through the operator-funded shared master bridge. Live execution is still independently gated.</>,
                    danger: true, confirmLabel: "Approve shared bridge",
                    onConfirm: () => setBridge.mutate({ approved: true, confirmed: true }),
                  });
                } else {
                  setBridge.mutate({ approved: false });
                }
              }}
              data-testid="ma-switch-shared-bridge" />
          </div>
          {setBridge.error && (
            <p className="text-xs text-destructive">{(setBridge.error as Error).message}</p>
          )}
        </Section>

        {/* SECTION: Ruby / AI / Scanner */}
        {user.toggles && (
          <Section title={`AI, ${name} & Scanner`}>
            <ToggleLine label="AI Trading enabled"
              checked={user.toggles.aiTradingEnabled}
              onChange={(v) => updateAdv.mutate({ aiTradingEnabled: v })}
              testid="ma-toggle-ai" />
            <ToggleLine label="AI Auto-close (kept ALERT-ONLY at trading layer)"
              checked={user.toggles.aiAutoCloseEnabled}
              onChange={(v) => updateAdv.mutate({ aiAutoCloseEnabled: v })}
              testid="ma-toggle-autoclose" />
            <ToggleLine label={`${name} voice enabled`}
              checked={user.toggles.rubyVoiceEnabled}
              onChange={(v) => updateAdv.mutate({ rubyVoiceEnabled: v })}
              testid="ma-toggle-ruby" />
            <ToggleLine label="News intelligence"
              checked={user.toggles.newsIntelligenceEnabled}
              onChange={(v) => updateAdv.mutate({ newsIntelligenceEnabled: v })}
              testid="ma-toggle-news" />
            <ToggleLine label="Historical backtest"
              checked={user.toggles.historicalBacktestEnabled}
              onChange={(v) => updateAdv.mutate({ historicalBacktestEnabled: v })}
              testid="ma-toggle-backtest" />
          </Section>
        )}

        {/* SECTION: Risk Limits */}
        {user.toggles && (
          <Section title="Risk Limits">
            <ToggleLine label="Require Stop Loss"
              checked={user.toggles.stopLossRequired}
              onChange={(v) => updateAdv.mutate({ stopLossRequired: v })}
              testid="ma-toggle-sl" />
            <ToggleLine label="Require Take Profit"
              checked={user.toggles.takeProfitRequired}
              onChange={(v) => updateAdv.mutate({ takeProfitRequired: v })}
              testid="ma-toggle-tp" />
            <div className="text-xs text-muted-foreground">
              {user.caps && (
                <>Current caps — Max lot: <strong>{user.caps.maxLot}</strong> ·
                Daily loss: <strong>${user.caps.dailyLossLimitUsd}</strong> ·
                Max open: <strong>{user.caps.maxOpenPositions}</strong>.
                Raising these requires confirmation via the Push Settings tab.</>
              )}
            </div>
          </Section>
        )}

        {/* SECTION: Risk Profile (Owner Unrestricted Live / FLTM / Default) */}
        <RiskProfileSection userId={user.userId} userEmail={user.email} />

        {/* SECTION: Quick Presets */}
        <Section title="Quick Presets">
          <div className="space-y-2">
            <Select value={presetKey || "none"} onValueChange={(v) =>
              setPresetKey(v === "none" ? "" : v as PresetKey)}>
              <SelectTrigger data-testid="ma-select-preset">
                <SelectValue placeholder="— Choose a preset —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Choose a preset —</SelectItem>
                {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
                  <SelectItem key={k} value={k}>{PRESETS[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {presetKey && (
              <>
                <p className="text-xs text-muted-foreground">
                  {PRESETS[presetKey].description}
                </p>
                <Button size="sm" variant="outline"
                  onClick={() => previewPreset.mutate()}
                  disabled={previewPreset.isPending}
                  data-testid="ma-button-preview-preset">
                  {previewPreset.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Preview changes
                </Button>
              </>
            )}
            {presetPreview && (
              <div className="rounded border p-2 space-y-2">
                <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(presetPreview.effectivePayload, null, 2)}
                </pre>
                {presetPreview.dangerousFields.length > 0 ? (
                  <Badge variant="destructive" className="text-xs">
                    <AlertTriangle className="mr-1 h-3 w-3" />
                    Dangerous: {presetPreview.dangerousFields.join(", ")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">Safe — one-click apply</Badge>
                )}
                <Button size="sm"
                  onClick={() => {
                    if (presetPreview.dangerousFields.length > 0) {
                      setPendingConfirm({
                        title: `Apply preset: ${PRESETS[presetKey as PresetKey].label}?`,
                        description: <>This changes risk-critical settings for <strong>{user.email}</strong>: {presetPreview.dangerousFields.join(", ")}.</>,
                        danger: true, confirmLabel: "Apply preset",
                        onConfirm: () => applyPreset.mutate(),
                      });
                    } else {
                      applyPreset.mutate();
                    }
                  }}
                  disabled={applyPreset.isPending}
                  data-testid="ma-button-apply-preset">
                  {applyPreset.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Apply preset
                </Button>
                {applyPreset.error && (
                  <p className="text-xs text-destructive">{(applyPreset.error as Error).message}</p>
                )}
                {PRESETS[presetKey as PresetKey].alsoSetAccountStatus === "DISABLED" && (
                  <p className="text-xs text-muted-foreground">
                    Note: this preset does not auto-disable the account.
                    Use the Disable User button above to finalise.
                  </p>
                )}
              </div>
            )}
          </div>
        </Section>

        {/* SECTION: Notes */}
        <Section title="Notes / Admin Memo">
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)}
            data-testid="ma-textarea-memo" />
          <Button size="sm" variant="outline"
            onClick={() => updateAdv.mutate({ adminMemo: memo })}
            disabled={updateAdv.isPending}
            data-testid="ma-button-save-memo">
            Save Memo
          </Button>
        </Section>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="ma-button-close">
            Close
          </Button>
        </DialogFooter>
        {pendingConfirm && (
          <ConfirmPrompt open
            title={pendingConfirm.title}
            description={pendingConfirm.description}
            danger={pendingConfirm.danger}
            confirmLabel={pendingConfirm.confirmLabel}
            onCancel={() => setPendingConfirm(null)}
            onConfirm={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
function ToggleLine({ label, checked, onChange, testid }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; testid: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// APPROVALS — focused on pending/invited (uses same search)
// ──────────────────────────────────────────────────────────────────────────
function ApprovalsTab() {
  const [q, setQ] = useState("");
  const list = useUserList({ q });
  const all = list.data?.users ?? [];
  const pending = useMemo(
    () => all.filter((u) => u.accountStatus === "PENDING" || u.accountStatus === "INVITED"),
    [all],
  );
  const alreadyActive = useMemo(
    () => q.trim().length > 0 ? all.filter((u) => u.accountStatus === "ACTIVE") : [],
    [all, q],
  );
  const qc = useQueryClient();
  const [suspendTarget, setSuspendTarget] = useState<{ userId: number; email: string } | null>(null);
  const setStatus = useMutation({
    mutationFn: ({ userId, status, confirmed }: {
      userId: number; status: "ACTIVE" | "SUSPENDED"; confirmed?: boolean;
    }) =>
      apiJson<unknown>("POST",
        `/api/admin/user-control/users/${userId}/status`,
        { status, confirmedDangerous: confirmed === true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/user-control/users"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>User Approvals</CardTitle>
        <CardDescription>
          Approve newly registered or invited users. This activates the
          account but does NOT grant live trading (which is a separate
          per-user approval).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search all real users…"
          data-testid="input-search-approvals" />
        {list.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending.length === 0 && !list.isLoading && (
          <p className="text-sm text-muted-foreground">
            {q
              ? "No pending or invited users match this search."
              : "No pending or invited users right now."}
          </p>
        )}
        <ul className="divide-y rounded border">
          {pending.map((u) => (
            <li key={u.userId} className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="font-medium">{u.email}</div>
                <div className="text-xs text-muted-foreground">
                  id #{u.userId} · {u.accountStatus} · role {u.role}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm"
                  onClick={() => setStatus.mutate({ userId: u.userId, status: "ACTIVE" })}
                  data-testid={`button-approve-${u.userId}`}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />Approve
                </Button>
                <Button size="sm" variant="outline"
                  onClick={() => setSuspendTarget({ userId: u.userId, email: u.email })}
                  data-testid={`button-suspend-pending-${u.userId}`}>
                  <XCircle className="mr-1 h-3.5 w-3.5" />Suspend
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {suspendTarget && (
          <ConfirmPrompt open
            title="Suspend this user?"
            description={<>This blocks <strong>{suspendTarget.email}</strong> from signing in until reactivated.</>}
            danger confirmLabel="Suspend user"
            onCancel={() => setSuspendTarget(null)}
            onConfirm={() => {
              setStatus.mutate({ userId: suspendTarget.userId,
                status: "SUSPENDED", confirmed: true });
              setSuspendTarget(null);
            }} />
        )}
        {alreadyActive.length > 0 && (
          <div className="rounded border bg-muted/30 p-3 text-sm">
            <strong>Note:</strong> {alreadyActive.length} matching user
            {alreadyActive.length === 1 ? " is" : "s are"} already
            active. Manage {alreadyActive.length === 1 ? "them" : "them"} from
            the User Directory tab.
            <ul className="mt-2 space-y-1">
              {alreadyActive.slice(0, 5).map((u) => (
                <li key={u.userId} className="text-xs">• {u.email}</li>
              ))}
              {alreadyActive.length > 5 && (
                <li className="text-xs">…and {alreadyActive.length - 5} more</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PUSH SETTINGS — keep the existing bulk push flow but tighter copy
// ──────────────────────────────────────────────────────────────────────────
function PushSettingsTab() {
  const { name } = useAssistantName();
  const list = useUserList();
  const templates = useQuery({
    queryKey: ["admin/risk-templates"],
    queryFn: () => apiGet<TemplatesResp>("/api/admin/risk-templates"),
  });

  type TargetKind = "user" | "userIds" | "all_paper" | "all_demo" | "all_live" | "all";
  const [targetKind, setTargetKind] = useState<TargetKind>("all_paper");
  const [singleUserId, setSingleUserId] = useState<string>("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [templateId, setTemplateId] = useState<string>("none");
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [reason, setReason] = useState("");

  function targetsForRequest() {
    if (targetKind === "user") return { kind: "user" as const, userId: Number(singleUserId) };
    if (targetKind === "userIds") return { kind: "userIds" as const, userIds: Array.from(selectedUserIds) };
    return { kind: targetKind } as { kind: TargetKind };
  }

  const previewMut = useMutation({
    mutationFn: () => apiJson<PreviewResp>(
      "POST", "/api/admin/user-control/push-settings/preview",
      { targets: targetsForRequest(),
        templateId: templateId === "none" ? null : Number(templateId),
        payload }),
    onSuccess: (data) => { setPreview(data); },
  });
  const qc = useQueryClient();
  const pushMut = useMutation({
    mutationFn: () => apiJson<{ ok: true; pushedCount: number; failedCount: number }>(
      "POST", "/api/admin/user-control/push-settings",
      { targets: targetsForRequest(),
        templateId: templateId === "none" ? null : Number(templateId),
        payload,
        confirmedDangerous: (preview?.dangerousFields ?? []).length > 0,
        reason: reason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin/user-control/users"] });
      setPreview(null); setPayload({});
    },
  });

  function setPayloadField(k: string, v: unknown) {
    setPayload((p) => {
      const np = { ...p };
      if (v === undefined || v === "" || v === null) delete np[k];
      else np[k] = v;
      return np;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Push Settings</CardTitle>
        <CardDescription>
          Push selected settings to one user, a list, or a class of
          users. Live trading approval CANNOT be pushed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <Label>Target</Label>
            <Select value={targetKind} onValueChange={(v) => setTargetKind(v as TargetKind)}>
              <SelectTrigger data-testid="select-target"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">Single user</SelectItem>
                <SelectItem value="userIds">Pick users from list</SelectItem>
                <SelectItem value="all_paper">All paper-only users</SelectItem>
                <SelectItem value="all_demo">All demo users</SelectItem>
                <SelectItem value="all_live">All live-approved users</SelectItem>
                <SelectItem value="all">Every user</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {targetKind === "user" && (
            <div>
              <Label>User ID</Label>
              <Input type="number" value={singleUserId}
                onChange={(e) => setSingleUserId(e.target.value)}
                data-testid="input-single-user-id" />
            </div>
          )}
          <div>
            <Label>Risk template (baseline)</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger data-testid="select-template"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {(templates.data?.templates ?? []).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {targetKind === "userIds" && (
          <div className="max-h-64 overflow-y-auto rounded border p-2">
            {(list.data?.users ?? []).map((u) => (
              <label key={u.userId} className="flex items-center gap-2 py-1">
                <input type="checkbox"
                  checked={selectedUserIds.has(u.userId)}
                  onChange={(e) => {
                    const next = new Set(selectedUserIds);
                    if (e.target.checked) next.add(u.userId); else next.delete(u.userId);
                    setSelectedUserIds(next);
                  }}
                  data-testid={`checkbox-user-${u.userId}`} />
                <span className="text-sm">{u.email}
                  <span className="text-xs text-muted-foreground"> ({u.tradingMode})</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <PushToggle label="AI Trading enabled" k="aiTradingEnabled" payload={payload} set={setPayloadField} />
          <PushToggle label="AI Auto-close" k="aiAutoCloseEnabled" payload={payload} set={setPayloadField} />
          <PushToggle label={`${name} voice`} k="rubyVoiceEnabled" payload={payload} set={setPayloadField} />
          <PushToggle label="News intelligence" k="newsIntelligenceEnabled" payload={payload} set={setPayloadField} />
          <PushToggle label="Historical backtest" k="historicalBacktestEnabled" payload={payload} set={setPayloadField} />
          <PushToggle label="Require Stop Loss" k="stopLossRequired" payload={payload} set={setPayloadField} />
          <PushToggle label="Require Take Profit" k="takeProfitRequired" payload={payload} set={setPayloadField} />
          <PushToggle label="🔒 Shared Bridge approved (DANGEROUS)" k="sharedBridgeApproved" payload={payload} set={setPayloadField} />
          <PushToggle label="🔒 Personal bridge mode" k="personalBridgeEnabled" payload={payload} set={setPayloadField} />
          <div>
            <Label>🔒 Max Lot Size</Label>
            <Input type="number" step="0.01" min="0"
              value={String((payload.maxLotSize as number | undefined) ?? "")}
              onChange={(e) => setPayloadField("maxLotSize", e.target.value === "" ? undefined : Number(e.target.value))}
              data-testid="input-max-lot" />
          </div>
          <div>
            <Label>🔒 Max Daily Loss (USD)</Label>
            <Input type="number" step="1" min="0"
              value={String((payload.maxDailyLossUsd as number | undefined) ?? "")}
              onChange={(e) => setPayloadField("maxDailyLossUsd", e.target.value === "" ? undefined : Number(e.target.value))}
              data-testid="input-max-daily-loss" />
          </div>
        </div>

        <div>
          <Label>Reason (for audit)</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-reason" />
        </div>

        <Button variant="outline" onClick={() => previewMut.mutate()}
          disabled={previewMut.isPending} data-testid="button-preview">
          {previewMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Preview affected users
        </Button>

        {previewMut.error && (
          <p className="text-sm text-destructive">{(previewMut.error as Error).message}</p>
        )}

        {preview && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{preview.affected.length} users affected</Badge>
              {preview.dangerousFields.length > 0 ? (
                <Badge variant="destructive">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  Dangerous: {preview.dangerousFields.join(", ")}
                </Badge>
              ) : <Badge variant="secondary">Safe (single bulk confirm)</Badge>}
            </div>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
              {JSON.stringify(preview.effectivePayload, null, 2)}
            </pre>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
              <Button
                variant={preview.dangerousFields.length > 0 ? "destructive" : "default"}
                onClick={() => {
                  if (preview.dangerousFields.length > 0) setConfirmPush(true);
                  else pushMut.mutate();
                }}
                disabled={pushMut.isPending} data-testid="button-confirm-push">
                {pushMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Push Settings
              </Button>
            </div>
            <ConfirmPrompt
              open={confirmPush}
              title="Push risk-critical settings?"
              description={<>This will change <strong>{preview.dangerousFields.join(", ")}</strong> on <strong>{preview.affected.length}</strong> user{preview.affected.length === 1 ? "" : "s"}. Audit log records every change.</>}
              danger confirmLabel="Push settings"
              onCancel={() => setConfirmPush(false)}
              onConfirm={() => { setConfirmPush(false); pushMut.mutate(); }} />
            {pushMut.error && (
              <p className="text-sm text-destructive">{(pushMut.error as Error).message}</p>
            )}
            {pushMut.data && (
              <p className="text-sm text-success">
                Pushed to {pushMut.data.pushedCount} users ({pushMut.data.failedCount} failed).
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PushToggle({ label, k, payload, set }: {
  label: string; k: string; payload: Record<string, unknown>;
  set: (k: string, v: unknown) => void;
}) {
  const present = payload[k] !== undefined;
  return (
    <div className="flex items-center justify-between rounded border px-3 py-2">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">
        <Switch disabled={!present} checked={Boolean(payload[k])}
          onCheckedChange={(v) => set(k, v)} data-testid={`push-toggle-${k}`} />
        <Button size="sm" variant="ghost"
          onClick={() => set(k, present ? undefined : false)}
          data-testid={`push-include-${k}`}>{present ? "—" : "+"}</Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TRADING ACCESS — focused live-access table; links into the existing flow
// ──────────────────────────────────────────────────────────────────────────
function TradingAccessTab() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<ScopeKey>("real");
  const list = useScopedUserList(q, scope);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trading Access</CardTitle>
        <CardDescription>
          Quick overview of every user's trading mode, live approval,
          shared bridge, and current exposure. Use Manage Access on each
          row for changes.
        </CardDescription>
        <div className="space-y-2 pt-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search…" data-testid="input-search-trading" />
          <ScopeChips scope={scope} setScope={setScope} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">User</th>
                <th className="p-2 text-left">Mode</th>
                <th className="p-2 text-left">Live</th>
                <th className="p-2 text-left">Bridge</th>
                <th className="p-2 text-left">Open / Exp.</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.users.map((u) => (
                <tr key={u.userId} className="border-t" data-testid={`row-trading-${u.userId}`}>
                  <td className="p-2">
                    <div className="font-medium">{u.email}</div>
                    <div className="text-xs text-muted-foreground">id #{u.userId}</div>
                  </td>
                  <td className="p-2"><ModeBadge mode={u.tradingMode} /></td>
                  <td className="p-2">
                    {u.liveTradingApproved
                      ? <Badge variant="default">APPROVED</Badge>
                      : <Badge variant="outline">{u.liveTradingStatus}</Badge>}
                  </td>
                  <td className="p-2">
                    {u.sharedBridgeApproved
                      ? <Badge variant="default">approved</Badge>
                      : <Badge variant="outline">none</Badge>}
                  </td>
                  <td className="p-2 text-xs">
                    {u.openTradesCount} / {u.currentExposureLots.toFixed(2)} lots
                    {" · "}
                    <span className={u.currentFloatingPlUsd >= 0 ? "text-success" : "text-destructive"}>
                      {u.currentFloatingPlUsd.toFixed(2)}
                    </span>
                  </td>
                  <td className="p-2 text-right">
                    <Link to="/admin/live-shared">
                      <Button size="sm" variant="outline">Live Access ➜</Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.isLoading && list.users.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              No real users found for this search.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// RISK TEMPLATES — CRUD
// ──────────────────────────────────────────────────────────────────────────
function RiskTemplatesTab() {
  const list = useQuery({
    queryKey: ["admin/risk-templates"],
    queryFn: () => apiGet<TemplatesResp>("/api/admin/risk-templates"),
  });
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [payloadStr, setPayloadStr] = useState('{\n  "maxLotSize": 0.01,\n  "stopLossRequired": true\n}');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(payloadStr || "{}"); }
      catch { throw new Error("Payload must be valid JSON"); }
      return apiJson<unknown>("POST", "/api/admin/risk-templates", {
        name, description: desc || undefined, payload,
      });
    },
    onSuccess: () => {
      setName(""); setDesc(""); setCreateError(null);
      qc.invalidateQueries({ queryKey: ["admin/risk-templates"] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });
  const archiveMut = useMutation({
    mutationFn: (id: number) => apiJson<unknown>("POST", `/api/admin/risk-templates/${id}/archive`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin/risk-templates"] }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Existing templates</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {list.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {(list.data?.templates ?? []).map((t) => (
            <div key={t.id} className="rounded border p-3" data-testid={`template-row-${t.id}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{t.name}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                </div>
                <Button size="sm" variant="outline" onClick={() => archiveMut.mutate(t.id)}
                  disabled={archiveMut.isPending} data-testid={`button-archive-${t.id}`}>
                  Archive
                </Button>
              </div>
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(t.payload, null, 2)}
              </pre>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create template</CardTitle>
          <CardDescription>
            Templates can carry caps and toggles but never live trading
            or shared-bridge approval — those require explicit per-user
            approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div><Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-template-name" />
          </div>
          <div><Label>Description</Label>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} data-testid="input-template-desc" />
          </div>
          <div><Label>Payload JSON</Label>
            <Textarea rows={10} value={payloadStr}
              onChange={(e) => setPayloadStr(e.target.value)}
              data-testid="textarea-template-payload" />
          </div>
          {createError && <p className="text-sm text-destructive">{createError}</p>}
          <Button onClick={() => createMut.mutate()} disabled={createMut.isPending || !name}
            data-testid="button-create-template">
            {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// AUDIT — link out
// ──────────────────────────────────────────────────────────────────────────
function AuditTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit Log</CardTitle>
        <CardDescription>
          Every admin action from this page is recorded in the central
          audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link to="/admin/audit-center">
          <Button data-testid="button-open-audit">
            <RefreshCw className="mr-2 h-4 w-4" />Open Audit Center
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
