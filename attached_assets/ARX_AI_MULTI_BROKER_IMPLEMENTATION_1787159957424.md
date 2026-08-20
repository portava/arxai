# ARX AI Multi-Broker Execution System

**Status:** Implementation specification  
**Target:** Existing ARX AI codebase  
**Core:** Python 3.12, PostgreSQL, existing ARX execution/risk architecture  
**Default:** Live trading OFF

## 1. Owner ruling and implementation boundary

ARX AI will support multiple broker and exchange accounts through a shared execution control plane and broker-specific adapters. The existing MT5 bridge is retained and audited; it is not replaced or duplicated.

The architecture remains:

`SENSE -> SIGNAL -> RISK -> EXECUTE -> GUARD -> MEMORY -> REVIEW -> COMMAND`

Hard constraints:

- Deterministic risk controls outrank AI output.
- LLMs may explain, classify, and propose; they cannot authorize or directly place live trades.
- Real-money execution defaults OFF.
- Rollout is replay -> shadow -> demo/paper -> limited live -> production.
- `WAIT` and `UNKNOWN` are valid non-trading outcomes.
- Manual live orders use one final confirmation, not stacked confirmation modals.
- There is no silent fallback from live to demo, paper, mock, or simulated execution.
- Automated execution has stricter controls than manual execution.
- No martingale or loss-recovery sizing.
- A broker reconciliation mismatch is CRITICAL and blocks new entries.
- No geographic or KYC circumvention. Eligibility is determined from broker rules and the user's verified legal residency, not current travel location or VPN.
- Audit and reuse existing ARX code before creating files, tables, routes, services, flags, or UI.
- Connected brokers are the primary and authoritative source for their own tradable symbols, quotes, ticks, candles, sessions and market status. ARX does not require a separate general market-data subscription for this build.
- Market data is provenance-bound. ARX never silently uses Broker A's candles to authorize or price an order at Broker B.

### 1.1 Two operating modes in one platform

ARX has two explicit modes sharing the same broker adapters, market truth, deterministic risk kernel, execution state machine, reconciliation and audit infrastructure.

#### Mode A — Self-Trading

- The user connects and controls their own broker accounts.
- The user is both account owner and trading operator.
- Manual and automated permissions remain separate.
- Live execution still requires the global, account and risk gates.
- No other user receives authority unless the account is deliberately moved into a managed workspace assignment.

#### Mode B — Managed Allocation

- A **Master User** creates a managed workspace and connects broker accounts they are authorized to control.
- The Master User invites selected ARX users and assigns specific accounts or broker-supported subaccounts.
- Each assignment has a server-enforced authority envelope: capital/risk allocation, symbols, products, order types, environments, trading hours, manual/automated permissions, position limits and expiration.
- Assigned users never receive broker passwords, API secrets, OAuth tokens or credential-vault access.
- Master limits are ceilings. An assigned user may choose stricter limits but cannot loosen the Master's limits.
- The Master can pause, freeze, revoke, move to close-only or activate the workspace/account/global kill switch at any time.
- Revoking authority prevents new orders immediately. It does not silently close existing positions; closing requires an explicit Master action or a pre-authorized risk rule.
- Every order records the broker-account owner, workspace, assignment, acting user, strategy, approval path and effective limits.

These are modes, not separate execution stacks. A single order pipeline enforces identity, ownership and allocation before deterministic market/risk checks and broker submission.

### 1.2 Managed-account safety boundary

Broker-native subaccounts are preferred because they provide real custody/account separation. A logical ARX allocation inside one broker account does **not** create legal or broker-level segregation.

Initial live rule:

- One live broker account/subaccount has one active trading assignment at a time, unless the broker natively supports segregated subaccounts and the adapter certifies them.
- Multiple users sharing one netting account is demo/shadow-only until ARX proves virtual-book attribution, conflicting-order handling, fills, fees, margin, liquidation and reconciliation.
- Opposing orders in a netting account can alter or close another user's exposure; ARX must not pretend those are independent portfolios.
- A Master cannot allocate more risk/capital than the broker account and workspace have available after existing exposure, reservations, fees and margin.

### 1.3 Regulatory product gate

Self-trading the user's own account and giving an employee/operator limited authority over an account owned by the same person/entity are not automatically equivalent to managing outside customers' accounts. If ARX lets a Master manage accounts or money belonging to other people, charges for advice/performance, or exercises discretion for customers, launch requires jurisdiction-specific securities/commodities counsel and broker approval before activation.

The product must capture account beneficial ownership and relationship to the Master. Unsupported outside-client managed accounts remain `COMPLIANCE_HOLD`; software permissions alone do not create lawful trading authority.

## 2. Top 20 API venues for ARX

This is an ARX-fit ranking, not a claim about assets under management. Access, products, market data, and API approval vary by entity and jurisdiction and must be checked during connection onboarding.

