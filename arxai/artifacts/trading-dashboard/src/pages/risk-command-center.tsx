import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Shield, Pause, Play, Gauge, SlidersHorizontal, ClipboardList, ScrollText } from "lucide-react";
import { PageTabs } from "@/components/ui/PageTabs";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { CompactAlert } from "@/components/ui/CompactAlert";
import { fetchRiskBudget, RiskBudgetReadError } from "@/lib/risk-budget";

type Settings = { maxRiskPerTradeAmount: number | null; maxDailyLossAmount: number | null; maxPositionSize: number | null; minRewardRiskRatio: number; maxTradesPerDay: number; maxOpenTrades: number };
type Limits = { maxLotSize: number; maxDailyLossPercent: number | null; maxDailyLossAmount: number | null; maxRiskPerTradePercent: number; maxRiskPerTradeAmount: number | null; discipline: { maxTradesPerDay: number | null; maxOpenTrades: number | null } };
type Profile = { preset: string; settings: Settings; effectiveLimits: Limits };
type Money = number | null;
// The *Unvalued flags: a percent cap is configured but equity is unknown, so
// the cap cannot be valued in money. Absent on an older server.
// The *RiskUsedUnmeasured flags: a cap is set but what was used against it
// could not be measured (no account or activity read), so *Used / *Remaining
// are null and mean "unknown", not 0 or "no cap".
type ValuationFlags = {
  equityKnown?: boolean; dailyRiskLimitUnvalued?: boolean; weeklyRiskLimitUnvalued?: boolean; riskStatusReason?: string | null;
  dailyRiskUsedUnmeasured?: boolean; weeklyRiskUsedUnmeasured?: boolean;
}
  // false when the server's *RiskUsed (and so *RiskRemaining) was not measured
  // (an older server sent a placeholder there), with the plain reason. Absent
  // on an older server.
  & { dailyRiskUsedKnown?: boolean; dailyRiskUsedUnknownReason?: string | null; weeklyRiskUsedKnown?: boolean; weeklyRiskUsedUnknownReason?: string | null }
  // Set when the Risk Governor counts paper losses or equity below the booked
  // figures (closed paper trades at the lower of their booked total and their
  // paper risk model total), with both figures. Absent on an older server.
  & { riskCountNote?: string | null };
type Budget = ValuationFlags & { venue: string; dailyRiskLimit: Money; dailyRiskUsed: Money; dailyRiskRemaining: Money; weeklyRiskLimit: Money; weeklyRiskUsed: Money; openRisk: number; openPositions: number; equity: Money; riskStatus: string };
type Cards = ValuationFlags & { venue: string; riskStatus: string; dailyRiskRemaining: Money; weeklyRiskRemaining: Money; openRisk: number; openPositions: number; tradesToday: number | null; consecutiveLosses: number | null; overtrading: string; activeHalts: string[]; permissions: Permissions; propFirm: PropFirmCard | null };

// equityMeasured / measured false: the figures are not measured (older servers omit them).
type PropFirmCard = { status: string; profitTargetProgress: number | null; equityMeasured?: boolean; measured?: boolean };

// permissions.trading is false when a stop switch is engaged or a loss limit
// is reached; blockedBy names which (older servers sent only trading +
// pauseReason, where trading reflected the stop switches alone).
type Permissions = { trading: boolean; pauseReason: string | null; stopSwitchEngaged?: boolean; blockedBy?: string[] };

const BLOCK_REASON: Record<string, string> = {
  stop_switch: "A stop switch is engaged",
  daily_loss_limit: "Your daily loss limit is reached",
  weekly_loss_limit: "Your weekly loss limit is reached",
  // The governor refuses new orders while the activity its caps need is unreadable.
  activity_unread: "Your recent trading activity could not be read, so your weekly loss, trade-count and loss-streak limits cannot be checked. The Risk Governor refuses new trades until it can read it",
};

/**
 * equity_exhausted in plain words, naming the equity the Risk Governor reads:
 * on PAPER the paper risk count, which can be below the booked equity the
 * paper account and the budget show (the risk status reason gives both
 * figures); on a broker venue that venue's account equity. A percent of an
 * equity at or below 0 allows no risk.
 */
