# ARX AI — Safety Notes — Untouchable Surfaces & Live-Trading Sensitivity

_Originally written 2026-05-11 (Build B). Headline status reconciled 2026-06-12 to Phase-B-live reality (per [`ARX_DEEP_SYSTEM_AUDIT.md`](./ARX_DEEP_SYSTEM_AUDIT.md) §7.2/§7.3)._

> **⚠️ Current reality (read first — supersedes the Build-B/MVP framing below).**
> - **Branding** is **ARX AI — Analyze. Risk. eXecute.** (not "High Roll Trading AI").
> - **The product is NOT paper-only.** **Phase B live broker execution exists** and
>   runs **default-deny** behind a **23-gate** evaluator
>   (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`) + the server master
>   switch + per-user arming + admin approval + kill switch. `canPlaceTrades:false`
>   holds **only on the advisory / intelligence APIs** (still CI-enforced), not the
>   whole system. THIS environment sets `ARX_LIVE_BROKER_EXECUTION_ENABLED="true"`
>   for controlled owner/admin live testing (satisfies only gate #1 of 18).
> - **Live gate count is 18** (the original 16 + **#17 `MISSING_TAKE_PROFIT`** and
>   **#18 `DISCLOSURE_NOT_ACCEPTED`**, both governance-conditional). See replit.md
>   "Current safety gates".
> - **MT5 bridge auth is per-user only.** The legacy server-wide `MT5_BRIDGE_TOKEN`
>   env value is **rejected** everywhere; the "503 when `MT5_BRIDGE_TOKEN` unset"
>   behavior described in §3/§5 below is historical.
>
> The default-deny safety posture is unchanged: no gate is weakened anywhere.

This document describes the **inviolable invariants** of ARX AI and identifies the surfaces that are sensitive, mock-only, broker-credentialed, or require human confirmation before live execution. **Read this before modifying anything in `artifacts/api-server/src/lib/safetyCore.ts`, the vault tables, or any MT5 surface.**

For architecture overview see [`ARCHITECTURE_MAP.md`](./ARCHITECTURE_MAP.md).

---

## 1. Inviolable invariants (CI-enforced)

These rules are enforced by automated guards in `scripts/src/ci/`. Violating them fails the `pnpm run ci` pipeline and must not be silenced or allowlisted without an architectural review.

| # | Invariant | Why | Guard |
|---|---|---|---|
| 1 | **`canPlaceTrades` is `false` on the advisory / intelligence APIs.** Those surfaces (e.g. `executionIntelligence`, `risk`) return `canPlaceTrades: false as const`. | The advisory surfaces never execute — live execution is the separate Phase B pipeline (default-deny, 23-gate), not these APIs. Flipping `true` on an advisory route would falsely imply it can place orders. | `check-can-place-trades.ts` |
| 2 | **Vault tables are append-only**: `audit_events`, `vault_events`, `state_transitions`. No `UPDATE`, no `DELETE`, ever. Forward-fix via corrective events. | The vault is the source of truth for audit, replay, and dispute resolution. Mutating it destroys auditability. | `check-vault-mutations.ts` |
| 3 | **No `console.*` in server runtime code.** Use `req.log` in route handlers and the singleton `logger` (`lib/logger.ts`) elsewhere. | `console.*` bypasses Pino redaction (auth headers, cookies) and structured logging. Allowlisted: `lib/db/src/seed/`, tests, scripts. | `check-no-console.ts` |
| 4 | **No two routes share `(method, path)`.** | Express's last-registered-wins behavior masks bugs and enables silent overrides. | `check-route-collisions.ts` |
| 5 | **No two schema files define the same table name.** | Drizzle accepts either silently and you lose track of authority. | `check-duplicate-tables.ts` |
| 6 | **Leaf artifacts may not import from each other.** Share via `lib/*`. | Maintains independent build/deploy units. | `check-cross-artifact-imports.ts` |
| 7 | **No NEW circular deps in `lib/domain/src`** (10 pre-existing snapshotted as known debt). | Cycles break tree-shaking and signal leaky abstractions. | `check-domain-circular.ts` |

---

## 2. Do not touch without explicit approval

| Surface | Why it's protected |
|---|---|
| `lib/db/src/schema/auditEvents.ts` | Vault event log table. Add columns only via additive migration; never rename or drop. |
| `lib/db/src/schema/safetyCore.ts` | Defines the singleton `safety_core` row + `vault_events` + `state_transitions`. Schema changes here cascade through every safety check. |
| `artifacts/api-server/src/lib/safetyCore.ts` | The trade gate, kill-switch, system-mode setter, vault emit, and global-state driver all live here. Changes must be paired with new tests in `tests/phase1*.test.mjs` and reviewed against this doc. |
| `artifacts/api-server/src/lib/vaultIntegrity.ts` and `vaultLogger.ts` | Merkle-style vault integrity helpers. |
| `artifacts/api-server/src/lib/auditVault.ts` | Append-only audit helper. Never add a mutation API. |
| `scripts/src/ci/check-*.ts` | The guards themselves. Removing or weakening a guard requires the same review as removing the invariant it enforces. |
| `scripts/src/ci/known-domain-cycles.json` | Ratchet baseline for the circular-dep guard. Entries should only be **removed** (when a cycle is fixed), never added. |
| `lib/db/drizzle.config.ts` | Drizzle migration config. Changing it can affect production migration state. |

---

## 3. Live-trading sensitive (treat as production code)

| Surface | Sensitivity |
|---|---|
| `artifacts/api-server/src/routes/trades.ts` | Authoritative trade lifecycle. Hosts `POST /api/execute-trade` (the broker entry point). Currently returns mock execution; replace with real bridge in production. |
| `artifacts/api-server/src/routes/mt5.ts` | MT5 EA bridge. Every EA endpoint requires a **per-user** `X-MT5-Bridge-Token` (`bridgeAuthPerUserOnly`); the legacy server-wide `MT5_BRIDGE_TOKEN` env value is **rejected** everywhere. Calls without a valid per-user token fail-closed. |
| `artifacts/api-server/src/routes/execution.ts` | Execution-side handlers. Verifies trade gate verdicts before persisting. |
| `artifacts/api-server/src/routes/executionIntelligence.ts` | Execution scorecard / decision. Returns `canPlaceTrades:false` everywhere. |
| `artifacts/api-server/src/routes/system.ts` | Kill-switch + system-mode endpoints. State transitions go through `safetyCore.driveGlobalState`. |
| `artifacts/api-server/src/routes/risk.ts` | Risk audit + position-size endpoints. Advisory; `canPlaceTrades:false`. |
| `artifacts/api-server/src/lib/strategyEngine.ts` | The 5 strategies + No-Trade filter. Changes here change every signal. |

**Rule of thumb:** any change to these files should run `pnpm run ci` AND `VAULT_OVERRIDE_TOKEN=phase2-test-token pnpm --filter @workspace/api-server run test` before merge.

---

## 4. Mock / demo only (safe to iterate)

| Surface | Notes |
|---|---|
| `artifacts/api-server/src/lib/data/providers/mockProvider.ts` | Synthetic candle generator. Used as default data source. |
| `artifacts/api-server/src/lib/strategyEngine.ts::generateSyntheticCandles` | Synthetic data for the demo bot loop. Replace with real feed for production. |
| `pages/scanner.tsx` "demo bot loop" (5s polling) | Frontend-only polling demo; no orders are placed. |
| `lib/db/src/seed/` | Seed scripts are allowed to use `console.*` (build-time). |

---

## 5. Requires broker credentials (env-gated)

| Variable | Required for | Behavior when unset |
|---|---|---|
| `DATABASE_URL` | All persistence | Server fails to start (auto-provisioned in Replit env) |
| ~~`MT5_BRIDGE_TOKEN`~~ (legacy — **rejected**) | Nothing — the server-wide bridge token is no longer accepted on any EA endpoint. | Auth is **per-user only**: tokens are issued from MT5 Setup (`POST /api/me/mt5-connections`), stored as SHA-256 hashes, and shown exactly once. Setting this env value has no effect. |
| `VAULT_OVERRIDE_TOKEN` | Test-only vault overrides | Production behavior unchanged; only used in test suite |
| `LOG_LEVEL` | Pino log level | Defaults to `info` |
| `NODE_ENV` | Toggles pino-pretty in dev / JSON in prod | Defaults to development pretty-print |

**Never log, return, or commit any of these values.** Use the environment-secrets skill to manage them.

---

## 6. Requires human confirmation before live execution

The MVP is paper-mode-only, so this section is **future-state**. When `LIVE_TRADING` becomes a real mode (Build C/D + constitution amendment), the following must hold:

1. **No silent execution.** AI may *recommend*, but the final order must originate from an explicit user gesture (button click) — not from a polling loop, not from a webhook, not from a scheduled job.
2. **Pre-trade checklist must pass** for every live order:
   - System mode is `LIVE_TRADING` (not `OBSERVE_ONLY` / `PAPER_TRADING` / paused / replay)
   - Kill-switch is **not engaged**
   - `safetyCore.tradeGate(intent)` returns `APPROVED` (not `REDUCE_ONLY` or `HARD_BLOCK`)
   - MT5 heartbeat is fresh (last `< 30s`)
   - Symbol is in the user's allowed list
   - Lot size is within the user's `risk_settings.maxLotSize`
   - Estimated risk ≤ `risk_settings.maxRiskPerTrade`
   - Spread is acceptable (`<= symbol.maxSpread`)
   - Market condition is not `NO_TRADE`
   - Replay/practice mode is **not** active for the same symbol
3. **Every confirmation attempt is logged** to `audit_events` (append-only) with the full pre-trade snapshot, the verdict, and the user identity — even rejected attempts.
4. **No replay/practice trade may hit `routes/trades.ts` or `routes/mt5.ts`.** Replay routes (`replayLab.ts`, `replayLabSim.ts`) are call-graph-isolated from execution routes (architecturally enforced today; CI guard for this is a future addition).
5. **The kill-switch button is always one click away** from any page (Topbar-mounted; Build B).

**Ruby AI-Assisted execution (Task #319) — bounded executor, not a second path.**
Ruby is no longer strictly read-only: a user may grant
`rubyExecutionAuthority = AI_ASSISTED` to let the assistant place/manage **live**
trades. This does **not** create a new execution route. Every Ruby trade action
funnels through the SAME instant-trade router → live command pipeline → Phase B
23-gate dispatch as a manual trade (source `ruby_text`/`ruby_voice`).
`AI_ASSISTED` skips ONLY the extra app-side confirmation prompt (rule 1's
"explicit user gesture" is satisfied by the user's prior, persisted, per-action
authority grant) — it never skips a backend gate, per-user approval,
allocation, or kill-switch check. Ruby actions are additionally bounded by
per-action permissions, per-Ruby caps (lot/open-positions/daily-trades), and a
symbol/asset-class allowlist, and are recorded in the append-only
`ruby_commands` ledger (pending-dedupe + idempotency; watches fire exactly once
via CAS). `AI_AUTO` is defined in the model but **not enabled**.

**Ruby's *reported* safety state is derived, not hardcoded.** What Ruby *says*
about the account's live-state (`liveLocked` / `safetyMode` / `readOnlyMode` /
`allowOrderExecution`) is derived per-user from `getEnvelope()` (via the shared
`deriveAssistantEnvelope` helper, fail-closed to `FAIL_CLOSED_ENVELOPE` =
off/locked on any read failure) on every conversational surface, the
`getTradingMode` / `getPaperSafetyStatus` tools, the `read-chart` /
`explain-signal` reads, the realtime voice bootstrap, and the system prompt —
never a static `paper_only` constant. This changes only what Ruby *reports*,
never what it is *allowed to do*: the order-guard chain, the 23-gate Phase B
dispatch, and the explicit per-trade confirmation choreography are untouched, and
read/advisory surfaces still place no orders (they additionally force
`readOnlyMode: true`). The genuinely read-only chart-brain / decision surfaces —
`draw-setup` and `draft-read` (the latter's OpenAPI response pinned to
`safetyMode: enum:[paper_only]`) — deliberately keep the forced
`READ_ONLY_PAPER_ENVELOPE` constant.

**Today's known soft spots:**

- `pages/emergency.tsx` references `/api/execute-trade` in user-facing copy (lines 574–578). The backend route enforces the trade gate, so the user cannot bypass safety this way. **Action:** in Build E, audit any future raw-fetch additions and prefer the generated `useExecuteTrade` hook from `lib/api-client-react`.
- **Replay isolation is convention-only today** (no CI guard). `replayLab.ts` and `replayLabSim.ts` happen to import nothing from `trades` / `mt5` / `execute*` / `safetyCore`, but that property is not enforced. **Action:** add `scripts/src/ci/check-replay-isolation.ts` in Build D so the property cannot regress.
- Multiple "intelligence" backends (`forexIntelligence.ts`, `indicesIntelligence.ts`, default `marketBrain` candle source) currently use hardcoded macro tables + synthetic candles. They are wired end-to-end but their *content* is demo data. **Action:** documented in `pages/stocks-center.tsx` mock banner; full replacement requires connecting a real market-data provider.

---

## 7. Preserved at all costs (never delete, even if "looks unused")

| Item | Why |
|---|---|
| Any row in `audit_events`, `vault_events`, `state_transitions` | Audit chain integrity. |
| Any row in `aiDecisionLog` | Replay reproducibility + scoring history. |
| Any row in `trades` | User trade history, even closed/cancelled. |
| Any user data (`users`, `user_settings`, `tradeJournal`, `watchlists`) | User-owned content. |
| Schema migrations under `lib/db/migrations/` (when present) | Migration history must be linear; never edit a past migration. |
| OpenAPI operation IDs in `lib/api-spec/openapi.yaml` | Renaming an operation breaks all generated hooks across the frontend. |
| `replit.md`, `docs/ARCHITECTURE_MAP.md`, `docs/SAFETY_NOTES.md`, `docs/IMPLEMENTATION_ROADMAP.md`, `docs/BUILD_AUDIT.md` | Living docs; update in place rather than replacing. |

---

## 8. Compliance / claims hygiene

- **Never make guaranteed-profit claims** anywhere in the UI, marketing copy, or system messages. Wins/edge are probabilistic projections.
- The `DisclaimerBanner` component (`components/compliance/DisclaimerBanner.tsx`) must remain visible on any page that surfaces P&L, signals, or AI recommendations.
- Confidence scores must always be paired with a method-of-derivation (visible or one-click-away). Build E's `ExplainabilityCard` formalizes this.

---

## 9. When in doubt

- **Run `pnpm run ci`** before committing.
- **Run the full test suite** (`VAULT_OVERRIDE_TOKEN=phase2-test-token pnpm --filter @workspace/api-server run test`) for any change touching `safetyCore`, `strategyEngine`, `mt5`, `risk`, `trades`, `system`, `execution`, `executionIntelligence`, or any vault/audit table.
- **Update this document** whenever a new invariant is introduced or a sensitive surface is added.
- **Ask** before deleting *anything* under `lib/db/src/schema/`, `routes/`, or `lib/safetyCore.ts`.
