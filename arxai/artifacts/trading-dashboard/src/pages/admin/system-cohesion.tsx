// Task #233 — Admin · System Cohesion (AACI operator window, Phase 7)
//
// READ-ONLY operator window into ARX Adaptive Cohesion Intelligence (AACI).
// It visualizes the live cohesion read for a chosen symbol — the overall score,
// every component sub-score, live cross-system handshakes, conflicts, data
// freshness, speed/latency, trade reconciliation, agent cohesion, the alerts
// pipeline, learning health, the append-only decision/learning audit log, and
// open repairs — plus a single-decision drawer with the full breakdown.
//
// SAFETY:
// - AACI is ADVISORY. It can only ADD caution; it never places, modifies, or
//   closes a trade and is never an execution gate. Nothing on this page mutates
//   a safety surface — it is display-only and reads existing permissioned APIs.
// - Wrapped in AdminDiagnosticsGate so non-admins AND admins-previewing-as-user
//   see a clean placeholder. The server independently requires an ADMIN/OWNER
//   session on every endpoint, and the /admin/* route is default-deny for
//   normal users and investors.
// - No fabricated numbers. Every panel shows an honest empty state when data is
//   absent. "Shock Mode" is shown as "Not reported" because the AACI engine
//   does not currently emit a shock-mode signal — it is never invented here.

import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { EmptyState, LoadingState, ErrorState } from "@/components/ss/States";
import {
  Activity, RefreshCw, ShieldCheck, GitMerge, AlertTriangle, Clock, Gauge,
  Workflow, Bot, BellRing, Brain, ScrollText, Wrench, ShieldAlert, Layers,
  Lock, KeyRound, History,
} from "lucide-react";
import { STATUS_COLORS, type StatusTone, confidenceTone } from "@/lib/design-tokens";
import {
  useGetAdminAaciDecision,
  useListAdminAaciDecisions,
  useGetAdminAaciLearningSummary,
  useListAdminAaciTrustScores,
  useListAdminAaciLearningChanges,
  useGetAdminSecurityOverview,
  useGetAdminSecurityTimeline,
} from "@workspace/api-client-react";
import type {
  AaciDecision,
  AaciHandshakeEntry,
  AaciHandshakeEntryStatus,
  AaciDecisionListItem,
  AaciTrustScore,
  AaciLearningChange,
  AaciRecommendedAction,
  AdminSecurityOverview,
  AdminSecurityControlStatus,
  AdminSecurityTimelineEvent,
} from "@workspace/api-client-react";

// ── Symbols the operator can read cohesion for. These match the cockpit timing
// widgets so the operator sees the same canonical set across the app. ──────────
const COHESION_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSDT"] as const;

// ── Plain-English labels for the recommended action (full AaciDecision carries
// the raw enum only; list rows carry their own label). Never show a raw token. ─
const ACTION_LABEL: Record<AaciRecommendedAction, string> = {
  ALLOW: "Allow",
  ALLOW_REDUCED_SIZE: "Allow — reduced size",
  PREPARE_ONLY: "Prepare only",
  WAIT_FOR_CONFIRMATION: "Wait for confirmation",
  WATCH_ONLY: "Watch only",
  PROTECT_OPEN_TRADE: "Protect open trade",
  EXIT_OR_REDUCE: "Exit or reduce",
  RECONCILE_SYSTEM: "Reconcile system",
  BLOCK: "Block",
  ALERT_ADMIN: "Alert admin",
};

function actionTone(a: AaciRecommendedAction): StatusTone {
  switch (a) {
    case "ALLOW":
    case "ALLOW_REDUCED_SIZE":
      return "success";
    case "PREPARE_ONLY":
    case "WAIT_FOR_CONFIRMATION":
    case "WATCH_ONLY":
      return "warning";
    case "PROTECT_OPEN_TRADE":
    case "EXIT_OR_REDUCE":
    case "RECONCILE_SYSTEM":
    case "BLOCK":
    case "ALERT_ADMIN":
      return "danger";
    default:
      return "neutral";
  }
}

const HANDSHAKE_TONE: Record<AaciHandshakeEntryStatus, StatusTone> = {
  PASS: "success",
  WARN: "warning",
  FAIL: "danger",
  STALE: "warning",
  MISSING: "danger",
};

function Tone({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[tone].badge}`}>
      {children}
    </span>
  );
}

// Honest score coercion: returns a clamped 0–100 integer for a real finite
// number, or `null` when the value is absent / non-finite. Callers render an
// honest "—" / "Not reported" for null — NEVER a fabricated 0.
function toScore(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Inline tone-coloured score, or a muted "—" when not reported (never 0).
function ScoreText({ score, suffix = "" }: { score: number | null | undefined; suffix?: string }) {
  const v = toScore(score);
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return <span className={STATUS_COLORS[confidenceTone(v)].text}>{v}{suffix}</span>;
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)} ms`;
}

