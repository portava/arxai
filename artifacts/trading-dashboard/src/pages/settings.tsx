import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGetBotSettingsQueryKey,
  getGetRiskSettingsQueryKey,
  getGetMeAssistantSettingsQueryKey,
  useUpdateMeAssistantSettings,
  useChangeMyPassword,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { cn } from "@/lib/utils";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useProductRole } from "@/hooks/useProductRole";
import { OneClickToggleCard } from "@/components/mt5/OneClickToggleCard";
import {
  useAssistantName,
  validateAssistantName,
  DEFAULT_ASSISTANT_NAME,
} from "@/lib/assistant-name";

const SYMBOLS_BY_MARKET = {
  "Synthetic Indices": ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
  "Forex Majors": ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"],
  "Forex Minors": ["EURJPY", "GBPJPY", "EURGBP", "AUDJPY", "CADJPY", "EURCAD"],
  "Global Indices": ["US30", "NAS100", "SPX500", "GER40", "UK100", "JP225"],
  "Stocks": ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "JPM"],
};

const ALL_STRATEGIES = [
  { id: "trend_continuation", label: "Trend Continuation", description: "EMA 20/50/200 alignment + RSI filter" },
  { id: "break_of_structure", label: "Break of Structure", description: "Swing high/low breakout confirmation" },
  { id: "liquidity_sweep", label: "Liquidity Sweep Reversal", description: "Wick rejection from swept levels" },
  { id: "volatility_expansion", label: "Volatility Expansion", description: "ATR expansion with body ratio filter" },
  { id: "pullback_continuation", label: "Pullback Continuation", description: "EMA20 zone pullback in trend" },
  { id: "mean_reversion", label: "Mean Reversion", description: "Range extreme RSI + wick reversal" },
  { id: "session_breakout", label: "Session Breakout", description: "London/NY open Asia range breakout" },
];