function equityExhaustedText(venue: string | undefined): string {
  const effect = "so your percent risk limits leave no room for a new trade. The Risk Governor refuses new trades until";
  return venue === "PAPER"
    ? `On the paper risk count (the Risk Governor's own count, which can be below the booked equity the paper account shows), your paper account's equity is at or below zero, ${effect} that count is above zero`
    : `The ${venue ? `${venue} account equity` : "account equity"} the Risk Governor reads is at or below zero, ${effect} it is above zero`;
}

/**
 * What stops new trades, in plain words. Only ever downgrades the server's
 * answer: a BLOCK status or an active halt reads blocked even if an older
 * server said trading: true.
 */
function newTradesVerdict(c: Pick<Cards, "permissions" | "riskStatus" | "activeHalts" | "venue">): { blocked: boolean; reasons: string[] } {
  const p = c.permissions;
  const reasons = (p.blockedBy ?? []).map((b) => (b === "stop_switch" && p.pauseReason ? `${BLOCK_REASON[b]}: ${p.pauseReason}`
    : b === "equity_exhausted" ? equityExhaustedText(c.venue) : BLOCK_REASON[b] ?? b));
  if (!p.blockedBy) {
    if (p.pauseReason || c.activeHalts.length > 0) reasons.push(`A stop switch is engaged${p.pauseReason ? `: ${p.pauseReason}` : ""}`);
    if (c.riskStatus === "BLOCK" && reasons.length === 0) reasons.push("A loss limit is reached (risk status BLOCK)");
  }
  if (reasons.length === 0 && (!p.trading || c.riskStatus === "BLOCK" || c.activeHalts.length > 0)) reasons.push("Blocked (risk status " + c.riskStatus + ")");
  return { blocked: reasons.length > 0, reasons };
}

// A prop-firm status worked out from a placeholder (no paper equity measured)
// is not a measured verdict; FAILED and OFF come only from measured rules.
// A newer server says NOT_MEASURED itself (measured: false), and a reached
// target with unchecked rules is TARGET_REACHED, not a confirmed pass.
const propFirmStatusText = (pf: PropFirmCard) => {
  if (pf.status === "FAILED" || pf.status === "OFF") return pf.status;
  if (pf.equityMeasured === false) return "NOT MEASURED (no paper equity measured)";
  if (pf.status === "NOT_MEASURED" || pf.measured === false) return "NOT MEASURED";
  return pf.status === "TARGET_REACHED" ? "TARGET REACHED (not a confirmed pass)" : pf.status;
};
const propFirmProgressText = (pf: PropFirmCard) =>
  (pf.equityMeasured === false ? "Not measured (no paper equity measured)"
    : pf.profitTargetProgress == null || pf.measured === false ? "Not measured" : `${pf.profitTargetProgress}%`);

// A null money value is "no cap set" only when the server says no cap is
// configured (flag false). A percent cap with unknown equity cannot be
// valued; an amount next to one is only an upper bound. Without the flag the
// page cannot tell, so it says "not reported" rather than "none set".
function capText(v: Money, unvalued: boolean | undefined, kind: "limit" | "left", pct?: number | null, usedUnmeasured?: boolean, why?: string | null): string {
  const pctLabel = pct != null ? `${pct}% cap` : "% cap";
  if (unvalued === true) {
    if (v != null) return `$${v} or less (${pctLabel} not valued, equity unknown)`;
    return kind === "left" ? `unknown (${pctLabel}, equity unknown)` : `${pctLabel}, not valued (equity unknown)`;
  }
  if (v != null) return `$${v}`;
  if (kind === "left" && usedUnmeasured === true) return `unknown (loss used not measured${why ? `: ${why}` : ""})`;
  return unvalued === false ? "no cap set" : "not reported";
}

const equityText = (v: Money) => (v == null ? "unknown (no account equity read)" : `$${v}`);

/**
 * UNKNOWN means the server could not read your trading activity, so there is
 * no overtrading verdict to show (an older server sent NORMAL here).
 */
const overtradingLabel = (v: string) => (v === "UNKNOWN" ? "Not measured — activity could not be read" : v);

