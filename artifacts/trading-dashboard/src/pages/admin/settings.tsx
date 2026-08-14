import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getGetBotSettingsQueryKey, getGetRiskSettingsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-3"><CardTitle className="text-white text-base">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function AboutArxCard() {
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="about-arx-ai">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base">About ARX AI</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="text-2xl font-bold tracking-wider">ARX AI</div>
          <div className="text-foreground/80">Analyze. Risk. eXecute.</div>
          <div className="text-muted-foreground italic mt-1">The AI trading fortress built for disciplined decisions.</div>
        </div>
        <ul className="space-y-2">
          <li><strong className="text-foreground">Analyze</strong> — Understand the market before making a decision: scanner, live chart, AI ideas, opportunity & sniper scoring.</li>
          <li><strong className="text-foreground">Risk</strong> — Protect the account before any trade is accepted: Risk Governor, max-loss limits, drawdown protection, exposure control, kill switch.</li>
          <li><strong className="text-foreground">eXecute</strong> — Act only when setup, risk, and rules align: simulator trades, AI-assisted trades, live tester intents, journal, learning loop.</li>
        </ul>
        <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3 space-y-1 font-mono text-xs">
          <div>Current mode: <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">OWNER TESTER ACCESS</Badge></div>
          <div>Broker status: <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">MT5 DEFERRED</Badge></div>
          <div>Execution: Real broker execution locked until MT5 bridge connection.</div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Privacy & Global Learning section ────────────────────────────────────────
function PrivacySection() {
  const { name } = useAssistantName();
  const apiFetch = (url: string) => fetch(url, { credentials: "include" }).then(r => r.json());
  const apiPost  = (url: string, b: unknown) =>
    fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());

  const { data, refetch } = useQuery({
    queryKey: ["me", "privacy"],
    queryFn:  () => apiFetch("/api/me/privacy"),
  });

  const contributeMut = useMutation({
    mutationFn: (optIn: boolean) => apiPost("/api/me/privacy/contribute", { optIn }),
    onSuccess: () => void refetch(),
  });
  const insightsMut = useMutation({
    mutationFn: (receive: boolean) => apiPost("/api/me/privacy/insights", { receive }),
    onSuccess: () => void refetch(),
  });

  return (
    <Section title="Privacy & Global Learning">
      <div className="space-y-3">
        <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
          <div className="min-w-0 pr-3">
            <div className="text-white text-sm font-medium">Contribute to Global Learning</div>
            <div className="text-zinc-500 text-xs">Share anonymised trade outcomes (win/loss rates only — no amounts, no account data) to help improve platform-wide scanner scoring.</div>
          </div>
          <Switch
            checked={!!data?.contributeToGlobalLearning}
            onCheckedChange={(v) => contributeMut.mutate(v)}
            disabled={contributeMut.isPending}
          />
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
          <div className="min-w-0 pr-3">
            <div className="text-white text-sm font-medium">Receive Global Insights</div>
            <div className="text-zinc-500 text-xs">Allow {name} to share anonymised platform-wide patterns in her responses (e.g. "this setup has a 58% win rate across the platform").</div>
          </div>
          <Switch
            checked={data?.receiveGlobalInsights !== false}
            onCheckedChange={(v) => insightsMut.mutate(v)}
            disabled={insightsMut.isPending}
          />
        </div>
        <p className="text-zinc-600 text-xs">
          Raw trade data, account numbers, balances, and broker details are never shared. Global insights require at least 10 opted-in contributors before they appear.
        </p>
      </div>
    </Section>
  );
}