| # | Venue | Primary coverage | API model | ARX priority | Access note |
|---|---|---|---|---|---|
| 1 | Deriv | Derived/synthetic indices, options, multipliers, accumulators | REST setup + authenticated WebSocket execution | P0 | Best fit for ARX's initial four-symbol universe; API contracts are not identical to MT5 CFDs. |
| 2 | OANDA | FX, metals and supported CFDs | REST + pricing stream | P0 | Direct retail API; account availability varies by OANDA division. |
| 3 | Interactive Brokers | Stocks, options, futures, FX, bonds, funds and global markets | Web API/OAuth plus TWS APIs | P1 | Broadest multi-asset reach; authentication and market-data permissions are more complex. |
| 4 | Alpaca | U.S. equities, options and crypto | REST/WebSocket + OAuth | P1 | Strong paper environment; multi-user OAuth applications require onboarding/approval. |
| 5 | TradeStation | Equities, options and futures | REST/JSON + streaming; FIX for institutional use | P1 | Personal keys available; multi-user applications require Business Development review. |
| 6 | Tradier | U.S. equities, ETFs and options | REST + HTTP/WebSocket streaming | P1 | Straightforward individual sandbox/live API. |
| 7 | tastytrade | Equities, options, futures and futures options | REST + account/market streams | P1 | Strong options support and sandbox; model complex/multileg orders explicitly. |
| 8 | Tradovate / NinjaTrader | Futures | REST + WebSocket | P1 | Good futures adapter; entitlement and vendor access rules must be verified. |
| 9 | Saxo Bank | Global multi-asset | OpenAPI + streaming | P1 | High coverage; app, market-data and trading permissions can require approval. |
| 10 | cTrader Open API | FX/CFDs through participating cTrader brokers | OAuth 2.0 + TCP/WebSocket protocol | P1 | Platform-level adapter that can reach multiple cTrader brokers; capabilities remain account-specific. |
| 11 | IG | FX, indices, commodities, equities and other CFDs | REST + Lightstreamer | P2 | Retail API with demo; products and availability vary by IG entity. |
| 12 | Capital.com | CFDs across supported markets | REST + WebSocket | P2 | Demo supported; its API key currently carries trading authority rather than a read-only scope. |
| 13 | FXCM | FX and supported CFDs | ForexConnect/Java/FIX; availability varies | P2 | Confirm current API and entity eligibility before building; do not assume legacy REST availability. |
| 14 | Charles Schwab | U.S. brokerage accounts and market data | Trader API/OAuth | P2 | Good U.S. coverage; developer app approval and account permissions apply. |
| 15 | Coinbase Advanced | Spot crypto | REST + WebSocket | P2 | Strong U.S.-oriented crypto connector; separate crypto risk intelligence required. |
| 16 | Kraken | Spot and derivatives where eligible | REST + WebSocket + FIX | P2 | Broad API surface; derivatives availability is jurisdiction-specific. |
| 17 | Binance.US | U.S.-available spot crypto | REST + trading/market WebSockets | P3 | Separate venue and API from Binance international. |
| 18 | Binance | International spot, margin and derivatives | REST + WebSocket | P3 | Never expose to an ineligible U.S. person or use location circumvention. |
| 19 | OKX | International spot and derivatives | REST + WebSocket | P3 | Jurisdiction and product eligibility gate required. |
| 20 | Bybit | International spot, derivatives and options | Unified V5 REST + WebSocket | P3 | Jurisdiction and product eligibility gate required. |

Official references:

