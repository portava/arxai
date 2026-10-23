# ARX AI Launch Candidate Go/No-Go Report

| Field | Value |
|---|---|
| Launch candidate | `ARX_AI_LAUNCH_CANDIDATE_0.1` |
| Build / commit | `e6586b6` |
| Environment tested | dev workspace (Postgres + API server + dashboard) |
| Date generated (UTC) | 2026-05-19T14:53:39Z |
| Tester / operator | Replit Agent (automated evidence collection) |

## Decision: **CONDITIONAL GO**

**Recommended launch scope:** **paper-only / private alpha / demo-supervised**.

- All 36 safety/privacy/secret items from the previous QA Fix Gate are PASS
- 23 of 24 automated suites PASS (1 ALLOWED_FAIL is a pre-existing orchestrator-timeout artifact, not a product bug)
- `arx_live_commands` count strict 0 → 0 across full QA matrix
- Production live execution defaults **OFF** at the server master switch
- No live trade was fired

**Why CONDITIONAL not full GO** — three explicitly documented non-product constraints (none of them violate the GO rules, but they bound the launch surface):

1. `ARX_LIVE_BROKER_EXECUTION_ENABLED` remains unset in production (by design — operator must flip explicitly). Live broker dispatch will **always deny** until an operator engages it. Public live execution is therefore **not** in scope for this candidate.
2. Pre-existing `TS6059` rootDir cascade in `@workspace/scripts` (`ARX-REFACTOR-001`) — affects only tsx-runtime QA drivers, no shipped artifact; documented in `KNOWN_ISSUES_LAUNCH_CANDIDATE.md`.
3. Mobile QA is intentionally manual via `docs/MOBILE_QA_CHECKLIST.md` (no Playwright/JSDOM harness exists in this repo).

The candidate is **safe for paper-only/private-alpha/demo-supervised launch** today. Public live execution requires the documented operator approval flow + explicit master-switch flip.

---

## Major systems reviewed (evidence)

| System | Evidence | Result |
|---|---|---|
| End-to-End Staging Dry Run | `pnpm --filter @workspace/scripts run qa:staging:full` | **OVERALL PASS** — 23 PASS / 1 ALLOWED_FAIL / 0 FAIL |
| Launch Candidate Freeze | `docs/LAUNCH_CANDIDATE.md`, `docs/RELEASE_NOTES.md` | docs in place, version `ARX_AI_LAUNCH_CANDIDATE_0.1` |
| Manual Mobile QA + iPhone Safari | `docs/MOBILE_QA_CHECKLIST.md`; viewport + 16px input + Ruby z-40 fixes shipped | 33/33 mobile gate items PASS |
| Production Launch Readiness | `test:launch-readiness` | PASS |
| Audit Log Center + Evidence Export | `test:audit-log-center` | **19/19 PASS** (no-secret-markers, 403 for non-admin) |
| Broker/Regulatory Mode Separation | `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` (16-gate evaluator) | enforced; `test:live-phaseB` 19/19 PASS |
| Reconciliation Center | `test:reconciliation-center` | **26/26 PASS** |
| Close-Only Emergency Mode | `test:live-pipeline`, `test:live-kill` | 9/9 + 7/7 PASS |
| Live Readiness Dashboard + Kill Switches | `test:live-kill` engage/release/USER_NOT_ARMED_FOR_LIVE | **7/7 PASS** |
| Ruby Voice Guardrails | `test:ruby-voice-trading-guardrails` | **29/29 PASS** |
| Ruby Full App Knowledge | `test:ruby-app-knowledge` | **63/63 PASS** |
| User Onboarding | `test:onboarding`, `test:fresh-first-load` | **18/18 PASS** (no mock/fake in production pages) |
| Per-User Private Workspace | `test:per-user-isolation` + `per-user-isolation-me-routes` guard | **13/13 PASS** (214 `/me/*` handlers scanned) |
| Shared Master Ledger | `test:master-bridge`, `test:master-bridge-live` | 18/18 + 30/30 PASS |
| Virtual Balance / Risk Profiles | `test:per-user-account-shell` | PASS |
| Multi-User Queue | `test:multi-user-trade-queue` | **46/46 PASS** (standalone; orchestrator timeout = pre-existing tooling note) |
| Admin Approval Console | `test:master-bridge-gate`, `test:master-live-access` | 19/19 + 19/19 PASS |
| Scanner / Ruby Market Explanation | `scanner-selected-market-safety` guard via `ci:guards` | PASS (empty + safetyNote when no TwelveData key, never simulator data) |
| Trade Position Chart Window | `test:position-mini-chart` | **53/53 PASS** |
| CI invariant guards | `pnpm run ci:guards` | **21/21 PASS** |

## Blockers

| Severity | Count | Notes |
|---|---|---|
| Critical | **0** | none |
| High | **0** | none |
| Medium | 2 | `ARX-MOBILE-002` (admin wide-table responsive variant), `ARX-MOBILE-003` (P&L calendar dense view on iPhone SE) — both have working fallbacks |
| Low | 1 | `ARX-REFACTOR-001` (pre-existing scripts rootDir cascade) — QA-only drivers, no shipped artifact |

## Remaining risks

- Voice cannot be fully unit-tested without a real device — coverage relies on `test:ruby-voice-trading-guardrails` 29/29 + manual checklist Tester walk-through.
- Production live execution gates rely on a one-way human-operator action (master switch flip) — by design, but means the live happy-path is only verifiable in a staged production with explicit approval.
- Pre-existing `multi-user-trade-queue` standalone-only timing exceeds orchestrator 90s budget — annotated, not a product bug.