// "Used" and "left" when the server says the used figure was not measured
// (known false, or a null used figure): an older server's placeholder $0 used /
// full cap left is never shown, and null is never $0. Left is at most the cap.
const usedText = (v: Money, known: boolean | undefined, why: string | null | undefined) =>
  (known === false ? `unknown (${why ?? "not measured"})` : v == null ? "not measured" : `$${v}`);
function leftText(v: Money, unvalued: boolean | undefined, known: boolean | undefined, why: string | null | undefined, pct?: number | null, usedUnmeasured?: boolean): string {
  if (known === false && v != null) return `unknown, at most $${v} (${why ?? "risk used not measured"})`;
  return capText(v, unvalued, "left", pct, usedUnmeasured, known === false ? why : null);
}

const STATUS_COLOR: Record<string, string> = {
  OK: "bg-success/20 text-success",
  CAUTION: "bg-warning/20 text-warning",
  BLOCK: "bg-danger/20 text-danger",
  NORMAL: "bg-success/20 text-success",
  OVERTRADING_RISK: "bg-warning/20 text-warning",
  REVENGE_TRADING_RISK: "bg-danger/20 text-danger",
  HARD_BLOCK: "bg-danger/20 text-danger",
  UNKNOWN: "bg-muted text-muted-foreground",
};

// A non-2xx or unreadable response is an error, never data: an error body
// stored as state used to crash the render or stand in for real figures.
async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const body = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (!r.ok) throw new Error(body && body.error != null ? String(body.error) : `HTTP ${r.status}`);
  if (body == null || typeof body !== "object") throw new Error("the response was not readable");
  return body;
}

type Source = "profile" | "budget" | "cards";
const SOURCE_LABEL: Record<Source, string> = { profile: "Risk profile", budget: "Risk budget", cards: "Risk summary" };