// ── TradingView Webhook section ────────────────────────────────────────────────
function TradingViewSection() {
  const apiFetch = (url: string) => fetch(url, { credentials: "include" }).then(r => r.json());
  const apiPost  = (url: string, b?: unknown) =>
    fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

  const { data: status } = useQuery({
    queryKey: ["me", "tradingview", "status"],
    queryFn:  () => apiFetch("/api/me/tradingview/status"),
  });
  const { data: tokens, refetch: refetchTokens } = useQuery({
    queryKey: ["me", "tradingview", "tokens"],
    queryFn:  () => apiFetch("/api/me/tradingview/tokens"),
  });
  const { data: alerts } = useQuery({
    queryKey: ["me", "tradingview", "alerts"],
    queryFn:  () => apiFetch("/api/me/tradingview/alerts?limit=5"),
  });

  const [newToken, setNewToken] = useState<{ token: string; webhookUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const generateMut = useMutation({
    mutationFn: () => apiPost("/api/me/tradingview/tokens", {}),
    onSuccess: (data) => { setNewToken(data); void refetchTokens(); },
  });
  const revokeMut = useMutation({
    mutationFn: (id: number) => fetch(`/api/me/tradingview/tokens/${id}`, { method: "DELETE", credentials: "include" }).then(r => r.json()),
    onSuccess: () => { setNewToken(null); void refetchTokens(); },
  });

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const activeTokens = (tokens?.tokens ?? []).filter((t: { isActive: boolean }) => t.isActive);
  const scoreColor = (s: string) => s === "STRONG" ? "text-emerald-400" : s === "MODERATE" ? "text-amber-400" : "text-zinc-400";

  return (
    <Section title="TradingView Alerts">
      <div className="space-y-4">
        <div className="text-zinc-400 text-xs leading-relaxed">
          Receive TradingView Pine Script alerts inside ARX. Alerts are scored against your history and the scanner — never auto-executed.
        </div>

        {newToken && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
            <div className="text-amber-300 text-xs font-medium">⚠ Save this webhook URL now — it won't be shown again.</div>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-zinc-900 rounded px-2 py-1 flex-1 truncate text-zinc-300">{newToken.webhookUrl}</code>
              <button
                type="button"
                onClick={() => copyUrl(newToken.webhookUrl)}
                className="shrink-0 text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1 border border-emerald-500/30 rounded"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="text-zinc-500 text-xs">Paste this URL into your TradingView alert → Webhook URL field.</div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
          >
            {generateMut.isPending ? "Generating…" : activeTokens.length > 0 ? "Regenerate Token" : "Generate Webhook Token"}
          </button>
          {activeTokens.length > 0 && (
            <button
              type="button"
              onClick={() => revokeMut.mutate(activeTokens[0].id)}
              className="text-xs px-3 py-1.5 rounded border border-red-800 bg-red-950/30 text-red-400 hover:bg-red-900/30 transition"
            >
              Revoke Token
            </button>
          )}
        </div>

        {activeTokens.length > 0 && !newToken && (
          <div className="text-xs text-zinc-500">
            Active token: <span className="font-mono text-zinc-400">{activeTokens[0].tokenMasked}</span>
            {activeTokens[0].lastUsedAt && (
              <> · Last used {new Date(activeTokens[0].lastUsedAt).toLocaleDateString()}</>
            )}
          </div>
        )}

        {(alerts?.alerts ?? []).length > 0 && (
          <div>
            <div className="text-xs text-zinc-500 mb-2">Recent alerts</div>
            <div className="space-y-1.5">
              {(alerts.alerts as Array<{ alertId: string; symbol: string | null; action: string | null; scoreLabel: string | null; overallScore: number | null; receivedAt: string }>)
                .map((a) => (
                <div key={a.alertId} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-2 py-1.5">
                  <span className="font-medium">{a.symbol ?? "—"} {a.action ?? ""}</span>
                  {a.scoreLabel && (
                    <span className={scoreColor(a.scoreLabel)}>{a.scoreLabel} ({a.overallScore}/100)</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-zinc-600 text-xs">
          TradingView JSON payload format:{" "}
          <code className="bg-zinc-800 px-1 rounded">{"{"}"ticker":"{"{{ticker}}"}","action":"{"{{strategy.order.action}}"}","price":{"{{close}}"}{"}"}</code>
        </div>
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const [enabledStrategies, setEnabledStrategies] = useState<string[]>(["trend_continuation", "break_of_structure", "liquidity_sweep", "volatility_expansion"]);
  const [newsFilter, setNewsFilter] = useState(true);
  const [sessionFilter, setSessionFilter] = useState(true);
  const [saved, setSaved] = useState(false);

  const { data: botSettings } = useQuery({
    queryKey: getGetBotSettingsQueryKey(),
    queryFn: () => fetch("/api/bot/settings").then((r) => r.json()),
  });

  const { data: riskSettings } = useQuery({
    queryKey: getGetRiskSettingsQueryKey(),
    queryFn: () => fetch("/api/risk-settings").then((r) => r.json()),
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
    setEnabledStrategies((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-zinc-400 text-sm">Configure bot strategies, risk parameters, filters, and market preferences</p>
        </div>
        {saved && <Badge className="bg-emerald-600 text-white animate-in fade-in">Saved ✓</Badge>}
      </div>

      {/* Bot Settings */}
      <Section title="Bot Settings">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Trading Mode</label>
            <div className="flex gap-2">
              {["DEMO", "LIVE"].map((m) => (
                <button key={m} onClick={() => updateBot.mutate({ mode: m })} className={cn("px-4 py-2 rounded text-sm font-semibold transition-colors", botSettings?.mode === m ? (m === "LIVE" ? "bg-red-600 text-white" : "bg-blue-600 text-white") : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700")}>
                  {m === "LIVE" ? "🔴 LIVE" : "DEMO"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Risk Mode</label>
            <div className="flex gap-2">
              {["Conservative", "Balanced", "Aggressive"].map((r) => (
                <button key={r} onClick={() => updateBot.mutate({ riskMode: r })} className={cn("px-3 py-2 rounded text-xs font-semibold transition-colors", botSettings?.riskMode === r ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700")}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Scan Interval (seconds)</label>
            <div className="flex gap-2 items-center">
              <Input type="number" defaultValue={botSettings?.scanIntervalSeconds ?? 5} min={1} max={60} className="bg-zinc-800 border-zinc-700 text-white w-28" onBlur={(e) => updateBot.mutate({ scanIntervalSeconds: parseInt(e.target.value) })} />
              <span className="text-zinc-500 text-xs">seconds between scans</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Auto-Trade</label>
            <div className="flex items-center gap-3">
              <Switch checked={botSettings?.autoTrade ?? false} onCheckedChange={(v) => updateBot.mutate({ autoTrade: v })} />
              <span className="text-zinc-400 text-xs">{botSettings?.autoTrade ? "Auto-trade enabled — bot executes signals automatically" : "Manual mode — review signals before trading"}</span>
            </div>
          </div>
        </div>
      </Section>

      {/* Symbol Selector */}
      <Section title="Symbol Configuration">
        <div className="space-y-4">
          {Object.entries(SYMBOLS_BY_MARKET).map(([market, symbols]) => (
            <div key={market}>
              <div className="text-xs text-zinc-500 font-semibold mb-2 uppercase tracking-wide">{market}</div>
              <div className="flex flex-wrap gap-2">
                {symbols.map((sym) => {
                  const isActive = botSettings?.symbol === sym;
                  return (
                    <button key={sym} onClick={() => updateBot.mutate({ symbol: sym })} className={cn("px-3 py-1.5 rounded text-xs font-medium transition-colors border", isActive ? "bg-blue-600 text-white border-blue-500" : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600 hover:text-zinc-200")}>
                      {isActive ? "✓ " : ""}{sym}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Strategy Toggles */}
      <Section title="Active Strategies">
        <div className="space-y-3">
          {ALL_STRATEGIES.map((s) => {
            const on = enabledStrategies.includes(s.id);
            return (
              <div key={s.id} className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors">
                <div>
                  <div className="text-white text-sm font-medium">{s.label}</div>
                  <div className="text-zinc-500 text-xs">{s.description}</div>
                </div>
                <Switch checked={on} onCheckedChange={() => toggleStrategy(s.id)} />
              </div>
            );
          })}
        </div>
      </Section>

      {/* Smart Filters */}
      <Section title="Smart Filters">
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
            <div>
              <div className="text-white text-sm font-medium">News Avoidance Mode</div>
              <div className="text-zinc-500 text-xs">Block forex/indices signals during high-impact news windows (08:15, 12:30, 18:45 UTC)</div>
            </div>
            <Switch checked={newsFilter} onCheckedChange={setNewsFilter} />
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
            <div>
              <div className="text-white text-sm font-medium">Session Filter</div>
              <div className="text-zinc-500 text-xs">Only allow Session Breakout strategy during London and NY opens</div>
            </div>
            <Switch checked={sessionFilter} onCheckedChange={setSessionFilter} />
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
            <div>
              <div className="text-white text-sm font-medium">No Trade Filter</div>
              <div className="text-zinc-500 text-xs">Block all signals during sideways/choppy conditions or abnormal ATR — always active</div>
            </div>
            <div className="text-emerald-400 text-xs font-semibold pr-2">Always On</div>
          </div>
        </div>
      </Section>

      {/* Risk Settings */}
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
                <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
                <Input type={type} defaultValue={riskSettings[key]} step="0.01" className="bg-zinc-800 border-zinc-700 text-white" onBlur={(e) => updateRisk.mutate({ ...riskSettings, [key]: parseFloat(e.target.value) })} />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Phase 24 — Protective Auto-Close link */}
      <Section title="Protective Auto-Close">
        <div className="text-sm space-y-2">
          <p className="text-zinc-300">
            Lets the AI close or tighten your trades when you are inactive and a reversal is confirmed.
            Default is OFF. Saving preferences does NOT unlock execution by itself — every safety gate must pass.
          </p>
          <a
            href={`${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/protective-auto-close`}
            className="inline-block text-emerald-400 hover:underline text-sm"
            data-testid="link-protective-auto-close"
          >
            Open Protective Auto-Close settings →
          </a>
        </div>
      </Section>

      {/* Privacy & Global Learning */}
      <PrivacySection />

      {/* TradingView Webhook */}
      <TradingViewSection />

      {/* MT5 Bridge */}
      <Section title="MT5 Bridge Configuration">
        <div className="bg-zinc-800/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-zinc-600" />
            <span className="text-zinc-400 text-sm">MT5 Bridge: Not Configured</span>
          </div>
          <div className="text-zinc-500 text-xs leading-relaxed">
            To connect a real MT5 bridge, set the <code className="bg-zinc-700 px-1 rounded text-zinc-300">MT5_BRIDGE_TOKEN</code> environment variable and configure your EA to send <code className="bg-zinc-700 px-1 rounded text-zinc-300">X-MT5-Bridge-Token</code> with every request. Bridge endpoints: <code className="bg-zinc-700 px-1 rounded text-zinc-300">/api/mt5/heartbeat</code>, <code className="bg-zinc-700 px-1 rounded text-zinc-300">/api/mt5/commands</code>
          </div>
          <div className="text-amber-400 text-xs">⚠ All bridge endpoints return 503 when token is not configured (fail-closed by design)</div>
        </div>
      </Section>
    </div>
  );
}