const DEFAULT_ENABLED_STRATEGIES = ["trend_continuation", "break_of_structure", "liquidity_sweep", "volatility_expansion"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
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
    <div className="rounded-2xl border border-border bg-card p-4" data-testid="assistant-name-card">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">AI Assistant</h3>
        {savedName && (
          <Badge className="animate-in fade-in bg-success/15 text-success border-success/30">Saved ✓</Badge>
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
              className="bg-secondary border-border text-foreground sm:max-w-xs"
              data-testid="input-assistant-name"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="bg-primary text-white hover:bg-primary/90"
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
    <div className="rounded-2xl border border-border bg-card p-4" data-testid="change-password-card">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Password</h3>
        {saved && (
          <Badge className="animate-in fade-in bg-success/15 text-success border-success/30">
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
            className="bg-secondary border-border text-foreground sm:max-w-xs"
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
            className="bg-secondary border-border text-foreground sm:max-w-xs"
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
            className="bg-secondary border-border text-foreground sm:max-w-xs"
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
          className="bg-primary text-white hover:bg-primary/90"
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
    ? "bg-danger/15 text-danger border-danger/30"
    : mode.isDemo
      ? "bg-primary/15 text-primary border-primary/30"
      : "bg-ruby/15 text-ruby border-ruby/30";
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid="about-arx-ai">
      <h3 className="mb-3 text-sm font-semibold text-foreground">About ARX AI</h3>
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
        <div className="space-y-1 rounded-xl border border-border bg-background/40 p-3 text-xs">
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

// Only routes inside the relevant role allowlist (see routeAccess.ts) so a
// link never bounces the user to a redirect/404. Investors are confined to
// /my-account, /help, /settings, /investor — so they never see the /alerts link.
const ACCOUNT_LINKS: { href: string; label: string; desc: string; investorSafe: boolean }[] = [
  { href: "/my-account", label: "My Account", desc: "Profile, bridge preference, and account details", investorSafe: true },
  { href: "/alerts", label: "Alerts & Notifications", desc: "Review alerts and notification activity", investorSafe: false },
  { href: "/help", label: "Help & Guides", desc: "How ARX works and how to get support", investorSafe: true },
];

function AccountLinksCard({ isInvestor }: { isInvestor: boolean }) {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
  const links = ACCOUNT_LINKS.filter((l) => !isInvestor || l.investorSafe);
  return (
    <Section title="More Account Settings">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {links.map((l) => (
          <a
            key={l.href}
            href={`${base}${l.href}`}
            className="block rounded-xl border border-border bg-background/40 p-3 transition-colors hover:border-primary/40"
            data-testid={`link-account-${l.href.replace(/\//g, "")}`}
          >
            <div className="text-sm font-medium text-foreground">{l.label}</div>
            <div className="text-xs text-txt-muted">{l.desc}</div>
          </a>
        ))}
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const mode = useTradingMode();
  const { isInvestor } = useProductRole();
  const [saved, setSaved] = useState(false);

  const { data: botSettings } = useQuery({
    queryKey: getGetBotSettingsQueryKey(),
    queryFn: () => fetch("/api/bot/settings").then((r) => r.json()),
    enabled: !isInvestor,
  });

  // Filters are persisted in bot_settings and read straight from the query, so
  // they survive a refresh (toggle → PATCH → invalidate → re-read on load).
  const enabledStrategies: string[] = botSettings?.enabledStrategies ?? DEFAULT_ENABLED_STRATEGIES;
  const newsFilter: boolean = botSettings?.newsFilter ?? true;
  const sessionFilter: boolean = botSettings?.sessionFilter ?? true;

  const { data: riskSettings } = useQuery({
    queryKey: getGetRiskSettingsQueryKey(),
    queryFn: () => fetch("/api/risk-settings").then((r) => r.json()),
    enabled: !isInvestor,
  });

  const updateBot = useMutation({
    mutationFn: (body: object) => fetch("/api/bot/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: getGetBotSettingsQueryKey() }); },
  });

  const updateRisk = useMutation({
    mutationFn: (body: object) => fetch("/api/risk-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: getGetRiskSettingsQueryKey() }); setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });

  function toggleStrategy(id: string) {
    const current: string[] = botSettings?.enabledStrategies ?? DEFAULT_ENABLED_STRATEGIES;
    const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
    updateBot.mutate({ enabledStrategies: next });
  }

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold leading-tight">Settings</h1>
        <p className="text-sm text-txt-secondary">
          {isInvestor
            ? "Your account overview and help. Trading configuration is managed by your operator."
            : "Configure bot strategies, risk parameters, filters, and market preferences"}</p>
      </div>
      {saved && <Badge className="animate-in fade-in bg-success/15 text-success border-success/30">Saved ✓</Badge>}
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
        <AccountLinksCard isInvestor={isInvestor} />
      </div>
    ),
  };

  // Investors are view-only: they never see bot/strategy/risk/connection
  // trade configuration. They get the Profile tab only.
  if (isInvestor) {
    return (
      <div className="mx-auto w-full max-w-[1280px] space-y-5 p-4 md:p-6 pb-32 md:pb-6">
        {header}
        <PageTabs tabs={[profileTab]} storageKey="settings-investor" />
      </div>
    );
  }

  const tradingTab: PageTab = {
    id: "trading",
    label: "Trading",
    content: (
      <div className="space-y-6">
        <Section title="Bot Settings">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-txt-secondary mb-1 block">Trading Mode</label>
              <div className="flex gap-2">
                {["DEMO", "LIVE"].map((m) => (
                  <button key={m} onClick={() => updateBot.mutate({ mode: m })} className={cn("px-4 py-2 rounded text-sm font-semibold transition-colors", botSettings?.mode === m ? (m === "LIVE" ? "bg-danger text-white" : "bg-primary text-white") : "bg-secondary text-txt-secondary hover:bg-secondary/80")}>
                    {m === "LIVE" ? "🔴 LIVE" : "DEMO"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-txt-secondary mb-1 block">Risk Mode</label>
              <div className="flex gap-2">
                {["Conservative", "Balanced", "Aggressive"].map((r) => (
                  <button key={r} onClick={() => updateBot.mutate({ riskMode: r })} className={cn("px-3 py-2 rounded text-xs font-semibold transition-colors", botSettings?.riskMode === r ? "bg-ruby text-white" : "bg-secondary text-txt-secondary hover:bg-secondary/80")}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-txt-secondary mb-1 block">Scan Interval (seconds)</label>
              <div className="flex gap-2 items-center">
                <Input type="number" defaultValue={botSettings?.scanIntervalSeconds ?? 5} min={1} max={60} className="bg-secondary border-border text-foreground w-28" onBlur={(e) => updateBot.mutate({ scanIntervalSeconds: parseInt(e.target.value) })} />
                <span className="text-txt-muted text-xs">seconds between scans</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-txt-secondary mb-1 block">Auto-Trade</label>
              <div className="flex items-center gap-3">
                <Switch checked={botSettings?.autoTrade ?? false} onCheckedChange={(v) => updateBot.mutate({ autoTrade: v })} />
                <span className="text-txt-secondary text-xs">{botSettings?.autoTrade ? "Auto-trade enabled — bot executes signals automatically" : "Manual mode — review signals before trading"}</span>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Smart Filters">
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-background/40">
              <div>
                <div className="text-foreground text-sm font-medium">News Avoidance Mode</div>
                <div className="text-txt-muted text-xs">Block forex/indices signals during high-impact news windows (08:15, 12:30, 18:45 UTC)</div>
              </div>
              <Switch checked={newsFilter} onCheckedChange={(v) => updateBot.mutate({ newsFilter: v })} />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-background/40">
              <div>
                <div className="text-foreground text-sm font-medium">Session Filter</div>
                <div className="text-txt-muted text-xs">Only allow Session Breakout strategy during London and NY opens</div>
              </div>
              <Switch checked={sessionFilter} onCheckedChange={(v) => updateBot.mutate({ sessionFilter: v })} />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-background/40">
              <div>
                <div className="text-foreground text-sm font-medium">No Trade Filter</div>
                <div className="text-txt-muted text-xs">Block all signals during sideways/choppy conditions or abnormal ATR — always active</div>
              </div>
              <div className="text-success text-xs font-semibold pr-2">Always On</div>
            </div>
          </div>
        </Section>

        <OneClickToggleCard />
      </div>
    ),
  };

  const strategiesTab: PageTab = {
    id: "strategies",
    label: "Strategies",
    content: (
      <div className="space-y-6">
        <Section title="Symbol Configuration">
          <div className="space-y-4">
            {Object.entries(SYMBOLS_BY_MARKET).map(([market, symbols]) => (
              <div key={market}>
                <div className="text-xs text-txt-muted font-semibold mb-2 uppercase tracking-wide">{market}</div>
                <div className="flex flex-wrap gap-2">
                  {symbols.map((sym) => {
                    const isActive = botSettings?.symbol === sym;
                    return (
                      <button key={sym} onClick={() => updateBot.mutate({ symbol: sym })} className={cn("px-3 py-1.5 rounded text-xs font-medium transition-colors border", isActive ? "bg-primary text-white border-primary/50" : "bg-secondary text-txt-secondary border-border hover:border-border hover:text-txt-secondary")}>
                        {isActive ? "✓ " : ""}{sym}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Active Strategies">
          <div className="space-y-3">
            {ALL_STRATEGIES.map((s) => {
              const on = enabledStrategies.includes(s.id);
              return (
                <div key={s.id} className="flex items-center justify-between p-3 rounded-lg bg-background/40 hover:border-primary/40 transition-colors">
                  <div>
                    <div className="text-foreground text-sm font-medium">{s.label}</div>
                    <div className="text-txt-muted text-xs">{s.description}</div>
                  </div>
                  <Switch checked={on} onCheckedChange={() => toggleStrategy(s.id)} />
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    ),
  };

  const riskTab: PageTab = {
    id: "risk",
    label: "Risk",
    content: (
      <div className="space-y-6">
        <Section title="Risk Parameters">
          {riskSettings && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { key: "maxDailyLoss", label: "Max Daily Loss ($)", type: "number" },
                { key: "maxDrawdown", label: "Max Drawdown (%)", type: "number" },
                { key: "defaultLotSize", label: "Default Lot Size", type: "number" },
                { key: "maxOpenTrades", label: "Max Open Trades", type: "number" },
                { key: "riskPerTrade", label: "Risk Per Trade (%)", type: "number" },
                { key: "minConfidence", label: "Min Confidence (%)", type: "number" },
              ].map(({ key, label, type }) => (
                <div key={key}>
                  <label className="text-xs text-txt-secondary mb-1 block">{label}</label>
                  <Input type={type} defaultValue={riskSettings[key]} step="0.01" className="bg-secondary border-border text-foreground" onBlur={(e) => updateRisk.mutate({ ...riskSettings, [key]: parseFloat(e.target.value) })} />
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Protective Auto-Close">
          <div className="text-sm space-y-2">
            <p className="text-txt-secondary">
              Lets the AI close or tighten your trades when you are inactive and a reversal is confirmed.
              Default is OFF. Saving preferences does NOT unlock execution by itself — every safety gate must pass.
            </p>
            <a
              href={`${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/protective-auto-close`}
              className="inline-block text-success hover:underline text-sm"
              data-testid="link-protective-auto-close"
            >
              Open Protective Auto-Close settings →
            </a>
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
            <div className="bg-success/10 border border-success/40 rounded-lg p-4 space-y-2" data-testid="mt5-bridge-shared-active">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-success" />
                <span className="text-success text-sm font-semibold">Shared master bridge: Active</span>
              </div>
              <div className="text-txt-secondary text-xs leading-relaxed">
                Your trades route through the shared master MT5 bridge. You don&apos;t need to configure a personal MT5 EA — it&apos;s already handled by your operator.
              </div>
              <div className="text-txt-muted text-[11px]">
                You can optionally set up a personal MT5 bridge as an alternative on <a className="underline" href="/my-account">My Account → Bridge Preference</a>.
              </div>
            </div>
          ) : (
            <div className="bg-background/40 rounded-lg p-4 space-y-3" data-testid="mt5-bridge-not-configured">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-secondary" />
                <span className="text-txt-secondary text-sm">Personal MT5 bridge: Not configured</span>
              </div>
              <div className="text-txt-muted text-xs leading-relaxed">
                Generate a per-user bridge token from <a className="underline" href="/mt5-setup">MT5 Setup</a> and paste it into your EA inputs. Personal MT5 bridge is optional — most users route through the shared master in live mode.
              </div>
            </div>
          )}
        </Section>
      </div>
    ),
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-5 p-4 md:p-6 pb-32 md:pb-6">
      {header}
      <PageTabs
        tabs={[profileTab, tradingTab, strategiesTab, riskTab, connectionsTab]}
        storageKey="settings"
      />
    </div>
  );
}