---

## No-live-command evidence

| Probe | Value |
|---|---|
| `SELECT COUNT(*) FROM arx_live_commands` BEFORE | **0** |
| `SELECT COUNT(*) FROM arx_live_commands` AFTER | **0** |
| Delta during 23-suite QA sweep | **0** |
| Confirmation | **NO live trade was fired** (staging-dry-run footer states this explicitly) |

## Safety-gate evidence

- `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` — 16 gates, default-deny — verified by `test:live-phaseB` (19/19 incl. master-switch-off appends `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` sentinel).
- `live-broker-execution-defaults` guard (9-invariant bundle) — PASS in `ci:guards`.
- `master-live-bridge-binding-non-bypassable` + `master-live-user-approval-required` guards — PASS.
- Kill switch: engage → live refused (`USER_NOT_ARMED_FOR_LIVE`); release → demo readiness still reachable.
- Disclosure gate (Gap A): `test:live-phaseB` #18 `DISCLOSURE_NOT_ACCEPTED` BLOCKED.

## Privacy evidence

- `per-user-isolation-me-routes` CI guard — scanned **214 `/me/*` handlers across 42 route files**, all PASS.
- `test:per-user-isolation` — User A cannot see User B trades/P&L/notifications; logout clears seeded session+rows.
- No shared-master global totals returned to normal users (`test:master-live-access` PASS).
- Ruby admin-context only resolves for authenticated admins (`test:reconciliation-center` #22-23 PASS).

## Secret-masking evidence

- `master-bridge-secrets-not-leaked` guard — PASS.
- Staging-dry-run secret-marker probe — `scanned=4, found=0`.
- `test:audit-log-center` no-secret-markers across all 19 probes.
- Server stores SHA-256 hashes only; raw bridge tokens shown exactly once at creation, never re-served.
- Legacy server-wide `MT5_BRIDGE_TOKEN` env value rejected on every EA endpoint.

## Admin-protection evidence

- `test:audit-log-center` user-blocked-categories → **403**.
- Admin endpoints in `routes/admin*` all behind `requireRole("ADMIN"|"OWNER")` middleware.
- `routes/adminTrading.ts` follows header-hint-must-match-session pattern; client-supplied role headers never trusted.

## Mobile / iPhone Safari evidence

- Viewport now `viewport-fit=cover` (notched-iPhone safe area active).
- Inputs/textareas/selects forced to ≥16px on `<= 767px` (no iOS auto-zoom).
- Floating Ruby trigger lowered to `z-40` so modals (`z-50`) overlay it; bottom nav `z-30` unchanged; open Ruby panel `z-50` unchanged.
- `docs/MOBILE_QA_CHECKLIST.md` — 20 routes × 4 viewport sizes, 33/33 prior mobile gate items PASS.
- `pnpm --filter @workspace/trading-dashboard run typecheck` — green.

## Ruby / Ruby Voice evidence

- `test:ruby-app-knowledge` **63/63 PASS** (app questions, account state, blocked-trade reasons, no profit claims, no legal claims).
- `test:ruby-voice-trading-guardrails` **29/29 PASS** (voice cannot bypass confirmation, sanitizeForSpeech present, transcripts ignored when empty).
- AI assistant safety envelope hardcoded: `{safetyMode:"paper_only", liveLocked:true, readOnlyMode:true, allowOrderExecution:false}` on every response.

## Audit / export evidence

- `test:audit-log-center` **19/19 PASS** including: admin-export-invalid-format-400, user-blocked-categories-403, admin-categories-presets-200, no-secret-markers.
- Exports masked at the server boundary; never returned for non-admin sessions.

## Compliance / legal-warning evidence

- Disclosure gate is gate #18 in Phase B 16-gate evaluator — `DISCLOSURE_NOT_ACCEPTED` blocks live dispatch.
- `docs/SAFETY_NOTES.md` lists the inviolable invariants and untouchable surfaces.

## Production-readiness evidence

- `test:launch-readiness` PASS.
- `ARX_LIVE_BROKER_EXECUTION_ENABLED` unset in dev and (per policy) prod — master-switch gate denies.
- `live-broker-execution-defaults` 9-invariant bundle PASS.
- `/api/healthz` returns `{status:"ok", app:"ARX AI", version, uptime, timestamp}` — no secrets.
- `/api/me/status` unauthenticated returns `{error:"AUTH_REQUIRED", message:"Sign in required."}` — no stack trace.
- `test:fresh-first-load` confirms no `MOCK_`/`FAKE_`/`const mockX`/`const fakeX` in 11 production user pages.

## Rollback readiness

- All changes in this candidate are additive (no schema migrations in the freeze sprint).
- `docs/OPERATOR_RUNBOOK_LAUNCH_CANDIDATE.md` documents step-by-step rollback.
- Replit checkpoints created at each turn allow per-commit rollback.

## Recommended next action

1. Operator runs `pnpm --filter @workspace/scripts run qa:final-go-no-go` immediately before deploy.
2. Confirm `SELECT COUNT(*) FROM arx_live_commands` reads `0` before deploy.
3. Deploy under paper-only / private-alpha scope using `docs/FINAL_LAUNCH_CHECKLIST.md`.
4. **Do not** flip `ARX_LIVE_BROKER_EXECUTION_ENABLED` without the documented operator-approval flow.
5. Walk 6-tester `docs/ALPHA_TESTER_CHECKLIST.md` + `docs/MOBILE_QA_CHECKLIST.md` on real iPhones.
