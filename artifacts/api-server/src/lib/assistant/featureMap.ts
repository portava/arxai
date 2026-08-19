// ARX AI canonical feature registry.
//
// Phase 22H — single source of truth for "what does this app do",
// "where is X", "is feature Y live", "what setup is missing".
// Consumed by:
//   - getAppFeatureMap (legacy, kept for backward compat)
//   - getAppFeatureRegistry  (Phase 22H)
//   - getFeatureHelp         (Phase 22H)
//   - getCurrentPageHelp     (Phase 22H)
//   - explainFeature         (legacy, kept for backward compat)
//
// HONESTY RULES (do not violate when adding entries):
//   - status: "live" = code wired (UI + backend) AND every maintainer-side
//     secret it depends on is currently present on this deployment AND
//     the feature is operational right now. Any server secret a feature
//     depends on MUST be named explicitly by env-var name in
//     `requiredSetup` (e.g. "AI_INTEGRATIONS_OPENAI_API_KEY"). Per-user
//     actions (e.g. "Browser microphone permission", "User saves risk
//     limits") may also be listed in `requiredSetup` — they are useful
//     setup context and do not change the live-vs-partial classification.
//   - status: "partial" = code exists but a maintainer-side secret OR
//     external system that the feature requires is NOT guaranteed on
//     this deployment (e.g. MT5 bridge needs a per-user bridge token + EA
//     registration; market data needs a provider key; push needs VAPID
//     keys). If you mark partial, name the missing dependency.
//   - status: "disabled" when intentionally locked (e.g. live order
//     execution is controlled by the admin-set platform trading mode).
//   - status: "planned" when not yet implemented.
//   - status: "needsQA" when implemented but not user-verified.
//   - Never mark live trading "live".
//   - Never include secrets, tokens, raw env values, or hashes here.

export type FeatureStatus = "live" | "partial" | "disabled" | "planned" | "needsQA";

export interface FeatureEntry {
  // Legacy shape (still used by getAppFeatureMap + explainFeature).
  key: string;
  name: string;
  route: string;
  summary: string;
  tags: string[];
}

export interface FeatureRegistryEntry {
  featureId: string;
  featureName: string;
  userFacingName: string;
  shortDescription: string;
  fullDescription: string;
  route: string | null;
  frontendComponent: string | null;
  backendEndpoints: string[];
  requiredAuth: boolean;
  requiredSetup: string[];
  status: FeatureStatus;
  whereToFindIt: string;
  relatedFeatures: string[];
  safetyNotes: string;
  emptyStateBehavior: string;
  lastVerifiedAt: string;
}

// Build/registry stamp. Use a stable date string so deterministic output
// per build — not Date.now() (would change per request).
const REGISTRY_BUILT_AT = "2026-05-15T00:00:00.000Z";