// The fields the page dereferences; anything else is not a usable read.
const SHAPE_OK: Record<Source, (v: Record<string, unknown>) => boolean> = {
  profile: (v) => typeof v.effectiveLimits === "object" && v.effectiveLimits != null,
  budget: (v) => typeof v.riskStatus === "string",
  cards: (v) => typeof v.riskStatus === "string" && typeof v.permissions === "object" && v.permissions != null && Array.isArray(v.activeHalts),
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Risk Command Center — simple-first 4-tab layout.
 *   Summary — at-a-glance status, blocking alerts, budget snapshot.
 *   Limits  — risk profile preset, max-risk/day/lot/RR limits, budget detail.
 *   Rules   — permission booleans + active risk locks.
 *   Audit   — pause/resume/reset controls, risk-event log, profile editor.
 *
 * Everything here is YOUR account: presets write into your own risk
 * settings, which the Risk Governor enforces on every order (an admin or
 * platform limit always wins if it is stricter). Pause engages your own kill
 * switch; it never halts other traders.
 */
export default function RiskCommandCenter() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [cards, setCards] = useState<Cards | null>(null);
  const [pauseReason, setPauseReason] = useState("Manual pause");
  // Per source: why the latest read failed, and when the last good read landed.
  const [loadErrors, setLoadErrors] = useState<Partial<Record<Source, string>>>({});
  const [lastRead, setLastRead] = useState<Partial<Record<Source, number>>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    const paths: Record<Source, string> = { profile: "/api/risk-profile", budget: "/api/risk/budget", cards: "/api/risk/dashboard-cards" };
    const order: Source[] = ["profile", "budget", "cards"];
    const results = await Promise.allSettled(order.map(async (src) => {
      // The budget goes through the shared account-scoped read the workspace
      // uses too (fetchRiskBudget, same /api/risk/budget route). Its failure
      // is named the way the other sources name theirs: the server's {error}
      // text, the HTTP status, or an unreadable response.
      const body = src === "budget"
        ? (await fetchRiskBudget().catch((e: unknown) => {
            throw e instanceof RiskBudgetReadError ? new Error(e.reason) : e;
          })) as unknown as Record<string, unknown> | null
        : await api(paths[src]);
      if (body == null || typeof body !== "object") throw new Error("the response was not readable");
      if (!SHAPE_OK[src](body)) throw new Error("the response did not have the expected fields");
      return body;
    }));
    const now = Date.now();
    const errs: Partial<Record<Source, string>> = {};
    const reads: Partial<Record<Source, number>> = {};
    results.forEach((r, i) => {
      const src = order[i]!;
      if (r.status === "rejected") { errs[src] = errText(r.reason); return; }
      reads[src] = now;
      if (src === "profile") setProfile(r.value as unknown as Profile);
      else if (src === "budget") setBudget(r.value as unknown as Budget);
      else setCards(r.value as unknown as Cards);
    });
    setLoadErrors(errs);
    setLastRead((prev) => ({ ...prev, ...reads }));
  }
  useEffect(() => { void load(); const id = setInterval(() => { void load(); }, 4000); return () => clearInterval(id); }, []);

  // A control whose request fails says so; the server did not confirm it.
  async function runAction(label: string, path: string, init: RequestInit) {
    setActionError(null);
    try { await api(path, init); }
    catch (e) { setActionError(`${label} failed: ${errText(e)}. The server did not confirm the change.`); }
    void load();
  }
  async function applyPreset(preset: string) { await runAction(`Applying ${preset}`, `/api/risk-profile/preset/${preset}`, { method: "POST" }); }
  async function pause() { await runAction("Pause my trading", "/api/risk/pause", { method: "POST", body: JSON.stringify({ reason: pauseReason }) }); }
  async function resume() { await runAction("Resume", "/api/risk/resume", { method: "POST" }); }

  const failed = (Object.keys(loadErrors) as Source[]);
  const stale = (src: Source) => loadErrors[src] != null && lastRead[src] != null;
  // A section whose source has no successful read says so: a failed read is
  // never shown as "none", an empty list or blank limits.
  const unreadText = (src: Source) => (loadErrors[src] != null
    ? `${SOURCE_LABEL[src]} could not be loaded (${loadErrors[src]}).`
    : `Loading ${SOURCE_LABEL[src].toLowerCase()}…`);

  // ---- Tab contents -----------------------------------------------------

  const summaryTab = (
    <div className="space-y-3" data-testid="risk-summary-tab">
      {cards?.permissions.pauseReason && (
        <CompactAlert
          tone="danger"
          title="New trades are halted on your account"
          description={cards.permissions.pauseReason}
          details={<p>If this is your own pause, resume it from the Audit tab. Closing positions stays available.</p>}
          testId="risk-paused-alert"
        />
      )}

      {cards && (
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
          <Stat label="Daily risk left" value={leftText(cards.dailyRiskRemaining, cards.dailyRiskLimitUnvalued, cards.dailyRiskUsedKnown, cards.dailyRiskUsedUnknownReason, profile?.effectiveLimits.maxDailyLossPercent, cards.dailyRiskUsedUnmeasured)} />
          <Stat label="Weekly risk left" value={leftText(cards.weeklyRiskRemaining, cards.weeklyRiskLimitUnvalued, cards.weeklyRiskUsedKnown, cards.weeklyRiskUsedUnknownReason, null, cards.weeklyRiskUsedUnmeasured)} />
          <Stat label="Open risk" value={`$${cards.openRisk}`} />
          <Stat label="Open positions" value={String(cards.openPositions)} />
          <Stat label="Trades today" value={cards.tradesToday == null ? "—" : String(cards.tradesToday)} />
          <Stat label="Losses in a row" value={cards.consecutiveLosses == null ? "—" : String(cards.consecutiveLosses)} />
          <Stat label="Overtrading" value={overtradingLabel(cards.overtrading)} />
          <Stat label="Active halts" value={cards.activeHalts.length === 0 ? "none" : String(cards.activeHalts.length)} />
        </div>
      )}

      {cards && cards.activeHalts.length > 0 && (
        <CompactAlert
          tone="warning"
          title={`${cards.activeHalts.length} active stop switch${cards.activeHalts.length === 1 ? "" : "es"}`}
          description={cards.activeHalts.join(", ")}
          testId="risk-active-locks"
        />
      )}
    </div>
  );

  const limitsTab = (
    <div className="space-y-3" data-testid="risk-limits-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your risk profile{profile ? ` · ${profile.preset}` : ""}</CardTitle>
          <CardDescription data-testid="risk-profile-limits">
            {profile ? (
              <>In force (strictest of yours, admin and platform): max lot {profile.effectiveLimits.maxLotSize} · risk/trade {profile.effectiveLimits.maxRiskPerTradePercent}%{profile.effectiveLimits.maxRiskPerTradeAmount != null ? ` or $${profile.effectiveLimits.maxRiskPerTradeAmount}` : ""} · daily loss {profile.effectiveLimits.maxDailyLossPercent ?? "—"}%{profile.effectiveLimits.maxDailyLossAmount != null ? ` or $${profile.effectiveLimits.maxDailyLossAmount}` : ""} · trades/day {profile.effectiveLimits.discipline.maxTradesPerDay ?? "—"} · open trades {profile.effectiveLimits.discipline.maxOpenTrades ?? "—"} · min R:R {profile.settings.minRewardRiskRatio}</>
            ) : unreadText("profile")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {["ULTRA_CONSERVATIVE", "CONSERVATIVE", "BALANCED_TESTER", "AGGRESSIVE_SIMULATOR", "PROP_FIRM_CHALLENGE"].map((p) => (
            <Button
              key={p}
              size="sm"
              variant={profile?.preset === p ? "default" : "outline"}
              onClick={() => applyPreset(p)}
              data-testid={`risk-preset-${p}`}
            >{p}</Button>
          ))}
        </CardContent>
      </Card>

      {budget && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Risk Budget</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <Stat label="Daily limit" value={capText(budget.dailyRiskLimit, budget.dailyRiskLimitUnvalued, "limit", profile?.effectiveLimits.maxDailyLossPercent)} />
            <Stat label="Daily used" value={usedText(budget.dailyRiskUsed, budget.dailyRiskUsedKnown, budget.dailyRiskUsedUnknownReason)} />
            <Stat label="Weekly limit" value={capText(budget.weeklyRiskLimit, budget.weeklyRiskLimitUnvalued, "limit")} />
            <Stat label="Weekly used" value={usedText(budget.weeklyRiskUsed, budget.weeklyRiskUsedKnown, budget.weeklyRiskUsedUnknownReason)} />
            <Stat label="Open risk" value={`$${budget.openRisk}`} />
            <Stat label="Equity" value={equityText(budget.equity)} />
            <Stat label="Venue" value={budget.venue} />
            <Stat label="Status" value={budget.riskStatus} />
            {budget.riskCountNote && (
              <p className="col-span-2 md:col-span-4 text-xs text-muted-foreground" data-testid="risk-budget-count-note">{budget.riskCountNote}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );

  const rulesTab = (
    <div className="space-y-3" data-testid="risk-rules-tab">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>What stops new trades on your account right now: your stop switches, your daily and weekly loss limits, an account equity at or below zero, and trading activity that could not be read while a limit needs it. Every order is still checked by the Risk Governor against all of your rules.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {cards ? (() => {
            const v = newTradesVerdict(cards);
            return v.blocked ? (
              <div data-testid="risk-perm-new-trades">
                <Badge variant="destructive">New trades: blocked</Badge>
                <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            ) : cards.riskStatus === "UNKNOWN" || cards.riskStatusReason ? (
              // A loss limit that could not be valued or measured is not "not
              // reached": say only what was checked.
              <div data-testid="risk-perm-new-trades">
                <Badge variant="outline">New trades: not blocked by a stop switch; a loss limit could not be checked</Badge>
                <p className="mt-1 text-xs text-muted-foreground">{cards.riskStatusReason ?? "Risk status is UNKNOWN."} Each order is still checked by the Risk Governor when you place it.</p>
              </div>
            ) : (
              <div data-testid="risk-perm-new-trades">
                <Badge variant="outline">New trades: not blocked by a stop switch or loss limit</Badge>
                <p className="mt-1 text-xs text-muted-foreground">This is not an approval: each order is still checked by the Risk Governor when you place it.</p>
              </div>
            );
          })() : <p className="text-xs text-muted-foreground" data-testid="risk-perm-unread">{unreadText("cards")}</p>}
        </CardContent>
      </Card>

      <CollapsibleSection
        title="Prop-firm rules"
        description={!cards ? unreadText("cards") : cards.propFirm ? `Status ${propFirmStatusText(cards.propFirm)}` : "Open only when a prop-firm challenge is active."}
        storageKey="risk.propFirm"
        testId="risk-propfirm-section"
      >
        {!cards ? (
          <p className="text-xs text-muted-foreground">{unreadText("cards")}</p>
        ) : cards.propFirm ? (
          <div className="text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span className="font-mono">{propFirmStatusText(cards.propFirm)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Profit target progress</span><span className="font-mono">{propFirmProgressText(cards.propFirm)}</span></div>
            <Link className="text-xs underline text-primary block mt-2" href="/prop-firm-mode">Open prop-firm mode →</Link>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No active prop-firm challenge. Open <Link href="/prop-firm-mode" className="underline">prop-firm mode</Link> to enroll.</p>
        )}
      </CollapsibleSection>
    </div>
  );

  const auditTab = (
    <div className="space-y-3" data-testid="risk-audit-tab">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Controls</CardTitle>
          <CardDescription className="text-xs">Pause engages your own kill switch: new trades on your account stop on every venue, closing stays open. It never affects other traders.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="pause reason"
            data-testid="risk-pause-reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={pause} variant="destructive" size="sm" data-testid="risk-btn-pause"><Pause className="h-4 w-4 mr-1" />Pause my trading</Button>
            <Button onClick={resume} variant="outline" size="sm" data-testid="risk-btn-resume"><Play className="h-4 w-4 mr-1" />Resume</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Audit links</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <Link className="underline text-primary" href="/risk-events">Risk events log →</Link>
          <Link className="underline text-primary" href="/risk-profile">Edit profile JSON →</Link>
          <Link className="underline text-primary" href="/audit-log">Full audit log →</Link>
          <Link className="underline text-primary" href="/risk-settings">Detailed risk settings →</Link>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="space-y-4 pb-32 md:pb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className="h-6 w-6 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-bold">Risk Command Center</h1>
          <p className="text-xs md:text-sm text-muted-foreground">Your limits and budget as the Risk Governor enforces them.</p>
        </div>
        {cards && <Badge variant="outline" className="text-[11px]">{cards.venue}</Badge>}
        {cards && <Badge className={`text-[11px] ${STATUS_COLOR[cards.riskStatus] ?? ""}`} data-testid="risk-status-badge">{cards.riskStatus}{stale("cards") ? ` · as of ${clock(lastRead.cards!)}` : ""}</Badge>}
      </div>
      {failed.length > 0 && (
        <CompactAlert
          tone={failed.some((s) => lastRead[s] == null) ? "danger" : "warning"}
          title={failed.some((s) => lastRead[s] == null) ? "Some risk data could not be loaded" : "Some risk data could not be refreshed"}
          description={failed.map((s) => `${SOURCE_LABEL[s]} could not be ${lastRead[s] == null ? "loaded" : "refreshed"} (${loadErrors[s]})${lastRead[s] != null ? `; figures shown are the last successful read, from ${clock(lastRead[s]!)}` : ""}.`).join(" ")}
          testId="risk-load-error"
        />
      )}
      {actionError && <CompactAlert tone="danger" title={actionError} testId="risk-action-error" />}
      {cards?.riskStatusReason && (
        <p className="text-xs text-muted-foreground" data-testid="risk-status-reason">{cards.riskStatusReason}</p>
      )}
      {cards?.riskCountNote && (
        <p className="text-xs text-muted-foreground" data-testid="risk-count-note">{cards.riskCountNote}</p>
      )}

      <PageTabs
        storageKey="risk-command-center"
        defaultTab="summary"
        tabs={[
          { id: "summary", label: "Summary", icon: <Gauge className="h-3.5 w-3.5" />,            content: summaryTab },
          { id: "limits",  label: "Limits",  icon: <SlidersHorizontal className="h-3.5 w-3.5" />, content: limitsTab },
          { id: "rules",   label: "Rules",   icon: <ClipboardList className="h-3.5 w-3.5" />,    content: rulesTab },
          { id: "audit",   label: "Audit",   icon: <ScrollText className="h-3.5 w-3.5" />,       content: auditTab },
        ]}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2">
    <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
    <p className="text-sm font-mono font-semibold">{value}</p>
  </CardContent></Card>;
}
