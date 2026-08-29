# Round A — itemized changes and follow-ups (2026-08-19)

Branch `prodready/20260819`, three commits on top of `main` @ `8f115c2`. Verified locally: full workspace typecheck clean, **59/59 CI guards**, `test:emergency-kill-switch-gate` 7/7, `test:coaching-no-fabricated-exit` 10/10, `navAccessTier` 23/23, `backtest-route-honesty` 8/8, `coming-soon-affordances` 9/9. DB-backed lanes not run locally (no database, by rule) — run full `pnpm run ci` on Replit.

## Commit 1 — P0 fixpack
`SESSION_SECRET` fatal-if-missing in production; production CORS same-origin (opt-in `ARX_CORS_ALLOWED_ORIGINS`); doc corrections (18 gates, 56→59 guards note, 7 strategies, bridge-v2 endpoints live, isolation status current).

## Commit 2 — Un-clobber (the big one)
Reverts `9185c8b` ("Git commit prior to merge"), which had committed a stale workspace over the in-flight fix-pack merge. Restores: 30+ honesty/race QA tests, `liveCommandCas` (CAS re-wired into the live pipeline), `provenance/`, `allocationBlown`, `contractSize`, `accountCurrency`, `eventLog` + `discoveryPipeline` schemas, `lib/{discovery,validation,features,risk,money}` sources, honest `forexIntelligence`/`indicesIntelligence`/news-risk, 3 CI guards (`check-no-fabrication`, `check-live-dispatch-cas`, `check-no-committed-pepper`). Re-deletes zombie surfaces (Build DD `marketData` routes, `systemFullHealth`, `entrySniperRepo`). `.replit` kept at HEAD (pepper removal preserved).

## Commit 3 — Round A fixes (27 files)
See the commit message for the full list. Highlights: double `/api` mount fix (dashboard readiness card works again), legacy `mt5-webhook` removed (could close an arbitrary user's trade), the three `/learning` endpoints implemented honestly, risk-settings saves no longer silently lost, nav honesty tiering with a drift-pinning test, placebo bot control removed, account-number masking, synthetic signal persistence stopped, **emergency-kill-switch pre-gate on live dispatch** (fail-closed; emergency-close exemption pinned to `killSwitchCloseBypassApplies`).

## Agent-flagged follow-ups (deliberately not done in Round A)

1. **systemHealth demo seeds**: `POST /system-health/demo` and `POST /admin-control/demo` still ungated (only `/audit/demo` was in scope); `/audit/export` + `/admin-control/*` actions log actor "ADMIN" unverified. Quick same-pattern fix.
2. **Stale `MT5_BRIDGE_TOKEN` copy sweep**: env-keyed diagnostic booleans in `mt5.ts` (lines ~120, 545, 580, 695, 1523), `assistant/featureMap.ts`, `broker/secrets.ts` (`required: true`), `appDoctor.ts`, `meMarketData.ts`, `permission.ts`, `meFirstRunReadiness.ts`, `broker.ts`, `safety-permission/evaluate.ts`, and dashboard knowledge/setup copy still reference configuring the forbidden env token. Copy/diagnostics only — no auth impact — but should be swept.
3. **`/mt5-webhook` still in `openapi.yaml`** (~line 1301) + generated clients. Remove the spec entry and re-run codegen (`pnpm --filter @workspace/api-spec run codegen`) on Replit where the toolchain is proven.
4. **`test:one-click-safety` aggregate** in root package.json doesn't include the new kill-switch test (the `ci` chain does). Optional tidy.
5. **TESTER role** can export audit/trade data (`exports.ts:16`) — explicit owner decision requested.
6. **`/learning/apply-improvements`** returns honest `applied:false NO_BACKING_STORE` — building a real improvement store is R7 territory.
7. **admin-permissions page** role switch depends on prod-disabled `dev-owner-login` — needs a real admin role-management endpoint or removal (menus-admin report).