// ── Rich registry (Phase 22H) ────────────────────────────────────────────
export const ARX_FEATURE_REGISTRY: FeatureRegistryEntry[] = [
  {
    featureId: "ai_assistant",
    featureName: "AI Assistant",
    userFacingName: "ARX AI Assistant",
    shortDescription: "In-app AI assistant for app help, status, journal review and pre-trade risk checks.",
    fullDescription: "User-scoped streaming chat with tool calling. Answers questions about the app, the user's setup, market provider status, MT5 bridge, risk limits, journal, and prop firm mode. Can prepare and submit demo/live order requests, but every order goes through the backend guard chain and may be rejected.",
    route: null,
    frontendComponent: "ArxAssistantLivePanel",
    backendEndpoints: ["/api/me/assistant/conversations", "/api/me/assistant/conversations/:id/messages", "/api/me/assistant/tools", "/api/me/assistant/provider-status"],
    requiredAuth: true,
    requiredSetup: ["AI_INTEGRATIONS_OPENAI_API_KEY (server-only) for AI provider"],
    status: "live",
    whereToFindIt: "Floating ARX AI button (bottom-right) on every page after sign-in.",
    relatedFeatures: ["live_ai_chat", "voice_input", "speech_output", "assistant_provider"],
    safetyNotes: "Paper-only. Cannot execute trades. Tools are user-scoped — never returns another user's data. Does not return secrets.",
    emptyStateBehavior: "If AI provider is not configured, the assistant clearly says it is unavailable and surfaces no fake replies.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "live_ai_chat",
    featureName: "Live AI Chat",
    userFacingName: "Live chat",
    shortDescription: "Streaming text replies with tool calling.",
    fullDescription: "POST to /api/me/assistant/conversations/:id/messages opens a Server-Sent-Events stream of token-level content plus tool-call events. Tool dispatch runs server-side and is user-scoped.",
    route: null,
    frontendComponent: "ArxAssistantLivePanel",
    backendEndpoints: ["/api/me/assistant/conversations/:id/messages"],
    requiredAuth: true,
    requiredSetup: ["AI_INTEGRATIONS_OPENAI_API_KEY (server secret, provisioned via Replit AI Integrations proxy)"],
    status: "live",
    whereToFindIt: "Inside the ARX AI assistant popup — type and press Enter.",
    relatedFeatures: ["ai_assistant", "assistant_provider"],
    safetyNotes: "Provider key is backend-only; never exposed to the browser.",
    emptyStateBehavior: "If provider unavailable the stream sends an explicit error event and the UI shows an unavailable state — no fake reply.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "voice_input",
    featureName: "Voice Input",
    userFacingName: "Talk to ARX",
    shortDescription: "Push-to-record + optional auto-listen voice input.",
    fullDescription: "Microphone audio is uploaded as multipart to /api/me/assistant/conversations/:id/voice. Server transcribes and processes through the same assistant pipeline. Mic is popup-scoped only.",
    route: null,
    frontendComponent: "ArxAssistantLivePanel + useAutoListen + useVoiceRecorder",
    backendEndpoints: ["/api/me/assistant/conversations/:id/voice"],
    requiredAuth: true,
    requiredSetup: ["Browser microphone permission (user gesture required)", "AI_INTEGRATIONS_OPENAI_API_KEY (server secret, used for transcription via Replit AI Integrations proxy)"],
    status: "live",
    whereToFindIt: "Mic button inside the ARX AI assistant popup. Auto-listen toggle is opt-in (default off).",
    relatedFeatures: ["live_ai_chat", "speech_output"],
    safetyNotes: "Mic is acquired only inside the assistant popup and fully released when the popup closes. No background or page-wide listening.",
    emptyStateBehavior: "If mic permission is denied the UI shows the denied state and the AI explains how to re-enable it in browser settings.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "speech_output",
    featureName: "Speech Output",
    userFacingName: "ARX speaks back",
    shortDescription: "Text-to-speech for assistant replies.",
    fullDescription: "Browser SpeechSynthesis (TTS) reads assistant replies aloud when speech mode is enabled. Realtime WebRTC voice falls back to gpt-audio degraded mode when OPENAI_API_KEY is not configured.",
    route: null,
    frontendComponent: "ArxAssistantLivePanel + useSpeakResponses",
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["Browser speech synthesis support"],
    status: "live",
    whereToFindIt: "Speaker toggle inside the ARX AI assistant popup.",
    relatedFeatures: ["voice_input", "live_ai_chat"],
    safetyNotes: "Speech is paused while the user is speaking to avoid echo.",
    emptyStateBehavior: "If the browser does not support SpeechSynthesis the speaker control is disabled with a tooltip.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "assistant_provider",
    featureName: "AI Provider",
    userFacingName: "AI provider",
    shortDescription: "Backend OpenAI provider wiring.",
    fullDescription: "The assistant chat completions and tool calling go through the OpenAI client supplied by Replit AI Integrations (AI_INTEGRATIONS_OPENAI_API_KEY). The key is server-only and never exposed to the browser. Optional direct OPENAI_API_KEY enables true Realtime WebRTC voice.",
    route: null,
    frontendComponent: null,
    backendEndpoints: ["/api/me/assistant/provider-status", "/api/me/assistant/voice-status"],
    requiredAuth: true,
    requiredSetup: ["AI_INTEGRATIONS_OPENAI_API_KEY (Replit AI integration)", "OPENAI_API_KEY (optional, for true Realtime WebRTC)"],
    status: "live",
    whereToFindIt: "Backend only. Status surfaced via /api/me/assistant/provider-status.",
    relatedFeatures: ["live_ai_chat", "voice_input"],
    safetyNotes: "Provider keys are never exposed to the frontend, never logged, never returned by any tool.",
    emptyStateBehavior: "If no provider key is configured, provider-status returns configured:false and the assistant honestly reports unavailability.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "mt5_bridge",
    featureName: "MT5 Bridge",
    userFacingName: "MT5 connection",
    shortDescription: "Per-user MT5 EA bridge for account/positions sync.",
    fullDescription: "Bridge endpoints accept heartbeat, command queue polling, and account/positions sync from a Metatrader 5 Expert Advisor. Auth is per-user only: every EA endpoint requires the per-user bridge token issued from the MT5 Setup page and rejects the legacy server-wide MT5_BRIDGE_TOKEN env value. Fail-closed: requests without an active per-user token are rejected with 401.",
    route: "/mt5-bridge",
    frontendComponent: "MT5Bridge page (also /mt5-status, /mt5-setup)",
    backendEndpoints: ["/api/mt5/heartbeat", "/api/mt5/commands", "/api/mt5/command-result", "/api/mt5/sync-account", "/api/mt5/sync-positions"],
    requiredAuth: true,
    requiredSetup: ["Per-user bridge token issued from the MT5 Setup page (POST /api/me/mt5-connections) — the EA's BridgeToken input must be this personal token. The legacy server-wide MT5_BRIDGE_TOKEN env value is rejected on every EA endpoint, including /heartbeat.", "Install ARX EA in MT5 and register a per-user bridge connection to get your personal token"],
    status: "partial",
    whereToFindIt: "MT5 Bridge page in the main navigation (/mt5-bridge).",
    relatedFeatures: ["mt5_heartbeat", "order_execution_lock", "paper_demo_mode"],
    safetyNotes: "Bridge cannot place real orders from the assistant. Order execution is system-locked separately.",
    emptyStateBehavior: "If no per-user bridge token has been issued or no EA has connected, the page shows a not-connected state with setup instructions.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "mt5_heartbeat",
    featureName: "MT5 Heartbeat",
    userFacingName: "MT5 health",
    shortDescription: "Live freshness signal for MT5 bridge connections.",
    fullDescription: "Tracks last heartbeat per user-bridge pair. Reports healthy / stale / unhealthy / unknown.",
    route: "/mt5-bridge",
    frontendComponent: "MT5Bridge page (also exposed at /mt5-status)",
    backendEndpoints: ["/api/mt5/heartbeat"],
    requiredAuth: true,
    requiredSetup: ["Per-user bridge token issued from the MT5 Setup page", "Active EA sending heartbeats"],
    status: "partial",
    whereToFindIt: "MT5 Bridge page health card and inside ARX AI assistant via 'is the bridge alive?'.",
    relatedFeatures: ["mt5_bridge"],
    safetyNotes: "Heartbeat alone never authorizes order execution.",
    emptyStateBehavior: "Returns status:'unknown' when no heartbeat has ever been received.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "paper_demo_mode",
    featureName: "Paper / Demo Mode",
    userFacingName: "Paper trading",
    shortDescription: "Default trading mode — simulator with no real broker calls.",
    fullDescription: "Trade flows in ARX AI run in the platform's current trading mode (Trading Off, Demo Trading Active, or Live Trading Active), which is set by the admin and per-user. P&L, account snapshot, and journal entries reflect whichever mode is in effect.",
    route: "/bot-control",
    frontendComponent: "Bot Control page + simulator",
    backendEndpoints: ["/api/me/account/snapshot", "/api/me/positions", "/api/me/journal"],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Bot Control page and Account dashboard.",
    relatedFeatures: ["read_only_mode", "order_execution_lock", "risk_guard"],
    safetyNotes: "All numbers shown are simulator-only, not real broker results.",
    emptyStateBehavior: "Fresh users see zero trades, zero P&L — never invented history.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "read_only_mode",
    featureName: "Read-Only Mode",
    userFacingName: "Read-only safety",
    shortDescription: "All assistant tools and bridge endpoints are read-only by default.",
    fullDescription: "Assistant tools never mutate user data. Bridge endpoints accept telemetry but do not execute orders. Enforced in code, not by configuration.",
    route: null,
    frontendComponent: null,
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Enforced everywhere — no UI control.",
    relatedFeatures: ["order_execution_lock", "paper_demo_mode"],
    safetyNotes: "Cannot be disabled from the UI or assistant.",
    emptyStateBehavior: "N/A — always on.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "order_execution_lock",
    featureName: "Order Execution Lock",
    userFacingName: "Live trading lock",
    shortDescription: "Live broker order execution is system-locked.",
    fullDescription: "The assistant submits order requests through the backend guard chain (runOrderGuards → broker placement layer). It cannot bypass any gate. The per-user trading envelope is returned with every assistant response and reflects the live admin-set platform mode.",
    route: null,
    frontendComponent: null,
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: [],
    status: "disabled",
    whereToFindIt: "Enforced everywhere. Surfaced in the safety envelope returned by the assistant.",
    relatedFeatures: ["paper_demo_mode", "read_only_mode"],
    safetyNotes: "Intentionally disabled. Live execution requires a separate broker integration that has not been built.",
    emptyStateBehavior: "N/A — feature is intentionally off.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "one_click_trading",
    featureName: "One-Click Trading (ARX Single Confirm)",
    userFacingName: "ARX Single Confirm (One-Click)",
    shortDescription: "Per-user setting that lets one click trading place a BUY/SELL straight from the chart with a single confirm. This is an ARX app setting, NOT the MT5 terminal's One Click Trading checkbox (which ARX cannot read and does not require).",
    fullDescription: "ARX Single Confirm (also called one-click trading in the app) is a per-user toggle stored in user_one_click_settings. When ON, opening a BUY or SELL from the chart needs only a single confirm instead of a full ticket. It has a separate demo toggle and live toggle. Flipping a toggle ON is the user's standing consent — no typed phrase is required. Enabling the LIVE scope additionally requires per-user master-live access (approved + armed). Reduce-only actions (close, partial close, modify SL/TP) are never gated by this setting. IMPORTANT: this is completely separate from the MetaTrader 5 terminal's own 'One Click Trading' checkbox (Options → Trade) — MQL5 does not expose that checkbox to the EA, so ARX cannot read it and never requires it. Enabling ARX Single Confirm does NOT bypass any safety gate: every live order still passes the full 16-gate Phase B dispatch chain server-side, and the assistant still cannot place orders.",
    route: "/mt5-setup",
    frontendComponent: "OneClickToggleCard (on the MT5 Setup page, the Settings → Trading tab, and the My Account page)",
    backendEndpoints: ["/api/me/one-click", "/api/me/one-click/submit-live"],
    requiredAuth: true,
    requiredSetup: ["To enable EITHER scope (demo or live): flip the switch ON in the One-Click Trade card — that is your standing consent (no typed phrase required)", "For the LIVE scope additionally: per-user master-live access (approved + armed)"],
    status: "live",
    whereToFindIt: "The 'ARX Single Confirm (One-Click)' card on the MT5 Setup page (/mt5-setup), the Settings page Trading tab (/settings), or the My Account page (/my-account).",
    relatedFeatures: ["mt5_bridge", "risk_guard", "order_execution_lock"],
    safetyNotes: "Bypasses no safety gate. Live one-click orders still pass all 16 Phase B gates. The assistant cannot toggle it or place orders. Do not confuse it with the MT5 terminal One Click Trading checkbox, which ARX cannot read.",
    emptyStateBehavior: "If the user has never set it, both demo and live one-click default to OFF; the card shows OFF with enable controls.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "risk_guard",
    featureName: "Risk Guard",
    userFacingName: "Risk Settings",
    shortDescription: "User-configured risk limits enforced by the simulator.",
    fullDescription: "Per-user risk limits: max loss, lot size cap, daily loss cap, confidence threshold, cooldown.",
    route: "/risk-settings",
    frontendComponent: "Risk Settings page",
    backendEndpoints: ["/api/me/risk/limits"],
    requiredAuth: true,
    requiredSetup: ["User saves their risk limits at least once"],
    status: "live",
    whereToFindIt: "Risk Settings page in main navigation.",
    relatedFeatures: ["pre_trade_risk_check", "prop_firm_mode"],
    safetyNotes: "Limits apply to the paper simulator only.",
    emptyStateBehavior: "Fresh users see hasRiskSettings:false and the assistant says risk profile is not configured yet.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "pre_trade_risk_check",
    featureName: "Pre-Trade Risk Check",
    userFacingName: "Risk preview",
    shortDescription: "Advisory check that a planned trade would pass the risk governor.",
    fullDescription: "Returns wouldPass + blockingReasons[] + warnings[]. Does NOT execute anything.",
    route: "/risk-settings",
    frontendComponent: "Risk Settings page (preview) + assistant tool",
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["Risk limits configured"],
    status: "live",
    whereToFindIt: "Ask the assistant 'would this trade pass risk?'.",
    relatedFeatures: ["risk_guard"],
    safetyNotes: "Advisory only. Never claims a trade is 'safe'.",
    emptyStateBehavior: "If risk limits not set, returns blockingReason 'risk_not_configured'.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "prop_firm_mode",
    featureName: "Prop Firm Mode",
    userFacingName: "Prop firm challenge mode",
    shortDescription: "Prop-firm-style profit target + drawdown rules layered on the simulator.",
    fullDescription: "Per-user toggle. When enabled, tracks profit target, daily drawdown remaining, total drawdown remaining, and pass/fail status. Numbers are paper/simulator only.",
    route: "/risk-settings",
    frontendComponent: "Risk Settings page (prop firm card)",
    backendEndpoints: ["/api/me/prop-firm/status"],
    requiredAuth: true,
    requiredSetup: ["User enables prop firm mode and configures target + drawdown rules"],
    status: "live",
    whereToFindIt: "Risk Settings page → Prop Firm Mode card.",
    relatedFeatures: ["risk_guard", "performance_calendar"],
    safetyNotes: "Never claims a real challenge is passed. Never guarantees a funded payout.",
    emptyStateBehavior: "Fresh users see enabled:false; assistant says prop firm mode is not configured yet.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "trade_journal",
    featureName: "Trade Journal",
    userFacingName: "Trade Logs / Journal",
    shortDescription: "Per-trade history with notes, debriefs, and mistake tagging.",
    fullDescription: "Lists closed paper trades with optional per-trade notes. Supports debrief and mistake-tag entries.",
    route: "/trade-logs",
    frontendComponent: "Trade Logs page",
    backendEndpoints: ["/api/me/journal", "/api/me/journal/summary"],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Trade Logs page in main navigation.",
    relatedFeatures: ["adaptive_coaching", "performance_calendar"],
    safetyNotes: "Per-user-scoped. Never returns another user's trades.",
    emptyStateBehavior: "Fresh users see isEmpty:true and the assistant says 'no closed trades yet'.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "performance_calendar",
    featureName: "Performance Calendar",
    userFacingName: "Daily P&L calendar",
    shortDescription: "Day-by-day P&L grid with drilldown.",
    fullDescription: "Aggregates closed paper trades by day to show a calendar of daily P&L over the lookback window.",
    route: "/analytics",
    frontendComponent: "Analytics page (Performance section)",
    backendEndpoints: ["/api/me/performance/daily"],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Analytics page → Daily Calendar section (/analytics).",
    relatedFeatures: ["trade_journal", "prop_firm_mode"],
    safetyNotes: "Paper P&L only. Per-user-scoped.",
    emptyStateBehavior: "Fresh users see an empty calendar.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "adaptive_coaching",
    featureName: "Adaptive Coaching",
    userFacingName: "ARX coaching",
    shortDescription: "Setup-quality scorecard for plans and recent trades.",
    fullDescription: "Transparent scorecard: plan completeness, risk quality, reward quality, timing readiness, discipline alignment. Returns a label (incomplete | needs_review | watchlist_ready | paper_trade_ready | blocked_by_risk). NOT a profit prediction.",
    route: "/trade-logs",
    frontendComponent: "Trade Logs page + assistant tool",
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["At least one paper trade or an inline plan to evaluate"],
    status: "live",
    whereToFindIt: "Ask the assistant 'is this trade ready' or 'why was this blocked'.",
    relatedFeatures: ["trade_journal", "pre_trade_risk_check"],
    safetyNotes: "Never predicts profit. Reports blockers and warnings verbatim.",
    emptyStateBehavior: "Returns label:'incomplete' when no plan is supplied.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "notifications",
    featureName: "In-App Notifications",
    userFacingName: "Alerts",
    shortDescription: "Per-user in-app notification feed.",
    fullDescription: "Per-user notifications across categories: risk, bridge, market_data, trade_journal, prop_firm, scanner, system, account, assistant.",
    route: "/alerts",
    frontendComponent: "Alerts page + bell badge",
    backendEndpoints: ["/api/me/notifications"],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Bell icon in the top bar; full list on the Alerts page.",
    relatedFeatures: ["push_notifications"],
    safetyNotes: "Per-user-scoped. Never invents alerts.",
    emptyStateBehavior: "Fresh users see isEmpty:true; assistant says 'you have no current notifications'.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "push_notifications",
    featureName: "Push Notifications",
    userFacingName: "Browser push",
    shortDescription: "Web Push delivery for critical alerts.",
    fullDescription: "Web Push subscriptions per user, gated on VAPID server keys + browser opt-in.",
    route: "/alerts",
    frontendComponent: "Alerts page → Push card",
    backendEndpoints: ["/api/me/push/subscribe", "/api/me/push/status"],
    requiredAuth: true,
    requiredSetup: ["VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY server secrets", "User opts in via the browser permission prompt"],
    status: "partial",
    whereToFindIt: "Alerts page → Push card.",
    relatedFeatures: ["notifications"],
    safetyNotes: "Push state is reported truthfully: not_configured / available_disabled / disabled / enabled.",
    emptyStateBehavior: "Without VAPID keys the card shows 'not configured' with setup instructions.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "market_data_provider",
    featureName: "Market Data Provider",
    userFacingName: "Market data",
    shortDescription: "Pluggable adapter for live quotes and news.",
    fullDescription: "One of POLYGON_API_KEY, FINNHUB_API_KEY, ALPHA_VANTAGE_API_KEY (quotes + news) or NEWSAPI_API_KEY (news only). Until one is set, market tools return connected:false.",
    route: null,
    frontendComponent: null,
    backendEndpoints: ["/api/me/assistant/market-status"],
    requiredAuth: true,
    requiredSetup: ["Set one of POLYGON_API_KEY / FINNHUB_API_KEY / ALPHA_VANTAGE_API_KEY / NEWSAPI_API_KEY"],
    status: "partial",
    whereToFindIt: "Backend adapter; status surfaced via assistant 'do I have live market data?'.",
    relatedFeatures: ["market_snapshot", "market_news", "scanner"],
    safetyNotes: "When connected:false the assistant must say 'live market data is not connected' — never fabricate quotes or news.",
    emptyStateBehavior: "Returns connected:false + setupHint listing the required keys.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "market_snapshot",
    featureName: "Market Snapshot",
    userFacingName: "Live quote",
    shortDescription: "Live quote for a symbol from the configured provider.",
    fullDescription: "Returns last/bid/ask/freshness or connected:false + freshness:'UNAVAILABLE' if no provider is wired.",
    route: null,
    frontendComponent: null,
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["A market data provider key configured"],
    status: "partial",
    whereToFindIt: "Ask the assistant 'what's the price of EURUSD?'.",
    relatedFeatures: ["market_data_provider"],
    safetyNotes: "Never fabricates a quote.",
    emptyStateBehavior: "Returns connected:false + freshness:'UNAVAILABLE' when no provider is wired.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "market_news",
    featureName: "Market News",
    userFacingName: "Market headlines",
    shortDescription: "Recent headlines from the configured provider.",
    fullDescription: "Returns headlines or empty + connected:false if no provider is wired.",
    route: null,
    frontendComponent: null,
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["A market data provider key configured"],
    status: "partial",
    whereToFindIt: "Ask the assistant 'any news on gold today?'.",
    relatedFeatures: ["market_data_provider"],
    safetyNotes: "Never fabricates headlines.",
    emptyStateBehavior: "Returns empty list + connected:false when no provider is wired.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "scanner",
    featureName: "Market Scanner",
    userFacingName: "Scanner",
    shortDescription: "Strategy-driven signals for tracked symbols.",
    fullDescription: "Generates signals from the strategy engine. Currently runs on synthetic candles in demo mode. Becomes live when a market data provider is wired.",
    route: "/scanner",
    frontendComponent: "Scanner page",
    backendEndpoints: ["/api/me/scanner/signals"],
    requiredAuth: true,
    requiredSetup: ["Market data provider for live signals (otherwise demo synthetic candles)"],
    status: "partial",
    whereToFindIt: "Scanner page in main navigation.",
    relatedFeatures: ["market_data_provider", "trade_journal"],
    safetyNotes: "Demo signals are clearly labeled. Never claims a live signal without a connected provider.",
    emptyStateBehavior: "Without provider, returns demo synthetic signals labeled as such.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "account_login",
    featureName: "Account / Login",
    userFacingName: "Sign in",
    shortDescription: "Email + password authentication and per-user session.",
    fullDescription: "Express session backed by SESSION_SECRET. Every /api/me/* route requires an authenticated session.",
    route: null,
    frontendComponent: "Auth gateway (no dedicated /login route — handled by the app shell when no session is present)",
    backendEndpoints: ["/api/auth/login", "/api/auth/logout", "/api/auth/me"],
    requiredAuth: false,
    requiredSetup: ["SESSION_SECRET server secret"],
    status: "live",
    whereToFindIt: "Shown automatically when no session is active. There is no standalone /login page in the router.",
    relatedFeatures: ["user_sessions", "settings"],
    safetyNotes: "Password hashes never returned. Cross-user data is hard-blocked at every route.",
    emptyStateBehavior: "Unauthenticated requests to /api/me/* return 401.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "user_sessions",
    featureName: "User Sessions",
    userFacingName: "Sessions",
    shortDescription: "Express session middleware with secure cookie.",
    fullDescription: "Sessions are stored server-side; cookie holds the session id only.",
    route: null,
    frontendComponent: null,
    backendEndpoints: [],
    requiredAuth: false,
    requiredSetup: ["SESSION_SECRET"],
    status: "live",
    whereToFindIt: "Backend only.",
    relatedFeatures: ["account_login"],
    safetyNotes: "SESSION_SECRET is never exposed.",
    emptyStateBehavior: "N/A.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "settings",
    featureName: "Settings",
    userFacingName: "Settings",
    shortDescription: "User preferences and account-level settings.",
    fullDescription: "Trading style profile, risk limits, prop firm config, notification preferences.",
    route: "/settings",
    frontendComponent: "Settings page",
    backendEndpoints: ["/api/me/settings"],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Settings page in main navigation.",
    relatedFeatures: ["risk_guard", "prop_firm_mode", "trading_style"],
    safetyNotes: "Per-user-scoped.",
    emptyStateBehavior: "Fresh users see defaults; the assistant truthfully says 'not configured yet' for unset fields.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "trading_style",
    featureName: "Trading Style Profile",
    userFacingName: "Trading style",
    shortDescription: "User's preferred symbol/market, account mode, risk rules.",
    fullDescription: "Captured during onboarding or in Settings. Returned as configured:false for fresh users.",
    route: "/settings",
    frontendComponent: "Settings page → Trading style card",
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: ["User completes the trading style step in onboarding or Settings"],
    status: "live",
    whereToFindIt: "Settings page → Trading style.",
    relatedFeatures: ["onboarding", "settings"],
    safetyNotes: "Never invents preferences.",
    emptyStateBehavior: "Returns configured:false for fresh users.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
  {
    featureId: "onboarding",
    featureName: "Onboarding / Fresh User State",
    userFacingName: "Getting started",
    shortDescription: "First-run guidance for new users.",
    fullDescription: "Helps fresh users set up risk limits, trading style, and (optionally) MT5 bridge + market provider. ARX AI assistant truthfully reports empty states throughout.",
    route: "/",
    frontendComponent: "OnboardingProvider + Dashboard",
    backendEndpoints: [],
    requiredAuth: true,
    requiredSetup: [],
    status: "live",
    whereToFindIt: "Dashboard 'Start app tour' row, also accessible from the assistant ('what should I set up next?').",
    relatedFeatures: ["risk_guard", "trading_style", "mt5_bridge", "market_data_provider"],
    safetyNotes: "Never shows fake trades, fake performance, fake notifications.",
    emptyStateBehavior: "All empty-state copy is honest about what is missing.",
    lastVerifiedAt: REGISTRY_BUILT_AT,
  },
];

// ── Backward-compat: legacy route map ────────────────────────────────────
export const ARX_FEATURES: FeatureEntry[] = [
  { key: "dashboard", name: "Dashboard", route: "/", summary: "Account balance, P&L, win rate, drawdown, open trades, latest signals.", tags: ["overview", "summary", "home"] },
  { key: "scanner", name: "Market Scanner", route: "/scanner", summary: "Real-time signals with confidence scores for tracked symbols.", tags: ["signals", "scan"] },
  { key: "bot", name: "Bot Control", route: "/bot-control", summary: "Start/Stop/Pause the bot. Demo/LIVE mode (LIVE requires multi-step confirmation).", tags: ["bot", "automation"] },
  { key: "strategies", name: "Strategy Settings", route: "/strategy-settings", summary: "Toggle the 5 modular strategies: Trend Continuation, BOS, Liquidity Sweep, Volatility Expansion, No Trade Filter.", tags: ["strategy", "rules"] },
  { key: "risk", name: "Risk Settings", route: "/risk-settings", summary: "Risk parameters: max loss, lot size, confidence threshold, daily loss cap, etc.", tags: ["risk", "rules"] },
  { key: "logs", name: "Trade Logs", route: "/trade-logs", summary: "Trade history with P&L; filterable by symbol/status.", tags: ["history", "trades", "journal"] },
  { key: "backtest", name: "Backtest Lab", route: "/backtest", summary: "Upload candle CSV, run backtest, view equity curve.", tags: ["backtest", "research"] },
  { key: "performance", name: "Performance Analytics", route: "/analytics", summary: "Charts for daily P&L, equity curve, strategy breakdown.", tags: ["analytics", "performance"] },
  { key: "kill_switch", name: "Emergency Kill Switch", route: "/emergency", summary: "Big red button — stops all trading immediately.", tags: ["safety", "emergency"] },
  { key: "mt5_bridge", name: "MT5 Bridge", route: "/mt5-bridge", summary: "Per-user MT5 EA bridge: connection status, heartbeat, command queue.", tags: ["mt5", "bridge", "ea"] },
  { key: "journal", name: "Trade Journal", route: "/trade-logs", summary: "Trade-level notes, debriefs, mistake tagging.", tags: ["journal", "review"] },
  { key: "calendar", name: "Performance Calendar", route: "/analytics", summary: "Daily P&L calendar with per-day drilldown.", tags: ["calendar", "performance"] },
  { key: "alerts", name: "Alerts & Notifications", route: "/alerts", summary: "Per-user notifications and unread bell.", tags: ["alerts", "notifications"] },
  { key: "reports", name: "Reports", route: "/reports", summary: "Per-user report generator (CSV/HTML).", tags: ["reports", "export"] },
];

export function getAppFeatureMap() {
  return {
    appName: "ARX AI",
    tagline: "Analyze. Risk. eXecute.",
    features: ARX_FEATURES,
    safetyNote: "Trading mode is admin-controlled per user (Trading Off / Demo Trading Active / Live Trading Active). Every order goes through the backend guard chain.",
  };
}

export function explainFeature(routeOrFeatureName: string): { found: boolean; feature: FeatureEntry | null; suggestions: string[] } {
  const q = routeOrFeatureName.trim().toLowerCase();
  if (!q) return { found: false, feature: null, suggestions: ARX_FEATURES.slice(0, 5).map((f) => f.name) };
  const exact = ARX_FEATURES.find((f) => f.route.toLowerCase() === q || f.key === q);
  if (exact) return { found: true, feature: exact, suggestions: [] };
  const fuzzy = ARX_FEATURES.find((f) =>
    f.name.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q)) || q.includes(f.key),
  );
  if (fuzzy) return { found: true, feature: fuzzy, suggestions: [] };
  return { found: false, feature: null, suggestions: ARX_FEATURES.slice(0, 5).map((f) => f.name) };
}