// ── Score card with progress bar. Higher = healthier (confidenceTone). ────────
function ScoreCard({
  label, score, sub, icon,
}: { label: string; score: number | null | undefined; sub?: string; icon?: React.ReactNode }) {
  const v = toScore(score);
  const tone = v === null ? "neutral" : confidenceTone(v);
  return (
    <Card data-testid={`cohesion-score-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon && <span className="text-muted-foreground" aria-hidden="true">{icon}</span>}
        </div>
        {v === null ? (
          <>
            <div className="mt-1 text-2xl font-bold text-muted-foreground">—</div>
            <Progress value={0} className="mt-2 h-1.5 opacity-40" />
            <div className="mt-1 text-[11px] text-muted-foreground">{sub ?? "Not reported"}</div>
          </>
        ) : (
          <>
            <div className={`mt-1 text-2xl font-bold ${STATUS_COLORS[tone].text}`}>{v}</div>
            <Progress value={v} className="mt-2 h-1.5" />
            {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// A count card (conflicts / repairs) — tone is danger when the count is > 0.
function CountCard({
  label, count, zeroNote, icon,
}: { label: string; count: number; zeroNote: string; icon?: React.ReactNode }) {
  const tone: StatusTone = count > 0 ? "danger" : "success";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon && <span className="text-muted-foreground" aria-hidden="true">{icon}</span>}
        </div>
        <div className={`mt-1 text-2xl font-bold ${STATUS_COLORS[tone].text}`}>{count}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{count > 0 ? "Needs attention" : zeroNote}</div>
      </CardContent>
    </Card>
  );
}

// ── A small stat card (value can be text); honest neutral by default. ─────────
function StatCard({
  label, value, tone = "neutral", sub, icon,
}: { label: string; value: React.ReactNode; tone?: StatusTone; sub?: string; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon && <span className="text-muted-foreground" aria-hidden="true">{icon}</span>}
        </div>
        <div className={`mt-1 text-2xl font-bold ${STATUS_COLORS[tone].text}`}>{value}</div>
        {sub && <div className="mt-1 text-[11px] text-muted-foreground break-words">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// ── AACI Security (Phase 5) — admin-only, READ-ONLY. ──────────────────────────
// Surfaces the existing Security Score engine, protection/encryption status, and
// a redacted critical-event timeline. Never shows a secret value; honest "—" for
// any signal that could not be verified; never fabricates a number.

// Security band → tone. Higher band = healthier.
function securityBandTone(band: AdminSecurityOverview["band"]): StatusTone {
  switch (band) {
    case "Secure":
    case "Healthy":
      return "success";
    case "Watch":
    case "Degraded":
      return "warning";
    case "Critical":
    case "Lockdown":
      return "danger";
    default:
      return "neutral";
  }
}

// Honest tri-state-plus chip for a protection control.
type ControlState = "yes" | "no" | "future" | "unknown";
function ControlChip({ state, text }: { state: ControlState; text: string }) {
  const tone: StatusTone =
    state === "yes" ? "success" : state === "no" ? "danger" : state === "future" ? "warning" : "neutral";
  return <Tone tone={tone}>{text}</Tone>;
}

type ControlRow = { label: string; state: ControlState; text: string };

function boolRow(label: string, v: boolean | null | undefined, yes: string, no: string): ControlRow {
  if (v === true) return { label, state: "yes", text: yes };
  if (v === false) return { label, state: "no", text: no };
  return { label, state: "unknown", text: "Unknown" };
}

function enumRow(label: string, s: AdminSecurityControlStatus): ControlRow {
  switch (s) {
    case "ACTIVE":
      return { label, state: "yes", text: "Active" };
    case "INACTIVE":
      return { label, state: "no", text: "Inactive" };
    case "FUTURE_READY":
      return { label, state: "future", text: "Future-ready" };
    default:
      return { label, state: "unknown", text: "Unknown" };
  }
}

function buildControlRows(enc: AdminSecurityOverview["encryption"]): ControlRow[] {
  // legacyUnencryptedDetected has inverted semantics: detected = bad.
  const legacy: ControlRow =
    enc.legacyUnencryptedDetected == null
      ? { label: "Legacy unencrypted data", state: "unknown", text: "Not scanned" }
      : enc.legacyUnencryptedDetected
        ? { label: "Legacy unencrypted data", state: "no", text: "Detected — needs migration" }
        : { label: "Legacy unencrypted data", state: "yes", text: "None detected" };
  return [
    boolRow("Encryption-at-rest key", enc.encryptionKeyConfigured, "Configured", "Not configured"),
    boolRow("Server signing secret", enc.secretsConfigured, "Configured", "Not configured"),
    boolRow("Bridge command-signing secret", enc.bridgeSecretConfigured, "Configured", "Not configured"),
    boolRow("Email provider", enc.emailProviderConfigured, "Configured", "Not configured"),
    boolRow("Token redaction", enc.tokenRedactionActive, "Active", "Inactive"),
    boolRow("Audit redaction", enc.auditRedactionActive, "Active", "Inactive"),
    enumRow("Command signing", enc.commandSigningStatus),
    enumRow("Idempotency protection", enc.idempotencyStatus),
    enumRow("Replay protection", enc.replayProtectionStatus),
    enumRow("Prompt-injection guard", enc.promptInjectionGuardStatus),
    enumRow("Memory boundaries", enc.memoryBoundariesStatus),
    legacy,
  ];
}

// Compact Security Score + band card for the Overview tab. Self-fetches.
function SecurityScoreCard() {
  const { data, isLoading, isError, refetch } = useGetAdminSecurityOverview();
  const v = data ? toScore(data.score) : null;
  const tone = v === null ? "neutral" : confidenceTone(v);
  return (
    <Card data-testid="security-score-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Lock className="h-4 w-4" /> Security Score</CardTitle>
        <CardDescription className="text-xs">
          Weighted ARX security posture — read-only and advisory. Unknown signals score 0 and are never assumed secure.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState label="Loading security posture…" />
        ) : isError || !data ? (
          <ErrorState
            description="Could not load the security overview. This is a read-only diagnostics surface."
            onRetry={() => void refetch()}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className={`text-3xl font-bold ${v === null ? "text-muted-foreground" : STATUS_COLORS[tone].text}`}>
                {v ?? "—"}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Tone tone={securityBandTone(data.band)}>{data.band}</Tone>
                {data.lockdownActive && <Tone tone="danger">Lockdown active</Tone>}
                {data.criticalFloorHit && <Tone tone="danger">Critical floor</Tone>}
              </div>
            </div>
            <Progress value={v ?? 0} className={`h-1.5${v === null ? " opacity-40" : ""}`} />
            {data.reasons.length > 0 && (
              <p className="break-words text-[11px] text-muted-foreground">{data.reasons[0]}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Security & Encryption tab — full protection-control status. ───────────────
function SecurityEncryptionTab() {
  const { data, isLoading, isError, refetch } = useGetAdminSecurityOverview();
  if (isLoading) return <LoadingState label="Loading security & encryption status…" />;
  if (isError || !data) {
    return (
      <ErrorState
        title="Couldn't load security status"
        description="The security overview endpoint failed. This is read-only diagnostics and does not affect any trade or safety surface."
        onRetry={() => void refetch()}
      />
    );
  }
  const o = data;
  const rows = buildControlRows(o.encryption);
  const chainTone: StatusTone = !o.auditChain ? "neutral" : o.auditChain.valid ? "success" : "danger";
  const chainSub = !o.auditChain
    ? "Not computed"
    : `${o.auditChain.checked} rows checked${o.auditChain.unknownCount > 0 ? `, ${o.auditChain.unknownCount} unknown` : ""}`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ScoreCard label="Security Score" score={o.score} sub={o.band} icon={<Lock className="h-4 w-4" />} />
        <StatCard
          label="Lockdown"
          value={o.lockdownActive ? "Active" : "Clear"}
          tone={o.lockdownActive ? "danger" : "success"}
          sub={o.lockdownActive ? "Security lockdown engaged" : "No lockdown engaged"}
          icon={<ShieldAlert className="h-4 w-4" />}
        />
        <StatCard
          label="Audit chain"
          value={!o.auditChain ? "—" : o.auditChain.valid ? "Valid" : "Broken"}
          tone={chainTone}
          sub={chainSub}
          icon={<ScrollText className="h-4 w-4" />}
        />
        <StatCard
          label="Failed handshakes (24h)"
          value={o.failedHandshakes24h}
          tone={o.failedHandshakes24h > 0 ? "warning" : "success"}
          sub={o.failedHandshakes24h > 0 ? "Review the timeline" : "None in the last 24 hours"}
          icon={<GitMerge className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="h-4 w-4" /> Protection controls</CardTitle>
          <CardDescription className="text-xs">
            Boolean/enum signals only — never any secret value. Last checked {fmtTime(o.lastSecurityCheck)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
                <span className="min-w-0 break-words text-xs">{r.label}</span>
                <ControlChip state={r.state} text={r.text} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Score components</CardTitle>
          <CardDescription className="text-xs">
            The weighted components behind the Security Score. Unverified components show "—" and score 0 — never assumed secure.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {o.components.map((c) => {
            const cv = c.known ? toScore(c.score) : null;
            return (
              <div key={c.key}>
                <div className="text-[11px] text-muted-foreground break-words">{c.label}</div>
                <div className={`text-lg font-semibold ${cv === null ? "text-muted-foreground" : STATUS_COLORS[confidenceTone(cv)].text}`}>
                  {cv ?? "—"}
                </div>
                <Progress value={cv ?? 0} className={`mt-1 h-1.5${cv === null ? " opacity-40" : ""}`} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Posture reasons</CardTitle>
          <CardDescription className="text-xs">Why the score and band are where they are.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReasonList
            items={o.reasons}
            emptyTitle="No posture notes"
            emptyDesc="The security engine reported no specific notes for the current posture."
            emptyIcon={<ShieldCheck className="h-8 w-8" />}
            tone="warning"
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Security Timeline tab — redacted critical events. ─────────────────────────
const SECURITY_EVENT_FILTERS = ["ALL", "SECURITY_HANDSHAKE_FAILED", "SECURITY_LOCKDOWN", "SECURITY_REDACTION_FAILURE", "SECURITY_AUDIT_CHAIN_BREAK"] as const;

function severityTone(sev: string): StatusTone {
  switch (sev.toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "danger";
    case "MEDIUM":
    case "WARNING":
    case "WARN":
      return "warning";
    case "LOW":
    case "INFO":
      return "success";
    default:
      return "neutral";
  }
}

function SecurityTimelineTab() {
  const [filter, setFilter] = useState<(typeof SECURITY_EVENT_FILTERS)[number]>("ALL");
  const { data, isLoading, isError, refetch, isFetching } = useGetAdminSecurityTimeline(
    filter === "ALL" ? { limit: 100 } : { limit: 100, eventType: filter },
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm"><History className="h-4 w-4" /> Security timeline</CardTitle>
            <CardDescription className="text-xs">
              Recent security events, redacted before write. Messages never contain a secret value.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={(v) => setFilter(v as (typeof SECURITY_EVENT_FILTERS)[number])}>
              <SelectTrigger className="w-[200px]" data-testid="security-timeline-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SECURITY_EVENT_FILTERS.map((f) => (
                  <SelectItem key={f} value={f}>{f === "ALL" ? "All events" : f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => void refetch()} disabled={isFetching} size="sm" variant="outline" data-testid="security-timeline-refresh">
              <RefreshCw className={`mr-1 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState label="Loading security events…" />
        ) : isError || !data ? (
          <ErrorState description="Could not load the security timeline." onRetry={() => void refetch()} />
        ) : data.events.length === 0 ? (
          <EmptyState
            title="No security events"
            description="No security events have been recorded for this filter. This is the expected, healthy state."
            icon={<ShieldCheck className="h-8 w-8" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Actor</TableHead>
                  <TableHead className="hidden md:table-cell">Affected</TableHead>
                  <TableHead className="hidden lg:table-cell">Message</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.map((e: AdminSecurityTimelineEvent) => (
                  <TableRow key={e.securityEventId}>
                    <TableCell className="text-xs font-medium">{e.eventType}</TableCell>
                    <TableCell><Tone tone={severityTone(e.severity)}>{e.severity}</Tone></TableCell>
                    <TableCell className="text-xs">{e.status}</TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                      {e.actorRole || e.actorType || "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{e.affectedObject || "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-[24rem] truncate text-xs text-muted-foreground">
                      {e.message || "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{fmtTime(e.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Live Handshakes table (shared by the Handshakes tab and the drawer). ──────
function HandshakeTable({ handshakes }: { handshakes: AaciHandshakeEntry[] }) {
  if (handshakes.length === 0) {
    return (
      <EmptyState
        title="No handshakes reported"
        description="The cohesion engine returned no cross-system handshakes for this read. They appear once the contributing systems report in."
        icon={<ShieldCheck className="h-8 w-8" />}
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>System</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Score</TableHead>
            <TableHead className="text-right">Latency</TableHead>
            <TableHead className="hidden sm:table-cell">Updated</TableHead>
            <TableHead className="hidden md:table-cell">Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {handshakes.map((h) => (
            <TableRow key={h.system}>
              <TableCell className="text-xs font-medium">
                {h.system}
                {!h.required && <span className="ml-1 text-[10px] text-muted-foreground">(optional)</span>}
              </TableCell>
              <TableCell><Tone tone={HANDSHAKE_TONE[h.status]}>{h.status}</Tone></TableCell>
              <TableCell className="text-right text-xs">{toScore(h.score) ?? "—"}</TableCell>
              <TableCell className="text-right text-xs">{fmtLatency(h.latencyMs)}</TableCell>
              <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">{fmtTime(h.lastUpdated)}</TableCell>
              <TableCell className="hidden md:table-cell max-w-[20rem] truncate text-xs text-muted-foreground">{h.message || "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReasonList({
  items, emptyTitle, emptyDesc, emptyIcon, tone = "warning",
}: {
  items: string[];
  emptyTitle: string;
  emptyDesc: string;
  emptyIcon: React.ReactNode;
  tone?: StatusTone;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDesc} icon={emptyIcon} />;
  }
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${STATUS_COLORS[tone].bg} ${STATUS_COLORS[tone].border}`}>
          <span className={`mt-0.5 ${STATUS_COLORS[tone].text}`} aria-hidden="true">•</span>
          <span className="min-w-0 break-words">{it}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Decision header — recommended action + hard gate + meta. ──────────────────
function DecisionHeader({ d }: { d: AaciDecision }) {
  const aTone = actionTone(d.recommendedAction);
  const finalScore = toScore(d.finalAaciScore);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Overall AACI score</div>
          <div className={`text-3xl font-bold ${finalScore === null ? "text-muted-foreground" : STATUS_COLORS[confidenceTone(finalScore)].text}`}>
            {finalScore ?? "—"}
          </div>
        </div>
        <Separator orientation="vertical" className="hidden h-12 sm:block" />
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Recommendation</span>
            <Tone tone={aTone}>{ACTION_LABEL[d.recommendedAction] ?? d.recommendedAction}</Tone>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Hard gate</span>
            <Tone tone={d.hardGatePass ? "success" : "danger"}>{d.hardGatePass ? "PASS" : "FAIL"}</Tone>
            {d.createdAuditEvent && <span className="text-[10px] text-muted-foreground">· audit event written</span>}
          </div>
        </div>
        <div className="ml-auto text-right text-[11px] text-muted-foreground">
          <div>{d.symbol ?? "—"}{d.timeframe ? ` · ${d.timeframe}` : ""}</div>
          <div>actor: {d.actorType}</div>
          <div>read at {fmtTime(d.timestamp)}</div>
        </div>
      </div>
      {d.explanation && (
        <p className="mt-3 text-xs text-muted-foreground">{d.explanation}</p>
      )}
    </div>
  );
}

// ── Validity factors row (0..1 multiplicative). Shown as %, honest label. ─────
function ValidityFactors({ d }: { d: AaciDecision }) {
  const factors: Array<{ label: string; v: number }> = [
    { label: "Speed validity", v: d.speedValidity },
    { label: "Uncertainty confidence", v: d.uncertaintyConfidence },
    { label: "Data lineage trust", v: d.dataLineageTrust },
    { label: "Self-learning integrity", v: d.selfLearningIntegrity },
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Validity factors</CardTitle>
        <CardDescription className="text-xs">
          Multiplicative gates applied on top of the weighted sub-scores (0–100%). A low factor pulls the whole score down.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {factors.map((f) => {
          const pct = toScore(f.v * 100);
          return (
            <div key={f.label}>
              <div className="text-[11px] text-muted-foreground">{f.label}</div>
              <div className={`text-lg font-semibold ${pct === null ? "text-muted-foreground" : STATUS_COLORS[confidenceTone(pct)].text}`}>
                {pct === null ? "—" : `${pct}%`}
              </div>
              <Progress value={pct ?? 0} className={`mt-1 h-1.5${pct === null ? " opacity-40" : ""}`} />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function OverviewTab({ d, onOpenDrawer }: { d: AaciDecision; onOpenDrawer: () => void }) {
  return (
    <div className="space-y-4">
      <DecisionHeader d={d} />

      <SecurityScoreCard />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <ScoreCard label="Overall AACI" score={d.finalAaciScore} icon={<Gauge className="h-4 w-4" />} />
        <ScoreCard label="Freshness" score={d.dataFreshnessScore} icon={<Clock className="h-4 w-4" />} />
        <ScoreCard label="System Agreement" score={d.graphCohesionScore} icon={<GitMerge className="h-4 w-4" />} />
        <ScoreCard label="Risk Alignment" score={d.riskAlignmentScore} icon={<ShieldCheck className="h-4 w-4" />} />
        <ScoreCard label="Market Truth" score={d.marketTruthScore} icon={<Activity className="h-4 w-4" />} />
        <ScoreCard label="Speed" score={d.speedLatencyScore} icon={<Gauge className="h-4 w-4" />} />
        <ScoreCard label="Execution Readiness" score={d.executionReadinessScore} icon={<Workflow className="h-4 w-4" />} />
        <ScoreCard label="Audit Readiness" score={d.auditAlertReadinessScore} icon={<BellRing className="h-4 w-4" />} />
        <ScoreCard label="Learning Trust" score={d.learnedTrustScore} icon={<Brain className="h-4 w-4" />} />
        <ScoreCard
          label="Self-Learning Integrity"
          score={d.selfLearningIntegrity * 100}
          sub="Basic estimate."
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <CountCard label="Active Conflicts" count={d.systemConflicts.length} zeroNote="No active system conflicts." icon={<AlertTriangle className="h-4 w-4" />} />
        <CountCard label="Open Repairs" count={d.requiredFollowUps.length} zeroNote="No open repairs." icon={<Wrench className="h-4 w-4" />} />
      </div>

      {/* Shock Mode — honest: the AACI engine does not emit a shock-mode signal. */}
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div>
            <div className="text-xs text-muted-foreground">Shock Mode</div>
            <div className="text-lg font-semibold text-muted-foreground">Not reported</div>
          </div>
          <p className="max-w-md text-[11px] text-muted-foreground">
            The AACI engine does not currently emit a shock-mode signal. This will populate
            honestly if a shock-mode source is added — it is never inferred or invented here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Additional sub-scores</CardTitle>
          <CardDescription className="text-xs">The remaining weighted components the cohesion engine reports.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Drift", v: d.driftScore },
            { label: "Data Quality", v: d.dataQualityScore },
            { label: "UI Consistency", v: d.uiConsistencyScore },
            { label: "Explainability", v: d.explainabilityScore },
          ].map((s) => {
            const v = toScore(s.v);
            return (
              <div key={s.label}>
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
                <div className={`text-lg font-semibold ${v === null ? "text-muted-foreground" : STATUS_COLORS[confidenceTone(v)].text}`}>
                  {v ?? "—"}
                </div>
                <Progress value={v ?? 0} className={`mt-1 h-1.5${v === null ? " opacity-40" : ""}`} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ValidityFactors d={d} />

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onOpenDrawer} data-testid="cohesion-open-drawer">
          <Layers className="mr-1 h-4 w-4" /> View full breakdown
        </Button>
      </div>
    </div>
  );
}

// ── Tabs driven directly off the live decision. ───────────────────────────────
function HandshakesTab({ d }: { d: AaciDecision }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Live cross-system handshakes</CardTitle>
        <CardDescription className="text-xs">Each contributing system's readiness as the cohesion engine observed it for this read.</CardDescription>
      </CardHeader>
      <CardContent><HandshakeTable handshakes={d.handshakes} /></CardContent>
    </Card>
  );
}

function ConflictsTab({ d }: { d: AaciDecision }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Active system conflicts</CardTitle>
        <CardDescription className="text-xs">Disagreements between systems the cohesion engine detected. Advisory — adds caution, never blocks execution on its own.</CardDescription>
      </CardHeader>
      <CardContent>
        <ReasonList
          items={d.systemConflicts}
          emptyTitle="No active system conflicts"
          emptyDesc="All contributing systems currently agree for this read."
          emptyIcon={<ShieldCheck className="h-8 w-8" />}
          tone="danger"
        />
      </CardContent>
    </Card>
  );
}

function FreshnessTab({ d }: { d: AaciDecision }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
        <ScoreCard label="Freshness" score={d.dataFreshnessScore} icon={<Clock className="h-4 w-4" />} />
        <ScoreCard label="Data Quality" score={d.dataQualityScore} icon={<ShieldCheck className="h-4 w-4" />} />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Stale inputs</CardTitle>
          <CardDescription className="text-xs">Inputs the cohesion engine flagged as out-of-date for this read.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReasonList
            items={d.staleInputs}
            emptyTitle="All inputs fresh"
            emptyDesc="No contributing input was flagged as stale for this read."
            emptyIcon={<Clock className="h-8 w-8" />}
            tone="warning"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SpeedTab({ d }: { d: AaciDecision }) {
  const withLatency = d.handshakes.filter((h) => h.latencyMs != null);
  const speedValidityPct = d.speedValidity * 100;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <ScoreCard label="Speed / Latency" score={d.speedLatencyScore} icon={<Gauge className="h-4 w-4" />} />
        <ScoreCard label="Speed Validity" score={speedValidityPct} sub="Validity factor (0–100%)." icon={<Gauge className="h-4 w-4" />} />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Per-system latency</CardTitle>
          <CardDescription className="text-xs">Round-trip the cohesion engine recorded for each reporting system.</CardDescription>
        </CardHeader>
        <CardContent>
          {withLatency.length === 0 ? (
            <EmptyState
              title="No latency reported"
              description="No contributing system reported a measured latency for this read."
              icon={<Gauge className="h-8 w-8" />}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>System</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Latency</TableHead></TableRow></TableHeader>
                <TableBody>
                  {withLatency.map((h) => (
                    <TableRow key={h.system}>
                      <TableCell className="text-xs font-medium">{h.system}</TableCell>
                      <TableCell><Tone tone={HANDSHAKE_TONE[h.status]}>{h.status}</Tone></TableCell>
                      <TableCell className="text-right text-xs">{fmtLatency(h.latencyMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReconciliationTab({ d }: { d: AaciDecision }) {
  const reconHandshakes = d.handshakes.filter((h) =>
    /recon|execut|bridge|mt5|position|fill|broker/i.test(h.system),
  );
  return (
    <div className="space-y-4">
      <ScoreCard label="Execution Readiness" score={d.executionReadinessScore} icon={<Workflow className="h-4 w-4" />} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Execution &amp; reconciliation systems</CardTitle>
          <CardDescription className="text-xs">Handshakes from the systems that confirm orders, fills, and broker/position reconciliation.</CardDescription>
        </CardHeader>
        <CardContent>
          {reconHandshakes.length === 0 ? (
            <EmptyState
              title="No reconciliation systems reported"
              description="No execution or reconciliation system reported a handshake for this read."
              icon={<Workflow className="h-8 w-8" />}
            />
          ) : (
            <HandshakeTable handshakes={reconHandshakes} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AgentCohesionTab({ d }: { d: AaciDecision }) {
  const { data, isLoading, isError, refetch } = useListAdminAaciTrustScores({ entityType: "agent", limit: 100 });
  const scores = (data?.scores ?? []) as AaciTrustScore[];
  return (
    <div className="space-y-4">
      <ScoreCard label="System Agreement (graph cohesion)" score={d.graphCohesionScore} icon={<GitMerge className="h-4 w-4" />} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Per-agent learned trust</CardTitle>
          <CardDescription className="text-xs">Bayesian trust AACI has learned per agent from real, closed-trade outcomes.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingState label="Loading agent trust…" />
          ) : isError ? (
            <ErrorState description="Could not load agent trust scores." onRetry={() => void refetch()} />
          ) : scores.length === 0 ? (
            <EmptyState
              title="No agent trust learned yet"
              description="Per-agent trust appears once agents accumulate real closed-trade evidence. AACI never seeds trust without evidence."
              icon={<Bot className="h-8 w-8" />}
            />
          ) : (
            <TrustTable scores={scores} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AlertsTab({ d }: { d: AaciDecision }) {
  return (
    <div className="space-y-4">
      <ScoreCard label="Audit &amp; Alert Readiness" score={d.auditAlertReadinessScore} icon={<BellRing className="h-4 w-4" />} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Alerts pipeline</CardTitle>
          <CardDescription className="text-xs">Whether AACI can record evidence and raise alerts for this decision.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Audit event written for this read:</span>
            <Tone tone={d.createdAuditEvent ? "success" : "neutral"}>{d.createdAuditEvent ? "Yes" : "No"}</Tone>
          </div>
          <p>
            AACI writes append-only audit evidence and raises operator alerts on material
            decisions. The readiness score above reflects whether the audit/alert path is
            healthy. Alert delivery and history live on the Audit Log Center and Alerts surfaces.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function TrustTable({ scores }: { scores: AaciTrustScore[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Entity</TableHead>
            <TableHead className="text-right">Trust</TableHead>
            <TableHead className="text-right">Evidence</TableHead>
            <TableHead className="hidden sm:table-cell">Drift</TableHead>
            <TableHead className="hidden sm:table-cell">Quarantine</TableHead>
            <TableHead className="hidden md:table-cell">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scores.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="text-xs font-medium">
                <span className="text-muted-foreground">{s.entityType}:</span> {s.entityKey}
                {s.userId !== 0 && <span className="ml-1 text-[10px] text-muted-foreground">· user #{s.userId}</span>}
              </TableCell>
              <TableCell className="text-right text-xs">
                <ScoreText score={s.effectiveTrustScore} />
              </TableCell>
              <TableCell className="text-right text-xs">{s.evidenceCount}</TableCell>
              <TableCell className="hidden sm:table-cell text-xs">
                {s.driftSeverity && s.driftSeverity !== "NONE"
                  ? <Tone tone={s.driftSeverity === "SEVERE" ? "danger" : "warning"}>{s.driftSeverity}</Tone>
                  : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-xs">
                {s.quarantined ? <Tone tone="danger">Quarantined</Tone> : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{fmtTime(s.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LearningHealthTab() {
  const summary = useGetAdminAaciLearningSummary();
  const trust = useListAdminAaciTrustScores({ limit: 200 });
  const scores = (trust.data?.scores ?? []) as AaciTrustScore[];
  const s = summary.data;
  return (
    <div className="space-y-4">
      {summary.isLoading ? (
        <LoadingState label="Loading learning health…" />
      ) : summary.isError || !s ? (
        <ErrorState description="Could not load the learning summary." onRetry={() => void summary.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <CountStat label="Tracked entities" value={s.trackedEntities} tone="info" />
          <CountStat label="Quarantined" value={s.quarantinedEntities} tone={s.quarantinedEntities > 0 ? "danger" : "success"} />
          <CountStat label="Drifted" value={s.driftedEntities} tone={s.driftedEntities > 0 ? "warning" : "success"} />
          <CountStat label="Pending changes" value={s.pendingChanges} tone={s.pendingChanges > 0 ? "warning" : "neutral"} />
          <CountStat label="Applied changes" value={s.appliedChanges} tone="neutral" />
        </div>
      )}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Learned trust scores</CardTitle>
          <CardDescription className="text-xs">Every entity AACI tracks, with its learned trust, drift and quarantine state.</CardDescription>
        </CardHeader>
        <CardContent>
          {trust.isLoading ? (
            <LoadingState label="Loading trust scores…" />
          ) : trust.isError ? (
            <ErrorState description="Could not load trust scores." onRetry={() => void trust.refetch()} />
          ) : scores.length === 0 ? (
            <EmptyState
              title="No learned trust yet"
              description="AACI learns trust from real, closed-trade outcomes. Scores appear here once evidence accumulates — never seeded."
              icon={<Brain className="h-8 w-8" />}
            />
          ) : (
            <TrustTable scores={scores} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CountStat({ label, value, tone }: { label: string; value: number; tone: StatusTone }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-bold ${STATUS_COLORS[tone].text}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function AuditLogTab({ onSelectSymbol }: { onSelectSymbol: (symbol: string) => void }) {
  const decisions = useListAdminAaciDecisions({ limit: 100 });
  const changes = useListAdminAaciLearningChanges({ limit: 100 });
  const rows = (decisions.data?.decisions ?? []) as AaciDecisionListItem[];
  const changeRows = (changes.data?.changes ?? []) as AaciLearningChange[];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent AACI decisions</CardTitle>
          <CardDescription className="text-xs">
            Append-only decision evidence (newest first). Select a row to re-evaluate that symbol's full breakdown now.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {decisions.isLoading ? (
            <div className="p-4"><LoadingState label="Loading decisions…" /></div>
          ) : decisions.isError ? (
            <div className="p-4"><ErrorState description="Could not load decisions." onRetry={() => void decisions.refetch()} /></div>
          ) : rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No AACI decisions yet"
                description="AACI decisions will appear after system activity begins."
                icon={<ScrollText className="h-8 w-8" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="hidden sm:table-cell">Action</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Recommendation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.decisionId}
                      className={r.symbol ? "cursor-pointer" : ""}
                      onClick={() => r.symbol && onSelectSymbol(r.symbol)}
                      data-testid={`cohesion-decision-row-${r.decisionId}`}
                    >
                      <TableCell className="text-xs">{fmtTime(r.createdAt)}</TableCell>
                      <TableCell className="text-xs">{r.actorType}</TableCell>
                      <TableCell className="text-xs font-medium">{r.symbol ?? "—"}</TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">{r.actionRequested}</TableCell>
                      <TableCell className="text-right text-xs">
                        <ScoreText score={r.finalAaciScore} />
                      </TableCell>
                      <TableCell><Tone tone={actionTone(r.recommendedAction)}>{r.recommendedActionLabel}</Tone></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Learning change log</CardTitle>
          <CardDescription className="text-xs">Append-only trust updates, drift recommendations, quarantines, weight changes, approvals and rollbacks.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {changes.isLoading ? (
            <div className="p-4"><LoadingState label="Loading change log…" /></div>
          ) : changes.isError ? (
            <div className="p-4"><ErrorState description="Could not load the change log." onRetry={() => void changes.refetch()} /></div>
          ) : changeRows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No learning changes yet"
                description="Learning changes are recorded as AACI accumulates evidence and adjusts trust or weights."
                icon={<ScrollText className="h-8 w-8" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead className="hidden sm:table-cell">Change</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changeRows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs">{fmtTime(c.createdAt)}</TableCell>
                      <TableCell className="text-xs font-medium"><span className="text-muted-foreground">{c.entityType}:</span> {c.entityKey}</TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">{c.changeType}</TableCell>
                      <TableCell><Tone tone={changeStatusTone(c.status)}>{c.status}</Tone></TableCell>
                      <TableCell className="hidden md:table-cell max-w-[20rem] truncate text-xs text-muted-foreground">{c.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function changeStatusTone(status: AaciLearningChange["status"]): StatusTone {
  switch (status) {
    case "APPLIED":
    case "APPROVED":
      return "success";
    case "RECOMMENDED":
      return "warning";
    case "REJECTED":
    case "ROLLED_BACK":
      return "danger";
    default:
      return "neutral";
  }
}

function RepairsTab({ d }: { d: AaciDecision }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Open repairs &amp; required follow-ups</CardTitle>
        <CardDescription className="text-xs">
          Steps the cohesion engine recommends to restore full cohesion. Advisory — any action runs through its own permissioned, audited service; nothing here mutates a safety surface.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReasonList
          items={d.requiredFollowUps}
          emptyTitle="No open repairs"
          emptyDesc="The cohesion engine has no outstanding follow-ups for this read."
          emptyIcon={<Wrench className="h-8 w-8" />}
          tone="warning"
        />
      </CardContent>
    </Card>
  );
}

// ── Decision drawer — full breakdown for one symbol (live re-evaluation). ─────
function DecisionDrawerBody({ symbol }: { symbol: string }) {
  const { data, isLoading, isError, refetch } = useGetAdminAaciDecision(symbol);
  if (isLoading) return <LoadingState label={`Evaluating ${symbol}…`} />;
  if (isError || !data) return <ErrorState description={`Could not evaluate ${symbol}.`} onRetry={() => void refetch()} />;
  const d = data;
  return (
    <div className="space-y-4">
      <DecisionHeader d={d} />
      {d.hardGateFailures.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold">Hard-gate failures</div>
          <ReasonList items={d.hardGateFailures} emptyTitle="" emptyDesc="" emptyIcon={null} tone="danger" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <ScoreCard label="Freshness" score={d.dataFreshnessScore} />
        <ScoreCard label="System Agreement" score={d.graphCohesionScore} />
        <ScoreCard label="Risk Alignment" score={d.riskAlignmentScore} />
        <ScoreCard label="Market Truth" score={d.marketTruthScore} />
        <ScoreCard label="Speed" score={d.speedLatencyScore} />
        <ScoreCard label="Execution Readiness" score={d.executionReadinessScore} />
        <ScoreCard label="Drift" score={d.driftScore} />
        <ScoreCard label="Audit Readiness" score={d.auditAlertReadinessScore} />
        <ScoreCard label="Learning Trust" score={d.learnedTrustScore} />
      </div>
      <ValidityFactors d={d} />
      <div>
        <div className="mb-1 text-xs font-semibold">Handshakes</div>
        <HandshakeTable handshakes={d.handshakes} />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold">System conflicts</div>
        <ReasonList items={d.systemConflicts} emptyTitle="No active system conflicts" emptyDesc="All systems agree for this read." emptyIcon={<ShieldCheck className="h-6 w-6" />} tone="danger" />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold">Stale inputs</div>
        <ReasonList items={d.staleInputs} emptyTitle="All inputs fresh" emptyDesc="No stale inputs for this read." emptyIcon={<Clock className="h-6 w-6" />} tone="warning" />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold">Required follow-ups</div>
        <ReasonList items={d.requiredFollowUps} emptyTitle="No open repairs" emptyDesc="No outstanding follow-ups." emptyIcon={<Wrench className="h-6 w-6" />} tone="warning" />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
function SystemCohesionInner() {
  const [symbol, setSymbol] = useState<string>(COHESION_SYMBOLS[0]);
  const [drawerSymbol, setDrawerSymbol] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useGetAdminAaciDecision(symbol);
  const decision = data ?? null;

  const tabs: PageTab[] = useMemo(() => {
    if (!decision) return [];
    const d = decision;
    return [
      { id: "overview", label: "Overview", icon: <Gauge className="h-4 w-4" />, content: <OverviewTab d={d} onOpenDrawer={() => setDrawerSymbol(symbol)} /> },
      { id: "handshakes", label: "Live Handshakes", icon: <ShieldCheck className="h-4 w-4" />, content: <HandshakesTab d={d} /> },
      { id: "conflicts", label: "Conflicts", icon: <AlertTriangle className="h-4 w-4" />, content: <ConflictsTab d={d} /> },
      { id: "freshness", label: "Data Freshness", icon: <Clock className="h-4 w-4" />, content: <FreshnessTab d={d} /> },
      { id: "speed", label: "Speed / Latency", icon: <Gauge className="h-4 w-4" />, content: <SpeedTab d={d} /> },
      { id: "reconciliation", label: "Trade Reconciliation", icon: <Workflow className="h-4 w-4" />, content: <ReconciliationTab d={d} /> },
      { id: "agents", label: "Agent Cohesion", icon: <Bot className="h-4 w-4" />, content: <AgentCohesionTab d={d} /> },
      { id: "alerts", label: "Alerts Pipeline", icon: <BellRing className="h-4 w-4" />, content: <AlertsTab d={d} /> },
      { id: "learning", label: "Learning Health", icon: <Brain className="h-4 w-4" />, content: <LearningHealthTab /> },
      { id: "audit", label: "Audit Log", icon: <ScrollText className="h-4 w-4" />, content: <AuditLogTab onSelectSymbol={setDrawerSymbol} /> },
      { id: "repairs", label: "Repairs", icon: <Wrench className="h-4 w-4" />, content: <RepairsTab d={d} /> },
      { id: "security", label: "Security & Encryption", icon: <Lock className="h-4 w-4" />, content: <SecurityEncryptionTab /> },
      { id: "security-timeline", label: "Security Timeline", icon: <History className="h-4 w-4" />, content: <SecurityTimelineTab /> },
    ];
  }, [decision, symbol]);

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-system-cohesion">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Activity className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold leading-tight">System Cohesion</h1>
          <p className="text-sm text-txt-secondary">
            The operator window into ARX Adaptive Cohesion Intelligence — how well every system agrees, top to bottom. Advisory and read-only; it never gates, slows, or places a trade.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={symbol} onValueChange={setSymbol}>
            <SelectTrigger className="w-[140px]" data-testid="cohesion-symbol-select"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COHESION_SYMBOLS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={() => void refetch()} disabled={isFetching} size="sm" variant="outline" data-testid="cohesion-refresh">
            <RefreshCw className={`mr-1 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <LoadingState label={`Evaluating cohesion for ${symbol}…`} />
      ) : isError || !decision ? (
        <ErrorState
          title="Couldn't load the cohesion read"
          description={`The AACI decision endpoint failed for ${symbol}. AACI is advisory — this does not affect any trade or safety surface.`}
          onRetry={() => void refetch()}
        />
      ) : (
        <PageTabs tabs={tabs} storageKey="system-cohesion" defaultTab="overview" />
      )}

      <Sheet open={drawerSymbol != null} onOpenChange={(o) => { if (!o) setDrawerSymbol(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" data-testid="cohesion-decision-drawer">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> Decision breakdown — {drawerSymbol}</SheetTitle>
            <SheetDescription className="text-xs">
              Live re-evaluation of the full AACI decision for this symbol — current sub-scores, handshakes, conflicts and stale inputs (not a historical replay).
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {drawerSymbol && <DecisionDrawerBody symbol={drawerSymbol} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default function AdminSystemCohesion() {
  return (
    <AdminDiagnosticsGate
      pageTitle="System Cohesion"
      pageDescription="The System Cohesion operator window"
      userSafeMessage="This is an operator diagnostics surface. Your account does not require any action here."
    >
      <SystemCohesionInner />
    </AdminDiagnosticsGate>
  );
}