- [Deriv API](https://developers.deriv.com/docs/)
- [OANDA v20 API](https://developer.oanda.com/rest-live-v20/introduction/)
- [IBKR Web API](https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/)
- [Alpaca OAuth Trading API](https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api)
- [TradeStation API](https://api.tradestation.com/docs/)
- [Tradier API](https://docs.tradier.com/)
- [tastytrade API](https://developer.tastytrade.com/api-overview)
- [Tradovate API](https://api.tradovate.com/)
- [Saxo OpenAPI](https://www.developer.saxo/openapi)
- [cTrader Open API](https://help.ctrader.com/open-api/)
- [IG APIs](https://www.ig.com/en/trading-platforms/trading-apis/how-to-use-ig-api)
- [Capital.com API](https://open-api.capital.com/)
- [FXCM API trading](https://www.fxcm.com/markets/algorithmic-trading/api-trading/)
- [Schwab Developer Portal](https://developer.schwab.com/products/trader-api--individual)
- [Coinbase Advanced Trade API](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/overview)
- [Kraken API](https://docs.kraken.com/exchange/guides/overview)
- [Binance.US API](https://docs.binance.us/)
- [Binance APIs](https://developers.binance.com/en/docs)
- [OKX V5 API](https://www.okx.com/docs-v5/)
- [Bybit V5 API](https://bybit-exchange.github.io/docs/)

## 3. Product surface

### 3.1 Broker Connections

Route: `Settings -> Broker Connections`

Each card displays:

- Venue and legal entity
- Connection label
- Demo/paper/live environment
- Account nickname and masked account identifier
- Base currency
- Connection state: `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `DEGRADED`, `REAUTH_REQUIRED`, `PAUSED`, `FROZEN`, `ERROR`
- Market-data health and trading health separately
- Last heartbeat, last reconciliation and latency
- Permissions: read, market data, trade; withdrawal permission must be rejected
- Owner/admin approval state
- Auto-trading state
- Per-connection limits and allocation
- Pause, reconnect, rotate credentials and disconnect actions

Global controls:

- Master trading switch
- Automated execution switch
- Global kill switch
- Close-only mode
- Freeze new entries
- Aggregate exposure and daily-loss gauges
- Reconciliation status

### 3.3 Workspace and allocation interface

Route: `Settings -> Trading Workspaces`

Workspace types:

- `SELF`
- `MANAGED`

Managed workspace pages:

- Members and roles
- Connected accounts/subaccounts
- Assignments
- Capital and risk allocations
- Effective permissions
- Pending invitations and expiration
- Live/manual/automation approvals
- Open exposure by assigned user
- Reserved versus used allocation
- Assignment-level P&L and drawdown
- Audit trail
- Pause, close-only, freeze, revoke and kill-switch controls

Roles are permission bundles, not the final authority. The assignment envelope is always evaluated:

- `MASTER_OWNER`
- `ADMIN`
- `RISK_MANAGER`
- `TRADER`
- `VIEWER`
- `AUDITOR`

Example trading permissions:

- `view_account`
- `view_market_data`
- `create_proposal`
- `manual_trade`
- `automated_trade`
- `cancel_own_order`
- `close_own_position`
- `close_assigned_positions`
- `emergency_close`

No assigned role receives credential, withdrawal, deposit, transfer or allocation-administration authority by implication.

### 3.2 Connection flow

1. Select venue.
2. Show eligibility and supported-product notice.
3. Select demo/paper/live. Live remains unavailable unless owner/admin and rollout gates permit it.
4. Use OAuth where available. Otherwise collect API credentials through a backend-only encrypted form.
5. Reject keys with withdrawal/cash-transfer scope where the venue exposes scopes.
6. Test authentication without placing an order.
7. Discover accounts, permissions, instruments and capabilities from the venue.
8. Select accounts and assign portfolio allocation.
9. Reconcile balances, positions and open orders.
10. Mark connected for read-only. Trading remains separately disabled.
11. Run adapter certification before enabling demo execution.

## 4. Service architecture

```text
ARX UI/API
    |
Connection Service ---- Credential Vault
    |
Broker Registry ---- Eligibility/Capability Registry
    |
Market Gateway ---- Symbol Catalog ---- Market Data Quality
    |
Signal/Decision Core
    |
Deterministic Risk Kernel
    |
Execution Orchestrator ---- Idempotency Ledger
    |
Broker Adapter Workers
    |
Venue APIs / Existing MT5 Agent
    |
Event Ingest ---- Reconciler ---- Position Manager
    |
PostgreSQL/TimescaleDB ---- Immutable Audit ---- Alerts
```

Rules:

- API requests never place orders directly from controllers.
- All orders enter the execution orchestrator as immutable intents.
- Every order passes capability validation, symbol validation, deterministic risk, mode/approval gates and idempotency before reaching an adapter.
- Broker acknowledgements are not treated as fills.
- Streams are preferred, but authoritative reconciliation polls must independently verify state.
- A lost acknowledgement produces `UNKNOWN`, not an automatic duplicate retry.
- The Market Gateway obtains live and historical data from authenticated connected-broker APIs. External market-data networks are outside this implementation unless a later owner ruling adds a specifically named fallback.
- Losing a broker's market-data feed produces `STALE`/`UNAVAILABLE` and blocks new trades for that connection; ARX does not silently substitute another source.

## 5. Python package layout

Use existing equivalent modules where they exist.

```text
arx/
  brokers/
    base.py
    registry.py
    capabilities.py
    eligibility.py
    errors.py
    models.py
    adapters/
      deriv/
      oanda/
      mt5/
      alpaca/
      ibkr/
      tradestation/
      tradier/
      tastytrade/
      tradovate/
      saxo/
      ctrader/
      ig/
      capital/
      fxcm/
      schwab/
      coinbase/
      kraken/
      binance_us/
      binance/
      okx/
      bybit/
  connections/
    service.py
    oauth.py
    credentials.py
    health.py
  execution/
    orchestrator.py
    state_machine.py
    idempotency.py
    reconciler.py
    router.py
  risk/
    kernel.py
    limits.py
    exposure.py
    breakers.py
  market/
    symbols.py
    normalization.py
    subscriptions.py
  api/
    broker_connections.py
    execution.py
    risk_controls.py
  workers/
    broker_events.py
    reconciliation.py
    token_refresh.py
  tests/
    contract/
    adapters/
    mutations/
```

## 6. Canonical domain model

```python
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import AsyncIterator, Mapping, Protocol
from uuid import UUID


class Environment(StrEnum):
    DEMO = "demo"
    PAPER = "paper"
    LIVE = "live"


class Side(StrEnum):
    BUY = "buy"
    SELL = "sell"


class OrderType(StrEnum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


class TimeInForce(StrEnum):
    DAY = "day"
    GTC = "gtc"
    IOC = "ioc"
    FOK = "fok"
    GTD = "gtd"


class ExecutionMode(StrEnum):
    MANUAL = "manual"
    AUTOMATED = "automated"


class OrderState(StrEnum):
    CREATED = "created"
    RISK_REJECTED = "risk_rejected"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    AUTHORIZED = "authorized"
    SUBMITTING = "submitting"
    ACKNOWLEDGED = "acknowledged"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCEL_PENDING = "cancel_pending"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    EXPIRED = "expired"
    UNKNOWN = "unknown"
    RECONCILIATION_REQUIRED = "reconciliation_required"


@dataclass(frozen=True)
class TradeIntent:
    intent_id: UUID
    idempotency_key: str
    user_id: UUID
    connection_id: UUID
    account_id: UUID
    strategy_id: UUID | None
    mode: ExecutionMode
    environment: Environment
    canonical_symbol: str
    side: Side
    order_type: OrderType
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.GTC
    expires_at: datetime | None = None
    signal_timestamp: datetime | None = None
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class BrokerCapabilities:
    asset_classes: frozenset[str]
    order_types: frozenset[OrderType]
    time_in_force: frozenset[TimeInForce]
    supports_fractional: bool
    supports_hedging: bool
    supports_shorting: bool
    supports_attached_brackets: bool
    supports_client_order_id: bool
    supports_order_stream: bool
    supports_position_stream: bool
    supports_demo: bool


class BrokerAdapter(Protocol):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def health(self) -> "BrokerHealth": ...
    async def capabilities(self, account_ref: str) -> BrokerCapabilities: ...
    async def list_accounts(self) -> list["BrokerAccount"]: ...
    async def discover_symbols(self, account_ref: str) -> list["BrokerInstrument"]: ...
    async def get_quote(self, account_ref: str, broker_symbol: str) -> "Quote": ...
    async def get_balances(self, account_ref: str) -> list["Balance"]: ...
    async def get_positions(self, account_ref: str) -> list["Position"]: ...
    async def get_open_orders(self, account_ref: str) -> list["BrokerOrder"]: ...
    async def submit_order(self, request: "BrokerOrderRequest") -> "SubmissionResult": ...
    async def cancel_order(self, account_ref: str, broker_order_id: str) -> "CancelResult": ...
    async def close_position(self, request: "ClosePositionRequest") -> "SubmissionResult": ...
    async def events(self, account_ref: str) -> AsyncIterator["BrokerEvent"]: ...
```

Adapters must not accept a raw `TradeIntent` and invent venue defaults. The orchestrator resolves a fully validated `BrokerOrderRequest` containing explicit broker symbol, precision, quantity unit, order semantics, protection behavior and account mode.

## 7. PostgreSQL schema

Use UUIDs, UTC timestamps, numeric/decimal fields for money, row-level authorization and append-only event records. Credential ciphertext is never returned through normal API serializers.

```sql
create type broker_environment as enum ('demo', 'paper', 'live');
create type broker_connection_status as enum (
  'disconnected', 'connecting', 'connected', 'degraded',
  'reauth_required', 'paused', 'frozen', 'error'
);
create type execution_mode as enum ('manual', 'automated');
create type trading_workspace_type as enum ('self', 'managed');
create type trading_workspace_role as enum (
  'master_owner', 'admin', 'risk_manager', 'trader', 'viewer', 'auditor'
);
create type execution_order_state as enum (
  'created', 'risk_rejected', 'awaiting_confirmation', 'authorized',
  'submitting', 'acknowledged', 'partially_filled', 'filled',
  'cancel_pending', 'cancelled', 'rejected', 'expired', 'unknown',
  'reconciliation_required'
);

create table broker_connections (
  id uuid primary key,
  user_id uuid not null,
  broker_code text not null,
  legal_entity text,
  label text not null,
  environment broker_environment not null,
  status broker_connection_status not null default 'disconnected',
  credential_ref text not null,
  auth_type text not null,
  permissions jsonb not null default '{}'::jsonb,
  eligibility jsonb not null default '{}'::jsonb,
  owner_approved_at timestamptz,
  trading_enabled boolean not null default false,
  automation_enabled boolean not null default false,
  close_only boolean not null default false,
  frozen_at timestamptz,
  last_heartbeat_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker_code, label)
);

create table trading_workspaces (
  id uuid primary key,
  workspace_type trading_workspace_type not null,
  name text not null,
  master_user_id uuid not null,
  status text not null default 'active',
  compliance_status text not null default 'self_only',
  master_kill_switch_active boolean not null default true,
  close_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trading_workspace_members (
  id uuid primary key,
  workspace_id uuid not null references trading_workspaces(id) on delete cascade,
  user_id uuid not null,
  role trading_workspace_role not null,
  status text not null default 'invited',
  invited_by uuid not null,
  accepted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table broker_accounts (
  id uuid primary key,
  connection_id uuid not null references broker_connections(id) on delete cascade,
  broker_account_ref text not null,
  masked_account_ref text not null,
  nickname text,
  base_currency text not null,
  account_type text not null,
  capabilities jsonb not null,
  allocation_percent numeric(7,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, broker_account_ref),
  check (allocation_percent >= 0 and allocation_percent <= 100)
);

create table broker_account_assignments (
  id uuid primary key,
  workspace_id uuid not null references trading_workspaces(id) on delete cascade,
  broker_account_id uuid not null references broker_accounts(id) on delete cascade,
  assigned_user_id uuid not null,
  assigned_by uuid not null,
  environment broker_environment not null,
  permissions text[] not null default '{}',
  allowed_symbols text[] not null default '{}',
  allowed_asset_classes text[] not null default '{}',
  allowed_order_types text[] not null default '{}',
  capital_limit numeric,
  max_order_notional numeric,
  max_risk_per_trade numeric not null,
  max_aggregate_open_risk numeric not null,
  max_daily_loss numeric not null,
  max_rolling_drawdown numeric not null,
  max_open_positions integer not null,
  manual_enabled boolean not null default false,
  automation_enabled boolean not null default false,
  close_only boolean not null default false,
  trading_schedule jsonb not null default '{}'::jsonb,
  starts_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (capital_limit is null or capital_limit >= 0),
  check (max_open_positions >= 0)
);

create table allocation_reservations (
  id uuid primary key,
  assignment_id uuid not null references broker_account_assignments(id),
  intent_id uuid not null,
  reserved_capital numeric not null,
  reserved_risk numeric not null,
  status text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (intent_id),
  check (reserved_capital >= 0 and reserved_risk >= 0)
);

create table broker_instruments (
  id uuid primary key,
  broker_account_id uuid not null references broker_accounts(id) on delete cascade,
  canonical_symbol text not null,
  broker_symbol text not null,
  asset_class text not null,
  base_asset text,
  quote_asset text,
  quantity_unit text not null,
  min_quantity numeric,
  quantity_step numeric,
  price_tick numeric,
  min_notional numeric,
  contract_multiplier numeric,
  trading_status text not null,
  raw_metadata jsonb not null,
  discovered_at timestamptz not null,
  unique (broker_account_id, broker_symbol)
);

create table risk_profiles (
  id uuid primary key,
  user_id uuid not null,
  broker_account_id uuid references broker_accounts(id) on delete cascade,
  name text not null,
  max_risk_per_trade numeric not null,
  max_aggregate_open_risk numeric not null,
  max_daily_loss numeric not null,
  max_rolling_drawdown numeric not null,
  max_open_positions integer not null,
  max_order_notional numeric,
  max_slippage_bps numeric,
  max_signal_age_ms integer,
  max_market_data_age_ms integer,
  allowed_symbols text[] not null default '{}',
  allowed_asset_classes text[] not null default '{}',
  automated_multiplier numeric not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table execution_intents (
  id uuid primary key,
  idempotency_key text not null unique,
  user_id uuid not null,
  workspace_id uuid not null references trading_workspaces(id),
  assignment_id uuid references broker_account_assignments(id),
  broker_account_owner_user_id uuid not null,
  acting_user_id uuid not null,
  connection_id uuid not null references broker_connections(id),
  broker_account_id uuid not null references broker_accounts(id),
  strategy_id uuid,
  execution_mode execution_mode not null,
  environment broker_environment not null,
  canonical_symbol text not null,
  broker_symbol text,
  side text not null,
  order_type text not null,
  quantity numeric not null,
  limit_price numeric,
  stop_price numeric,
  stop_loss numeric,
  take_profit numeric,
  time_in_force text not null,
  signal_timestamp timestamptz,
  state execution_order_state not null default 'created',
  risk_decision jsonb,
  confirmation_actor_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity > 0)
);

create table broker_orders (
  id uuid primary key,
  intent_id uuid not null references execution_intents(id),
  broker_order_id text,
  client_order_id text not null,
  state execution_order_state not null,
  submitted_quantity numeric not null,
  filled_quantity numeric not null default 0,
  average_fill_price numeric,
  raw_ack jsonb,
  submitted_at timestamptz,
  terminal_at timestamptz,
  unique (intent_id),
  unique (client_order_id)
);

create table execution_events (
  id bigserial primary key,
  intent_id uuid not null references execution_intents(id),
  broker_order_id uuid references broker_orders(id),
  sequence_no bigint not null,
  event_type text not null,
  source text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (intent_id, sequence_no)
);

create table reconciliation_runs (
  id uuid primary key,
  broker_account_id uuid not null references broker_accounts(id),
  status text not null,
  positions_match boolean,
  orders_match boolean,
  balances_match boolean,
  mismatch_summary jsonb,
  started_at timestamptz not null,
  completed_at timestamptz
);

create table trading_control_state (
  singleton boolean primary key default true check (singleton),
  master_enabled boolean not null default false,
  automation_enabled boolean not null default false,
  close_only boolean not null default false,
  kill_switch_active boolean not null default true,
  freeze_reason text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
```

Add separate append-only audit tables for credential operations, approvals, configuration changes, kill-switch changes and broker webhooks/events. Revoke UPDATE/DELETE from append-only tables at the database layer.

## 8. Credentials and authorization

### Personal-only deployment

Application-level Replit Secrets may hold the owner's venue credentials during the earliest private MVP, but the UI must not pretend these are per-user connections.

### Multi-user deployment

- Use OAuth authorization code + PKCE where supported.
- Store refresh/access tokens and API secrets in an external KMS-backed secret vault or envelope-encrypted credential store.
- Store only a `credential_ref` and non-secret metadata in PostgreSQL.
- Separate encryption keys by environment.
- Never log authorization headers, tokens, API secrets, account passwords, OTP values or raw connection strings.
- Redact broker responses before logs and error reporting.
- Tokens are decrypted only inside the worker handling that connection.
- Rotate, revoke and delete credentials with auditable workflows.
- Reject withdrawal, transfer and account-management permissions unless a future separately approved product explicitly requires them.
- CSRF/state/nonce and redirect-URI validation are mandatory for OAuth.

## 9. Eligibility and capabilities

`broker_registry` describes what an adapter implementation can theoretically support. `broker_account.capabilities` records what the authenticated account actually supports.

Connection activation requires:

- Verified country/legal residency and broker entity eligibility
- User acceptance of venue terms and applicable risk disclosure
- Venue approval, OAuth registration or vendor onboarding where required
- Account permission for the requested product
- Market-data entitlement
- Instrument discovered from the account; never guessed
- Demo/live environment explicitly identified
- No unsupported withdrawal scope

Capability checks occur again before every order because permissions and market state can change.

## 10. Symbol normalization

Never route solely by display symbol. Use:

`canonical_instrument_id -> broker_account_id -> broker_instrument_id -> broker_symbol`

The canonical catalog contains economic identity and risk-family metadata. Each venue mapping contains broker symbol, asset class, quantity unit, precision, multiplier, expiry, trading session, order constraints and raw discovery evidence.

For the initial Deriv universe, discover the runtime symbol IDs through `active_symbols`; do not hard-code guessed IDs for:

- Volatility 25 (1s)
- Volatility 50 (1s)
- Volatility 75
- Volatility 75 (1s)

Keep synthetic-index intelligence separate from crypto and conventional market intelligence.

### 10.1 Broker-sourced candles and market data

For every connected account, ARX pulls the available market data directly from that broker:

- Runtime instrument/symbol catalog
- Bid, ask, last and applicable mark/index prices
- Tick stream or broker streaming equivalent
- Historical ticks/candles supported by the venue
- Trading sessions, halts and market status
- Contract metadata, precision, multiplier and order constraints

The Market Gateway normalizes transport and field names but preserves source identity. Every tick and candle must contain:

```python
@dataclass(frozen=True)
class MarketDataProvenance:
    broker_code: str
    connection_id: UUID
    broker_account_id: UUID
    broker_instrument_id: UUID
    broker_symbol: str
    environment: Environment
    received_at: datetime
    source_timestamp: datetime | None
    sequence: str | None
    is_snapshot: bool
    is_delayed: bool


@dataclass(frozen=True)
class Candle:
    provenance: MarketDataProvenance
    timeframe: str
    opened_at: datetime
    closed_at: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal | None
    complete: bool
```

Storage keys include the source:

`(broker_account_id, broker_instrument_id, timeframe, opened_at)`

ARX must not collapse candles from different brokers into one canonical series. Spreads, session boundaries, CFD pricing, synthetic-index generation, liquidity and candle construction can differ even when two venues display the same familiar symbol.

Default execution rule:

`decision market data source == execution broker connection`

Cross-venue analysis may be added later, but it must be explicit, labelled, separately tested and prohibited from serving as an invisible execution-price substitute.

### 10.2 Candle construction hierarchy

1. Use broker-provided completed candles when the broker supplies the required timeframe and history.
2. If the broker supplies ticks but not the needed timeframe, ARX may construct candles from that same broker's ticks.
3. Mark the in-progress candle `complete=false`; strategies cannot mistake it for a closed candle.
4. Persist broker timestamp, receive timestamp, gaps, reconnect boundaries and delayed-data flags.
5. On restart, backfill missing intervals from the same broker before resuming signals.
6. If same-broker backfill is unavailable, mark a gap and return `WAIT`; do not synthesize prices or borrow another venue silently.

### 10.3 Market-data entitlements

A connected trading account does not guarantee real-time data for every instrument. The connection service records whether data is real-time, delayed, snapshot-only or unavailable. Strategies define their minimum acceptable feed quality. Delayed or stale data cannot satisfy a real-time execution strategy.

## 11. Deterministic risk kernel

The kernel returns `ALLOW`, `DENY`, or `WAIT`; it does not place orders.

Checks, in order:

1. Global kill switch and master switch
2. Workspace/master kill switch, freeze and close-only state
3. Workspace membership, account ownership and beneficial-owner/compliance status
4. Active assignment, role, permission, schedule and expiration
5. Environment and rollout phase
6. Owner/admin approval
7. Connection/account status and trading permission
8. Manual confirmation or automated authorization
9. Allocation reservation and concurrency lock
10. Fresh reconciliation
11. Market-data freshness and source quality
12. Signal age
13. Instrument and capability support
14. Trading session and market state
15. Quantity, precision, minimum and maximum constraints
16. Price collars and slippage
17. Buying power/margin
18. Assignment per-trade and aggregate risk
19. Workspace/account aggregate open risk
20. Correlated exposure
21. Assignment/workspace/account daily loss and rolling drawdown
22. Per-symbol/per-edge circuit breakers
23. Execution-failure/latency breaker
24. Idempotency and duplicate-intent check

Automated mode must have lower size/exposure limits, tighter freshness requirements and independent activation. A manual live switch never enables automation.

## 12. Execution state machine

Allowed principal transitions:

```text
CREATED -> RISK_REJECTED
CREATED -> AWAITING_CONFIRMATION -> AUTHORIZED
CREATED -> AUTHORIZED                    (approved automated path only)
AUTHORIZED -> SUBMITTING
SUBMITTING -> ACKNOWLEDGED | REJECTED | UNKNOWN
ACKNOWLEDGED -> PARTIALLY_FILLED | FILLED | CANCEL_PENDING | EXPIRED
PARTIALLY_FILLED -> FILLED | CANCEL_PENDING | CANCELLED | UNKNOWN
CANCEL_PENDING -> CANCELLED | FILLED | UNKNOWN
UNKNOWN -> RECONCILIATION_REQUIRED
RECONCILIATION_REQUIRED -> ACKNOWLEDGED | PARTIALLY_FILLED | FILLED | CANCELLED | REJECTED
```

Rules:

- Transitions are transactional and append an event.
- Out-of-order broker events are retained and resolved by venue sequence/time semantics.
- A timeout after submission is `UNKNOWN`; never blindly resubmit.
- Only reconciliation can resolve an unknown submission.
- Partial fills update exposure immediately.
- Protective-order failure generates a critical alert and invokes the configured fail-safe; it must never be silently ignored.

## 13. Execution orchestrator pseudocode

```python
async def execute(intent: TradeIntent, actor: Actor) -> ExecutionResult:
    stored = await intent_repo.create_once(intent)
    if stored.idempotency_key != intent.idempotency_key:
        raise DuplicateIntentError

    controls = await controls_repo.lock_current()
    connection = await connection_repo.get_for_update(intent.connection_id)
    account = await account_repo.get(intent.account_id)
    instrument = await symbol_service.resolve(account.id, intent.canonical_symbol)
    capability = await capability_service.current(account.id)

    decision = await risk_kernel.evaluate(
        intent=intent,
        controls=controls,
        connection=connection,
        account=account,
        instrument=instrument,
        capability=capability,
    )
    await intent_repo.record_risk_decision(intent.intent_id, decision)

    if decision.outcome != "ALLOW":
        return await intent_repo.finish_non_execution(intent.intent_id, decision)

    if intent.mode == ExecutionMode.MANUAL and not actor.confirmed:
        return await intent_repo.await_confirmation(intent.intent_id)

    request = broker_request_factory.build_explicit(
        intent=intent,
        instrument=instrument,
        capabilities=capability,
        risk_decision=decision,
    )

    adapter = broker_registry.for_connection(connection)
    await intent_repo.mark_submitting(intent.intent_id)

    try:
        result = await adapter.submit_order(request)
    except SubmissionOutcomeUnknown as exc:
        await intent_repo.mark_unknown(intent.intent_id, redacted(exc))
        await reconciler.enqueue_urgent(account.id, intent.intent_id)
        return ExecutionResult.unknown(intent.intent_id)

    await order_repo.record_ack(intent.intent_id, result)
    return ExecutionResult.from_submission(result)
```

## 14. Reconciliation

Reconciliation is not an optional reporting feature. It is part of execution safety.

Run:

- Immediately after connection
- Before enabling trading
- After authentication renewal
- Periodically while connected
- Immediately after an unknown submission or stream gap
- After process restart/deploy
- Before reopening after a freeze

Compare broker-authoritative balances, open orders and positions against ARX. Any unexplained mismatch sets the connection to `FROZEN` or `DEGRADED` according to severity; position/order mismatches block new entries.

Reconciliation must not manufacture missing orders. It records provenance and resolves only from broker-authoritative identifiers/events.

## 15. HTTP API

```text
GET    /api/brokers/catalog
GET    /api/broker-connections
POST   /api/broker-connections
GET    /api/broker-connections/{id}
POST   /api/broker-connections/{id}/oauth/start
GET    /api/broker-connections/oauth/callback/{broker}
POST   /api/broker-connections/{id}/test
POST   /api/broker-connections/{id}/discover
POST   /api/broker-connections/{id}/reconcile
POST   /api/broker-connections/{id}/pause
POST   /api/broker-connections/{id}/resume
POST   /api/broker-connections/{id}/rotate
DELETE /api/broker-connections/{id}

GET    /api/broker-accounts
PATCH  /api/broker-accounts/{id}/allocation
PATCH  /api/broker-accounts/{id}/risk-profile

POST   /api/execution/intents
POST   /api/execution/intents/{id}/confirm
POST   /api/execution/intents/{id}/cancel
GET    /api/execution/intents/{id}
GET    /api/execution/orders
GET    /api/execution/positions

GET    /api/trading-controls
POST   /api/trading-controls/master
POST   /api/trading-controls/automation
POST   /api/trading-controls/freeze
POST   /api/trading-controls/close-only
POST   /api/trading-controls/kill-switch

GET    /api/trading-workspaces
POST   /api/trading-workspaces
GET    /api/trading-workspaces/{id}
POST   /api/trading-workspaces/{id}/members/invite
PATCH  /api/trading-workspaces/{id}/members/{userId}
DELETE /api/trading-workspaces/{id}/members/{userId}
GET    /api/trading-workspaces/{id}/assignments
POST   /api/trading-workspaces/{id}/assignments
PATCH  /api/trading-workspaces/{id}/assignments/{assignmentId}
POST   /api/trading-workspaces/{id}/assignments/{assignmentId}/pause
POST   /api/trading-workspaces/{id}/assignments/{assignmentId}/revoke
POST   /api/trading-workspaces/{id}/close-only
POST   /api/trading-workspaces/{id}/kill-switch
```

All write endpoints require authorization, replay protection, an audit reason and strict schemas. Live confirmations use a short-lived server-side confirmation challenge bound to the exact immutable intent; changing price, quantity, symbol, account or protections invalidates it.

## 16. Adapter certification contract

Every adapter must pass the same suite against a venue sandbox/demo or deterministic fake transport:

- Authentication success, expiry, refresh, revocation and wrong-account tests
- Account and capability discovery
- Runtime symbol discovery and precision constraints
- Market-data heartbeat, stale detection and reconnect
- Balance, positions and open-order retrieval
- Market/limit/stop orders where supported
- Unsupported-order rejection before network submission
- Client-order-id/idempotency behavior
- Broker rejection mapping
- Partial fill and multiple-fill aggregation
- Cancel race with fill
- Disconnect before acknowledgement -> `UNKNOWN`
- Stream gap -> urgent reconciliation
- Restart recovery
- Broker state mismatch -> freeze
- Demo/live endpoint separation
- Secret and log redaction
- Rate-limit backoff without duplicate submission
- Mutation tests proving the risk, mode and reconciliation gates can fail red

An adapter cannot advertise a capability until a test demonstrates it.

## 17. Broker-specific implementation rules

### Deriv

- Separate REST account/setup from WebSocket trading.
- Use short-lived authenticated WebSocket setup/OTP flow.
- Discover active symbols at runtime.
- Model options/multipliers/accumulators separately from MT5 CFD positions.
- Commission/cost assumptions are account- and instrument-specific.

### OANDA

- Separate practice and live endpoints.
- Treat transaction stream/order transaction IDs as authoritative.
- Model units, trade/position netting and attached protection explicitly.

### IBKR

- Implement the chosen Web API authentication model without mixing it with TWS gateway assumptions.
- Market-data subscriptions and account permissions are explicit capabilities.
- Handle confirmation/reply flows and session health where required.

### Alpaca

- Separate paper/live endpoints and credentials.
- Use OAuth for multi-user access.
- Treat equities, options and crypto capabilities separately.

### TradeStation

- Bearer token lifecycle and streaming reconnect are first-class.
- Multi-user access waits for the required business approval.

### Tradier

- Separate sandbox/live tokens.
- Preserve option symbology and multileg semantics; never flatten multileg risk into independent legs without explicit authorization.

### tastytrade

- Support dry-run/preflight where exposed.
- Treat complex orders as atomic broker requests when supported.
- Reconcile REST state with account streams.

### Tradovate

- Maintain access-token/session lifecycle and WebSocket sequencing.
- Futures contract expiry and quantity/margin semantics are explicit.

### Saxo

- Implement pre-trade disclaimers/confirmations required by the API.
- Market-data entitlement is separate from theoretical instrument coverage.

### cTrader

- OAuth scopes distinguish read-only `accounts` from full `trading`.
- Broker/account capability discovery is mandatory because cTrader is a platform across brokers.

### IG

- Use REST for commands/state and Lightstreamer for real-time updates.
- Preserve IG EPIC identifiers and deal-reference confirmation flow.

### Capital.com

- Keep session tokens alive and rotate safely.
- Because keys provide trading authority, connection onboarding must clearly disclose scope.

### FXCM

- Choose a currently supported API for the user's legal entity; do not build against a deprecated wrapper by assumption.

### Schwab

- OAuth application approval and callback security are prerequisites.
- Account hash/identifier handling must remain adapter-internal.

### Crypto exchanges

- Use trade-only keys; withdrawals disabled.
- Require IP restrictions where supported.
- Separate spot, margin, perpetual, futures and options capability/risk models.
- Account mode, leverage, position mode and margin mode must be reconciled before trading.
- Exchange and jurisdiction eligibility is checked before connection and periodically thereafter.

## 18. Observability and incident controls

Metrics:

- Connection/session health
- Market-data age and gaps
- Submit-to-ack and ack-to-fill latency
- Reject, partial-fill and unknown-outcome rates
- Reconciliation mismatch count and age
- Risk denials by rule
- Slippage vs expected
- Position/exposure by account, venue, asset and correlation group
- Token refresh failures
- Rate-limit utilization
- Candle completeness, same-broker backfill success and unresolved market-data gaps
- Market-data provenance violations (target: zero)

Alerts:

- Unknown order outcome
- Broker/ARX position mismatch
- Lost broker stream
- Stale market data
- Protective order failure
- Daily loss/drawdown breaker
- Unexpected live endpoint access
- Credential failure/rotation
- Kill-switch or master-control change

No secret or raw credential material enters metrics, traces or logs.

## 19. Delivery phases

### Phase 0 — audit and foundation

- Inventory existing MT5 bridge, execution, risk, account, order, position, secret, flag and audit code.
- Produce a reuse map and collision report.
- Add canonical interfaces/schema behind disabled feature flags.
- Preserve all existing behavior.

### Phase 1 — read-only broker hub

- Broker catalog and connections UI
- Secure authentication
- Account/capability/symbol discovery
- Balances, positions and open orders
- Health and reconciliation
- Broker-native quotes, ticks and historical candles with provenance and entitlement status
- Same-broker candle storage/backfill; no external market-data subscription
- Existing MT5 represented through the same connection model
- No order submission

### Phase 2 — Deriv demo execution

- Initial four-instrument runtime discovery
- Deterministic risk kernel integration
- Execution state machine/idempotency/events
- Demo orders, fills, exits and reconciliation
- Replay, shadow and mutation testing

### Phase 3 — OANDA practice and one U.S. paper broker

- OANDA practice
- Alpaca paper or Tradier sandbox selected according to product scope
- Cross-broker exposure and correlation risk
- Global controls

### Phase 4 — additional adapters

- Implement P1 adapters one at a time through the certification contract.
- P2/P3 adapters remain catalogued as unavailable until onboarding and eligibility are proven.

### Phase 5 — limited live

- Owner/admin approval
- Exact account and allocation limits
- Live credentials and endpoint proof
- One-tap manual confirmation
- Close-only and kill-switch drills
- Small capped allocation
- Automated mode remains separately OFF

### Phase 6 — controlled automation

- Independent approval
- Tighter risk profile
- Per-strategy/per-symbol breakers
- Continuous reconciliation and incident response
- Gradual allocation increases only after measured evidence

## 20. Definition of done

The system is not complete because 20 broker names appear in the UI. It is complete when:

- Existing ARX/MT5 behavior is audited and reused without duplication.
- Self-Trading and Managed Allocation share one execution truth while preserving ownership, actor and authority provenance.
- Managed users cannot see credentials or exceed assignment/workspace/account limits.
- Account assignment revocation and Master kill-switch behavior are proven under concurrent order submission.
- Live shared-netting-account allocations remain blocked unless broker-native segregation or explicit certification exists.
- Connections are secure, revocable and legally eligible.
- Venue capabilities and symbols are discovered, not guessed.
- Quotes and candles come from the connected execution broker, retain provenance and are never silently substituted across venues.
- The UI never confuses read-only, demo, paper and live.
- Every order follows the same immutable intent, deterministic risk, approval, idempotency, event and reconciliation pipeline.
- Manual live uses one final confirmation; automation is independent and stricter.
- Live defaults OFF and cannot silently fall back to simulation.
- Acknowledged is not treated as filled.
- Unknown outcomes block duplicate submission and trigger reconciliation.
- Position/order mismatches freeze new entries.
- Global/per-account kill switches and close-only controls are proven.
- Secrets never reach frontend code, logs or ordinary database output.
- Every advertised adapter capability is contract-tested and mutation-tested.
- Replay, shadow and demo stages pass before limited live is considered.

## 21. Claude Code implementation instruction

Use this document as the binding build specification. First perform a read-only audit of the current ARX repository and return:

1. Existing modules/tables/routes/flags that satisfy each section
2. Collision and duplication risks
3. Current MT5 bridge state and what must be retained
4. Proposed smallest dependency-ordered implementation slices
5. Tests that prove each safety gate can fail red

Do not edit until the audit is reviewed. After approval, implement Phase 0 and Phase 1 first on a new branch. Do not enable live execution, do not add live credentials, do not change owner/admin approvals, and do not create placeholder/fake adapters that report connected. An unimplemented broker must return an explicit `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED` disabled state.