// ── Phase 22H: rich registry helpers ─────────────────────────────────────
export function getAppFeatureRegistry() {
  return {
    appName: "ARX AI",
    tagline: "Analyze. Risk. eXecute.",
    builtAt: REGISTRY_BUILT_AT,
    count: ARX_FEATURE_REGISTRY.length,
    features: ARX_FEATURE_REGISTRY,
    safetyNote: "Trading mode is admin-controlled per user (Trading Off / Demo Trading Active / Live Trading Active). Every order goes through the backend guard chain.",
  };
}

export function getFeatureHelp(idOrName: string): {
  found: boolean;
  feature: FeatureRegistryEntry | null;
  suggestions: string[];
} {
  const q = String(idOrName ?? "").trim().toLowerCase();
  if (!q) {
    return { found: false, feature: null, suggestions: ARX_FEATURE_REGISTRY.slice(0, 5).map((f) => f.userFacingName) };
  }
  const exact = ARX_FEATURE_REGISTRY.find(
    (f) => f.featureId === q || f.featureName.toLowerCase() === q || f.userFacingName.toLowerCase() === q || (f.route && f.route.toLowerCase() === q),
  );
  if (exact) return { found: true, feature: exact, suggestions: [] };
  const fuzzy = ARX_FEATURE_REGISTRY.find(
    (f) =>
      f.featureName.toLowerCase().includes(q) ||
      f.userFacingName.toLowerCase().includes(q) ||
      f.shortDescription.toLowerCase().includes(q) ||
      q.includes(f.featureId),
  );
  if (fuzzy) return { found: true, feature: fuzzy, suggestions: [] };
  return { found: false, feature: null, suggestions: ARX_FEATURE_REGISTRY.slice(0, 5).map((f) => f.userFacingName) };
}

