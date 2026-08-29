import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeAssistantSettingsQueryKey,
  useUpdateMeAssistantSettings,
  useChangeMyPassword,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { STATUS_COLORS } from "@/lib/design-tokens";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";
import { useViewMode } from "@/hooks/useViewMode";
import { useToast } from "@/hooks/use-toast";
import { OneClickToggleCard } from "@/components/mt5/OneClickToggleCard";
import { RiskLimitsEditor } from "@/components/risk/RiskLimitsEditor";
import {
  useAssistantName,
  validateAssistantName,
  DEFAULT_ASSISTANT_NAME,
} from "@/lib/assistant-name";

// RANK 15: the symbol grid (SYMBOLS_BY_MARKET) and the seven-strategy list
// (ALL_STRATEGIES / DEFAULT_ENABLED_STRATEGIES) that used to live here backed
// the Strategies tab. Both wrote bot_settings.symbol / bot_settings.
// enabledStrategies, which no scanner, decision or execution path reads. The
// tab and its data are removed rather than left as a convincing but inert
// control panel.

// The RISK_FIELDS list moved to components/risk/RiskLimitsEditor.tsx, where it
// lives next to the save-outcome handling it needs (rank 16). Both this page
// and /risk-settings render that one component so the two cannot drift.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm">
      <h3 className="mb-4 text-base font-semibold tracking-tight text-foreground">{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function AssistantNameCard() {
  const qc = useQueryClient();
  const { name, isLoading, isDefault } = useAssistantName();
  const [value, setValue] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [savedName, setSavedName] = useState(false);

  // Seed the input once the per-user setting has loaded: show the custom name
  // when one is set, otherwise leave it blank so the placeholder (the default)
  // is visible.
  useEffect(() => {
    if (!isLoading && !seeded) {
      setValue(isDefault ? "" : name);
      setSeeded(true);
    }
  }, [isLoading, isDefault, name, seeded]);

  const update = useUpdateMeAssistantSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMeAssistantSettingsQueryKey() });
        setSavedName(true);
        setTimeout(() => setSavedName(false), 2000);
      },
    },
  });

  const trimmed = value.trim();
  const validation = trimmed.length === 0 ? null : validateAssistantName(value);
  const inlineError = validation && !validation.ok ? validation.message : null;
  const canSave = trimmed.length > 0 && !inlineError && !update.isPending;

  function handleSave() {
    const result = validateAssistantName(value);
    if (!result.ok) return;
    update.mutate({ data: { displayName: result.value } });
  }

  function handleReset() {
    setValue("");
    update.mutate({ data: { displayName: null } });
  }

  return (
    <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm" data-testid="assistant-name-card">
      <div className="mb-4 flex items-center gap-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">AI Assistant</h3>
        {savedName && (
          <Badge className={`animate-in fade-in ${STATUS_COLORS.success.badge}`}>Saved ✓</Badge>
        )}
      </div>
      <div className="space-y-3 text-sm">
        <p className="text-txt-secondary">
          Personalize your AI assistant&apos;s name. This changes only what it&apos;s called for
          you — its abilities, safety, and trading rules are unchanged.
        </p>
        <div>
          <label htmlFor="assistant-name-input" className="text-xs text-txt-secondary mb-1 block">
            Assistant name
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="assistant-name-input"
              value={value}
              placeholder={DEFAULT_ASSISTANT_NAME}
              maxLength={24}
              onChange={(e) => setValue(e.target.value)}
              className="sm:max-w-xs"
              data-testid="input-assistant-name"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                data-testid="button-save-assistant-name"
              >
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleReset}
                disabled={update.isPending || (isDefault && trimmed.length === 0)}
                data-testid="button-reset-assistant-name"
              >
                Reset
              </Button>
            </div>
          </div>
          {inlineError ? (
            <div className="mt-1 text-xs text-danger" data-testid="assistant-name-error">{inlineError}</div>
          ) : (
            <div className="mt-1 text-xs text-txt-muted">
              2–24 characters. Letters, numbers, spaces, apostrophes, and hyphens. Leave blank and
              Reset to restore the default ({DEFAULT_ASSISTANT_NAME}).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const change = useChangeMyPassword({
    mutation: {
      onSuccess: () => {
        setCurrent("");
        setNext("");
        setConfirm("");
        setServerError(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      },
      onError: (err: unknown) => {
        const message =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Could not change your password. Please try again.";
        setServerError(message);
      },
    },
  });

  const newTooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsCurrent = next.length > 0 && current.length > 0 && next === current;
  const inlineError = newTooShort
    ? "Your new password must be at least 8 characters."
    : sameAsCurrent
      ? "Your new password must be different from your current password."
      : mismatch
        ? "The new passwords do not match."
        : null;

  const canSubmit =
    current.length > 0 &&
    next.length >= 8 &&
    next === confirm &&
    !sameAsCurrent &&
    !change.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setServerError(null);
    change.mutate({ data: { currentPassword: current, newPassword: next } });
  }

  return (
    <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm" data-testid="change-password-card">
      <div className="mb-4 flex items-center gap-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">Password</h3>
        {saved && (
          <Badge className={`animate-in fade-in ${STATUS_COLORS.success.badge}`}>
            Changed ✓
          </Badge>
        )}
      </div>
      <form className="space-y-3 text-sm" onSubmit={handleSubmit}>
        <p className="text-txt-secondary">
          Change your account password. You&apos;ll stay signed in on this device; any other
          devices will be signed out.
        </p>
        <div>
          <label htmlFor="current-password-input" className="text-xs text-txt-secondary mb-1 block">
            Current password
          </label>
          <Input
            id="current-password-input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="sm:max-w-xs"
            data-testid="input-current-password"
          />
        </div>
        <div>
          <label htmlFor="new-password-input" className="text-xs text-txt-secondary mb-1 block">
            New password
          </label>
          <Input
            id="new-password-input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="sm:max-w-xs"
            data-testid="input-new-password"
          />
        </div>
        <div>
          <label htmlFor="confirm-password-input" className="text-xs text-txt-secondary mb-1 block">
            Confirm new password
          </label>
          <Input
            id="confirm-password-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="sm:max-w-xs"
            data-testid="input-confirm-password"
          />
        </div>
        {inlineError ? (
          <div className="text-xs text-danger" data-testid="change-password-inline-error">
            {inlineError}
          </div>
        ) : (
          <div className="text-xs text-txt-muted">At least 8 characters.</div>
        )}
        {serverError && (
          <div className="text-xs text-danger" data-testid="change-password-server-error">
            {serverError}
          </div>
        )}
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid="button-change-password"
        >
          {change.isPending ? "Changing…" : "Change password"}
        </Button>
      </form>
    </div>
  );
}

function AboutArxCard() {
  const mode = useTradingMode();
  const badgeClass = mode.isLiveShared
    ? STATUS_COLORS.danger.badge
    : mode.isDemo
      ? "bg-primary/10 text-primary border-primary/25"
      : STATUS_COLORS.info.badge;
  return (
    <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm" data-testid="about-arx-ai">
      <h3 className="mb-4 text-base font-semibold tracking-tight text-foreground">About ARX AI</h3>
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-2xl font-bold tracking-wider">ARX AI</div>
          <div className="text-txt-secondary">Analyze. Risk. eXecute.</div>
          <div className="mt-1 italic text-txt-muted">The AI trading fortress built for disciplined decisions.</div>
        </div>
        <ul className="space-y-2 text-txt-secondary">
          <li><strong className="text-foreground">Analyze</strong> — Understand the market before making a decision: scanner, live chart, AI ideas, opportunity & sniper scoring.</li>
          <li><strong className="text-foreground">Risk</strong> — Protect the account before any trade is accepted: Risk Governor, max-loss limits, drawdown protection, exposure control, kill switch.</li>
          <li><strong className="text-foreground">eXecute</strong> — Act only when setup, risk, and rules align: review and confirm trades, AI-assisted trades, live shared dispatch, journal, learning loop.</li>
        </ul>
        <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs">
          <div className="flex items-center gap-2">Current mode: <Badge className={badgeClass} data-testid="about-mode-badge">{mode.cleanModeLabel}</Badge></div>
          <div className="text-txt-muted">{mode.cleanUserMessage}</div>
          {mode.cleanBlockedReason && (
            <div className="text-warning">{mode.cleanBlockedReason}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// RANK 76 — "Only routes inside the relevant role allowlist" was the intent
// here, and it was true for INVESTOR but not for the two human-trader tiers:
// `/alerts` is on the APPROVED allowlist only, so a PENDING trader opening
// Settings saw "Alerts & Notifications", clicked it, and was silently bounced
// back to the cockpit. Each link now declares the lowest tier that can actually
// reach it, and the filter honours it. Pinned by inAppHrefAllowlist.test.ts.
const ACCOUNT_LINKS: {
  href: string; label: string; desc: string;
  investorSafe: boolean;
  /** true when the target is on the APPROVED allowlist only. */
  approvedOnly?: boolean;
}[] = [
  { href: "/my-account", label: "My Account", desc: "Profile, bridge preference, and account details", investorSafe: true },
  { href: "/notifications", label: "Notifications", desc: "Your alert history and delivery preferences", investorSafe: false },
  { href: "/alerts", label: "Alerts", desc: "Review and acknowledge your open alerts", investorSafe: false, approvedOnly: true },
  { href: "/help", label: "Help & Guides", desc: "How ARX works and how to get support", investorSafe: true },
];

function AccountLinksCard({ isInvestor, isApprovedTrader }: { isInvestor: boolean; isApprovedTrader: boolean }) {
  const links = ACCOUNT_LINKS
    .filter((l) => !isInvestor || l.investorSafe)
    .filter((l) => !l.approvedOnly || isApprovedTrader);
  return (
    <Section title="More Account Settings">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {links.map((l) => (
          // wouter <Link>, not a full page reload — these are in-app routes.
          <Link
            key={l.href}
            href={l.href}
            className="block rounded-lg bg-muted/40 p-3 transition-colors hover:bg-muted/70"
            data-testid={`link-account-${l.href.replace(/\//g, "")}`}
          >
            <div className="text-sm font-medium text-foreground">{l.label}</div>
            <div className="text-xs text-txt-muted">{l.desc}</div>
          </Link>
        ))}
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const mode = useTradingMode();
  const { isInvestor } = useProductRole();
  const { effectiveIsAdmin } = useViewMode();
  const { isApprovedTrader: approvedTier } = useTraderTier();
  // Admins bypass both trader tiers, exactly as RouteAccessGuard does.
  const isApprovedTrader = effectiveIsAdmin || approvedTier;
  const { toast } = useToast();
  const [saved, setSaved] = useState(false);

  // The /api/bot/settings query, its PATCH mutation and toggleStrategy() were
  // removed with the Trading/Strategies controls above: every one of them wrote
  // to a store with no reader. Nothing on this page reads bot_settings now.

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          {isInvestor
            ? "Your account overview and help. Trading configuration is managed by your operator."
            : "Your profile, risk limits, and connection settings."}</p>
      </div>
      {saved && <Badge className={`animate-in fade-in ${STATUS_COLORS.success.badge}`}>Saved ✓</Badge>}
    </div>
  );

  // Profile tab — visible to everyone, including view-only investors. Contains
  // no trade controls.
  const profileTab: PageTab = {
    id: "profile",
    label: "Profile",
    content: (
      <div className="space-y-6">
        <AboutArxCard />
        <AssistantNameCard />
        <ChangePasswordCard />
        <AccountLinksCard isInvestor={isInvestor} isApprovedTrader={isApprovedTrader} />
      </div>
    ),
  };

  // Investors are view-only: they never see bot/strategy/risk/connection
  // trade configuration. They get the Profile tab only.
  if (isInvestor) {
    return (
      <div className="mx-auto w-full max-w-[1280px] space-y-6">
        {header}
        <PageTabs tabs={[profileTab]} storageKey="settings-investor" />
      </div>
    );
  }

  // RANK 15 (high) — the Trading and Strategies tabs were an entire fake bot.
  //
  // THE DEFECT
  //   Every control on both tabs PATCHed /api/bot/settings, which writes
  //   `bot_settings` and echoes the row straight back. Nothing reads that table.
  //   A repo-wide grep for `botSettingsTable` outside routes/bot.ts returns
  //   exactly three hits: trades.ts:3 (an import), trades.ts:302
  //   (`void botSettingsTable;` — a deliberate unused-var suppression) and
  //   tradeDecision.ts:33 (imported, never referenced). routes/learning.ts:351
  //   already says it outright: mutating them "would only pretend the bot
  //   changed behavior".
  //
  //   So a user could switch a red 🔴 LIVE trading mode, enable Auto-Trade, set
  //   a 5-second scan interval and pick strategies; the buttons lit up and the
  //   values survived a refresh — and no scanner, decision or execution path
  //   read a single one of them. They believed they had armed an automated bot
  //   that does not exist, and — far worse on a platform that dispatches real
  //   orders — that they could DISARM it the same way.
  //
  // WHY THESE CONTROLS ARE GONE RATHER THAN REWORDED
  //   A disclaimer under a working-looking 🔴 LIVE button is not honesty; the
  //   button still reads as an arming control. Wiring bot_settings into the
  //   scanner/decision/execution path is a real feature, not a copy fix, and it
  //   is not this change. So the inert controls are removed and replaced by the
  //   truth plus the surfaces that ARE real: mode is read-only here (it is set
  //   by your operator, and /api/me/account-mode is its single source), and
  //   risk lives on the Risk tab, which writes per-user risk_settings that the
  //   gate chain genuinely enforces.
  //
  //   The Strategies tab is removed for the same reason: symbol selection and
  //   the seven strategy switches wrote `bot_settings.symbol` /
  //   `enabledStrategies`, which nothing consumes.
  const tradingTab: PageTab = {
    id: "trading",
    label: "Trading",
    content: (
      <div className="space-y-6">
        <Section title="Your trading mode">
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-txt-secondary">Current mode:</span>
              {mode.envelope ? (
                <Badge
                  className={mode.isLiveShared ? STATUS_COLORS.danger.badge : mode.isDemo ? "bg-primary/10 text-primary border-primary/25" : STATUS_COLORS.info.badge}
                  data-testid="settings-mode-badge"
                >
                  {mode.cleanModeLabel}
                </Badge>
              ) : (
                <Badge className={STATUS_COLORS.warning.badge} data-testid="settings-mode-unknown">
                  Unavailable
                </Badge>
              )}
            </div>
            <p className="text-txt-secondary">
              {mode.envelope
                ? mode.cleanUserMessage
                : "Your trading mode could not be read right now. This is not a statement that trading is off — it means we could not determine your mode."}
            </p>
            {mode.cleanBlockedReason && <p className="text-warning text-xs">{mode.cleanBlockedReason}</p>}
            <p className="text-txt-muted text-xs">
              Trading mode is set by your operator, not from this page. There is no switch here that
              can arm or disarm live execution — see <Link className="underline" href="/my-account">My Account</Link> for
              your permissions and <Link className="underline" href="/help">Help</Link> for the full gate chain.
            </p>
          </div>
        </Section>

        <Section title="Automation">
          <div className="space-y-2 text-sm">
            <p className="text-txt-secondary">
              This page has no automation controls. An Auto-Trade switch, a scan interval and a
              DEMO/LIVE selector used to live here; they wrote to a settings row that no scanner,
              decision or execution path reads, so they never armed or disarmed anything.
            </p>
            <p className="text-txt-muted text-xs">
              The controls that do take effect are your per-user risk limits on the Risk tab, and
              the emergency stop at <Link className="underline" href="/emergency">Emergency Stop</Link>.
            </p>
          </div>
        </Section>

        <OneClickToggleCard />
      </div>
    ),
  };

  const riskTab: PageTab = {
    id: "risk",
    label: "Risk",
    content: (
      <div className="space-y-6">
        <Section title="Risk Parameters">
          <RiskLimitsEditor />
        </Section>

        <Section title="Protective Auto-Close">
          <div className="text-sm space-y-2">
            <p className="text-txt-secondary">
              Lets the AI close or tighten your trades when you are inactive and a reversal is confirmed.
              Default is OFF. Saving preferences does NOT unlock execution by itself — every safety gate must pass.
            </p>
            {/* RANK 76: this was a plain <a href> full page load to a path on
                no trader allowlist — the reload landed on RouteAccessGuard,
                which bounced the user straight back to the cockpit. wouter
                <Link> now; /protective-auto-close is allowlisted for APPROVED
                traders, so the link is gated on that tier rather than shown to
                a pending trader who would just be redirected home. */}
            {isApprovedTrader ? (
              <Link
                href="/protective-auto-close"
                className="inline-block text-primary hover:underline text-sm"
                data-testid="link-protective-auto-close"
              >
                Open Protective Auto-Close settings →
              </Link>
            ) : (
              <p className="text-xs text-txt-muted">
                Protective Auto-Close becomes available once your account is approved for trading.
              </p>
            )}
          </div>
        </Section>
      </div>
    ),
  };

  const connectionsTab: PageTab = {
    id: "connections",
    label: "Connections",
    content: (
      <div className="space-y-6">
        {/* MT5 Bridge — mode-aware. In LIVE_SHARED, the shared master
            bridge is active. Personal MT5 bridge setup is then only an
            optional alternative, not the headline status. */}
        <Section title="MT5 Bridge Configuration">
          {mode.isLiveShared ? (
            <div className="bg-success/10 border border-success/25 rounded-lg p-4 space-y-2" data-testid="mt5-bridge-shared-active">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-success" />
                <span className="text-success text-sm font-semibold">Shared master bridge: Active</span>
              </div>
              <div className="text-txt-secondary text-xs leading-relaxed">
                Your trades route through the shared master MT5 bridge. You don&apos;t need to configure a personal MT5 EA — it&apos;s already handled by your operator.
              </div>
              <div className="text-txt-muted text-[11px]">
                You can optionally set up a personal MT5 bridge as an alternative on <Link className="underline" href="/my-account">My Account → Bridge Preference</Link>.
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/40 p-4 space-y-3" data-testid="mt5-bridge-not-configured">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-secondary" />
                <span className="text-txt-secondary text-sm">Personal MT5 bridge: Not configured</span>
              </div>
              <div className="text-txt-muted text-xs leading-relaxed">
                {isApprovedTrader ? (
                  <>Generate a per-user bridge token from <Link className="underline" href="/mt5-setup">MT5 Setup</Link> and paste it into your EA inputs. Personal MT5 bridge is optional — most users route through the shared master in live mode.</>
                ) : (
                  <>Bridge setup becomes available once your account is approved for trading. A personal MT5 bridge is optional — most users route through the shared master in live mode.</>
                )}
              </div>
            </div>
          )}
        </Section>
      </div>
    ),
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      {header}
      <PageTabs
        tabs={[profileTab, tradingTab, riskTab, connectionsTab]}
        storageKey="settings"
      />
    </div>
  );
}
