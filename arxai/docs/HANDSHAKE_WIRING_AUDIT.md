# ARX Handshake System — Wiring Audit (Phase 0)

This audit maps the existing subsystems ("layers") that the Handshake System
reads, their wiring state, and the surfaces the handshake must **never** touch.
It is the companion to [`ARCHITECTURE_MAP.md`](./ARCHITECTURE_MAP.md) and
[`SAFETY_NOTES.md`](./SAFETY_NOTES.md).

## What the Handshake System is (and is not)

- **Is**: a shared, cross-layer readiness/check-in backbone. It READS the state
  of existing services and aggregates one advisory verdict per handshake type.
  Per-layer vocabulary: `PASS` / `WARN` / `FAIL` / `SKIPPED` / `NOT_AVAILABLE`.
  Aggregated verdict: `PASS` / `WARN` / `BLOCK` / `UNKNOWN`.
- **Is not**: a gate. It NEVER blocks, slows, or alters any execution path. It
  is not part of the 16-gate live pipeline, not a kill switch, not a trade
  precondition. The authoritative gates remain the only things that can stop a
  trade. The handshake is fail-open and advisory.
- **Read-only**: every layer adapter only reads existing services/tables. No
  mutation, dispatch, or order placement.
- **Honest**: an unreadable layer yields `NOT_AVAILABLE` (and an aggregate of
  `UNKNOWN` when nothing is evaluable) — never a fabricated `PASS`, never
  sim/mock/placeholder data. A definitively bad state (kill switch engaged,
  broker disconnected, open CRITICAL discrepancy) is `FAIL`.
- **Isolated**: investor-scoped handshakes (`INVESTOR_VALUE`, `WEEKLY_REPORT`)
  read ONLY the supplied investor's rows; with no investor context their layers
  report `SKIPPED` (→ aggregate `UNKNOWN`) rather than reading another tenant's
  data. They expose readiness only — never balances or the ARX 60/40 waterfall.

## Layer audit

Legend — **Wired**: real read-only signal in use. **Read-only awareness**: the
handshake is aware of it but only reads coarse state. **Must not touch**: the
handshake never reads or writes it on any hot/execution path.

| # | Layer | State | Real read-only source | Notes |
|---|-------|-------|-----------------------|-------|
| 1 | Market Data Router / Providers | Wired | `data/providerHealth.ts → getProviderHealthSnapshot()` | Composite chain; WARN when on fallback, NOT_AVAILABLE when no provider connected. Never substitutes sim data. |
| 2 | Broker / MT5 Bridge Health | Wired | `broker_health_state` (singleton: `lastStatus`, `lastEvaluatedAt`, `maintenanceMode`) | Disconnected → FAIL; heartbeat freshness past window → WARN. Visibility only; the 15s dispatch heartbeat gate is unchanged. |
| 3 | News Intelligence | Wired | `news/newsIntelligenceService.ts → getNewsIntelligence()` (`headlines.connected`) | NOT_AVAILABLE when provider disconnected; honest-empty, never fabricated headlines. |
| 4 | Market Scanner | Wired | `marketScanner.ts → scannerStatus()` | Coarse running/last-scan state (idle or stale → WARN). The scanner stays priority #1; handshake never alters scan cadence or results. |
| 5 | Investor Fund Book / Reconciliation | Wired | `fund_discrepancies` (open `CRITICAL`), `fund_control_freezes` (active) | Open CRITICAL discrepancy → FAIL; active freeze → WARN. Per-investor scoped when an investor context is supplied. Detection-only tables; handshake never edits balances. |
| 6 | Admin Control / Global Settings | Wired | `global_trading_settings` (singleton id=1: `platformMode`) | Reads platform mode only. Never writes. |
| 7 | Kill Switch / Emergency Stop | Wired (read-only awareness) | `global_trading_settings.emergencyKillSwitch` | Engaged → FAIL in the handshake verdict (advisory). The real kill switch remains authoritative and independent. |
| 8 | Live Execution Pipeline (16-gate) | **Must not touch** | `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` | Handshake imports nothing from the dispatch path and never appends a gate. |
| 9 | Ruby Assistant | **Must not touch** | `meAssistant.ts` (read-only assistant) | Ruby stays read-only; handshake never routes through it. |
| 10 | Smart Chart / Scanner Chart render | **Must not touch** | `components/scanner/ScannerChartPanel.tsx`, candles endpoints | No handshake call on the candle render or chart trade-action path. |
| 11 | Weekly Report / Investor Statements | Wired (via Fund Book) | Fund Book NAV + reconciliation state | Shares layer #5 readiness; report generation path unchanged. |
| 12 | Feature layers (#194–#199) | Scaffold | n/a yet | `SIGNAL_INTELLIGENCE`, `SCANNER_EXPLANATION`, `EXECUTION_COST`, `NEWS_RADAR`, `TRADE_HEALTH` registered as planned handshakes; evaluate to `UNKNOWN` until their phase wires real adapters. No fabricated logic. |

## Duplicate / stale / disconnected notes

- **No duplicate systems introduced.** The handshake reuses existing health
  services (`providerHealth`, `brokerHealthState`, `newsIntelligenceService`,
  `scannerStatus`, fund-book reconciliation, `globalTradingSettings`) rather
  than re-deriving their state.
- **Event bus**: a single lightweight in-process emitter is added for
  cross-layer readiness events. It does not replace `alertManager` (user-facing
  alerts) or `security/events` (audit) — those remain the channels for their
  respective concerns.

### Event channels — reserved vs wired

The bus defines a typed channel for every cross-layer update a dependent may
care about. The **subscriber side is wired** (the coordinator subscribes to all
`LAYER_UPDATE_EVENTS` to drop its short advisory cache so the next read
re-evaluates). The **producer side is reserved**: each owning layer publishes in
its own phase. No producer hot path (live dispatch, the scanner scan loop, EA
heartbeat ingest, NAV/ledger writes) is modified in Phase 0 — emitting is opt-in
and best-effort, and a throwing listener can never propagate to a producer.

| Channel | Subscriber (cache invalidation) | Producer |
|---------|--------------------------------|----------|
| `handshake:evaluated` | n/a (lifecycle) | coordinator (wired) |
| `layer:not-ready` | n/a (lifecycle) | coordinator (wired) |
| `layer:price` | Wired | Reserved (market data) |
| `layer:candles` | Wired | Reserved (market data) |
| `layer:specs` | Wired | Reserved (symbol directory) |
| `layer:scanner-signal` | Wired | Reserved (scanner) |
| `layer:news` | Wired | Reserved (news service) |
| `layer:heartbeat` | Wired | Reserved (MT5 bridge) |
| `layer:position-sync` | Wired | Reserved (MT5 bridge) |
| `layer:nav` | Wired | Reserved (fund book) |
| `layer:ledger` | Wired | Reserved (fund book) |
| `layer:discrepancy` | Wired | Reserved (reconciliation) |
| `layer:role` | Wired | Reserved (admin/roles) |
- **Persistence**: handshake outcomes are logged append-style to
  `handshake_checkins` (admin-facing evidence). This table is new and additive;
  it is not on any execution hot path.

## Must-not-touch checklist (enforced by review + CI)

- 16-gate live pipeline, `placeLiveOrderGuarded`, `arx_live_*` dispatch.
- Kill switch / emergency stop authority.
- Scanner cadence/results, Smart Chart render, trade modal, open positions,
  retcode mapping.
- Investor portal scoping, admin controls, broker credentials.
- No internal/backend wording (gate names, env names, tokens) exposed to users.