export function getCurrentPageHelp(pathname: string | null | undefined): {
  pathname: string | null;
  matched: boolean;
  feature: FeatureRegistryEntry | null;
  relatedFeatures: FeatureRegistryEntry[];
  suggestions: string[];
} {
  const path = (pathname ?? "").trim() || null;
  if (!path) {
    return {
      pathname: null,
      matched: false,
      feature: null,
      relatedFeatures: [],
      suggestions: ARX_FEATURE_REGISTRY.slice(0, 5).map((f) => f.userFacingName),
    };
  }
  const lower = path.toLowerCase();
  const exact = ARX_FEATURE_REGISTRY.find((f) => f.route && f.route.toLowerCase() === lower);
  let match = exact ?? null;
  if (!match) {
    // Prefer the longest route prefix that matches at a segment boundary
    // (so '/risk-settings/foo' picks '/risk-settings'). Crucially, the bare
    // root '/' is never used as a generic fallback — otherwise every unknown
    // path would resolve to the dashboard and we'd silently misroute help.
    const candidates = ARX_FEATURE_REGISTRY.filter((f) => {
      if (!f.route) return false;
      const r = f.route.toLowerCase();
      if (r === "/") return false;
      if (lower === r) return true;
      return lower.startsWith(r + "/");
    });
    candidates.sort((a, b) => (b.route?.length ?? 0) - (a.route?.length ?? 0));
    match = candidates[0] ?? null;
  }
  if (!match) {
    return {
      pathname: path,
      matched: false,
      feature: null,
      relatedFeatures: [],
      suggestions: ARX_FEATURE_REGISTRY.slice(0, 5).map((f) => f.userFacingName),
    };
  }
  const related = match.relatedFeatures
    .map((id) => ARX_FEATURE_REGISTRY.find((f) => f.featureId === id))
    .filter((f): f is FeatureRegistryEntry => Boolean(f));
  return { pathname: path, matched: true, feature: match, relatedFeatures: related, suggestions: [] };
}
