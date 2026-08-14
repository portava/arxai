# Per-user data isolation — RESOLVED

**Status: CLOSED — resolved May 17, 2026.**

The original concern (May 2026) was that the first-load cleanup shipped a
**UI-only** feature gate backed by `localStorage`
(`arx_feature_unlocks_v1`) which hid MT5 account, balance, positions,
AI analysis, paper ideas, recent trades and the demo execution panel
until each feature was explicitly unlocked from the getting-started
checklist. That gate was correctly described as **not a security
boundary** — a user with devtools could flip the flag and (at the time)
see underlying single-tenant global data.

All listed remediation items have since been completed and are verified
in `artifacts/api-server`:

- [x] `mt5_connection.userId` is the per-user ownership key. The legacy
      `mt5_state` singleton row is no longer the source of truth — all
      live state is per-user via `mt5_connection`, `mt5_commands`,
      `live_positions`, `virtual_trading_accounts`, and
      `shared_trade_attribution`, all of which carry `userId` and are
      filtered on every read and write.
- [x] `paper_trade_ideas.userId` exists (`lib/db/src/schema/paperTrades.ts:9`)
      with a `paper_trades_user_id_idx` index, and every paper-trade
      read/write is scoped by user.
- [x] Trade sessions, AI-analysis history, journal entries, and
      command-queue records all carry `userId` and are scoped at the
      query layer (114 `userId` field references across the schema,
      383 `eq(<table>.userId, userId)` filter clauses across
      `artifacts/api-server/src/routes` and `artifacts/api-server/src/lib`).
- [x] `requireUser` middleware
      (`artifacts/api-server/src/lib/auth/middleware.ts`) rejects every
      anonymous request with `401 AUTH_REQUIRED`. It is wired on every
      private trading route — including the legacy paths called out in
      the original TODO (`/api/mt5/status`, `/api/trades`,
      `/api/performance/*`) and the per-user namespace `/api/me/*`
      (51 route files, 284 `req.authUser` references).
- [x] Server-driven per-user state replaces the localStorage gate as
      the source of truth for "user has connected MT5 / started paper".
      The localStorage flag is now a **UI convenience layer for
      first-load discoverability only**; the real boundary is the
      backend session cookie + per-row `userId` filter.
- [x] No frontend route or component passes `userId` in a request body,
      query string, or path parameter for ownership purposes. Every
      user-owned mutation derives `userId` from `req.authUser.id`
      server-side. Any client-supplied `userId` is ignored.

## Verification (May 17, 2026)

| Probe | Result |
|---|---|
| `GET /api/me/trades/open` unauth | **401** |
| `GET /api/me/dashboard/overview` unauth | **401** |
| `GET /api/me/notifications` unauth | **401** |
| `GET /api/me/risk-governor/state` unauth | **401** |
| `GET /api/me/mt5-connections` unauth | **401** |
| `GET /api/me/trade-decisions` unauth | **401** |
| `GET /api/me/playbooks` unauth | **401** |
| `GET /api/me/trade-journal` unauth | **401** |
| `GET /api/me/alerts` unauth | **401** |
| `GET /api/me/shared-account/state` unauth | **401** |
| `GET /api/me/reports/equity` unauth | **401** |
| `GET /api/me/performance-calendar` unauth | **401** |
| `GET /api/me/protective-auto-close/settings` unauth | **401** |
| `GET /api/me/protective-auto-close/decisions` unauth | **401** |
| `POST /api/me/activity-ping` unauth | **401** |
| `GET /api/mt5/status` unauth | **401** |
| `GET /api/trades` unauth | **401** |
| `GET /api/performance/summary` unauth | **401** |
| Routes accepting `userId` from `req.body/query/params` | **0** |
| `mt5_state` singleton row read by any user-facing route | **none** (legacy table no longer read for ownership) |

## Residual UI surface (intentional, not a security issue)

The first-load checklist (`GettingStartedChecklist.tsx`) and the
session/MT5/mode pills (`SafetyHeader.tsx`, `Topbar.tsx`) still respect
the localStorage `arx_feature_unlocks_v1` flag — purely for
progressive disclosure on a brand-new browser session. Flipping that
flag in devtools does **not** grant access to any other user's data
because every backing endpoint is auth-gated and per-user scoped at
the database layer. The UI strings have been updated (May 17, 2026)
to describe this correctly instead of pointing here.

## What is still gated by design (not user-isolation)

- **Live trading**: BLOCKED at the placement layer
  (`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`). This is a global safety
  lock, not a per-user permission.
- **Shared MT5 routing**: BLOCKED at the router. Same.
- **Auto-close execution**: ALERT_ONLY. Same.
- **MT5 commands**: force-`BLOCKED` status stamp at
  `artifacts/api-server/src/routes/mt5.ts:662`. Same.

These remain locked for every user, including the operator.
