# ARX AI — Known Issues (`ARX_AI_LAUNCH_CANDIDATE_0.1`)

Final consolidated list as of commit `e6586b6`. Every item below is **not
launch-blocking** for the documented launch scope (paper-only /
private-alpha / demo-supervised). Critical/High blockers: **0**.

## Format

Each row: **ID · Severity · Area · Issue · Workaround · Owner · Launch-blocking? · Recommended fix phase**

---

### `ARX-REFACTOR-001` · Low · @workspace/scripts typecheck

- **Issue**: `pnpm run typecheck` for `@workspace/scripts` reports `TS6059` rootDir violations on a chain of QA scripts that import deeply into `artifacts/api-server/src/lib/` (e.g. `qaScannerBridgeRouting.ts` → `demoCommandQueue.ts` → `tools.ts` → 20+ siblings; `qaScannerSelectedMarket.ts` → `selectedMarket.ts`).
- **Workaround**: Use `pnpm run ci:guards` (21/21 PASS) + `pnpm --filter @workspace/scripts run test:live-phaseB` (19/19 PASS) + arx_live_commands strict-zero as the launch gate. QA drivers run fine via tsx.
- **Owner**: backend / shared-libs
- **Launch-blocking?** No
- **Recommended fix phase**: post-launch (extract shared QA surfaces into `lib/qa-helpers` composite package)

### `ARX-MOBILE-002` · Medium · Admin wide tables on phone

- **Issue**: Reconciliation NEEDS_REVIEW grid and Audit Center exports list have > 8 columns and rely on `overflow-x-auto` horizontal scroll on iPhone.
- **Workaround**: Horizontal scroll is functional; operator UX is acceptable. Use tablet/desktop for prolonged admin sessions.
- **Owner**: frontend / admin
- **Launch-blocking?** No
- **Recommended fix phase**: post-launch (responsive-card variant)

### `ARX-MOBILE-003` · Medium · P&L calendar dense view on iPhone SE

- **Issue**: Calendar dense view squishes on 375×667; switches to list view acceptably.
- **Workaround**: List view is the default fallback on small viewports.
- **Owner**: frontend
- **Launch-blocking?** No
- **Recommended fix phase**: post-launch

### `ARX-ORCH-001` · Low · qa:staging:full orchestrator timeout

- **Issue**: `test:multi-user-trade-queue` standalone passes 46/46; via the staging-dry-run orchestrator it exceeds the 90s probe budget and is logged as `ALLOWED_FAIL`.
- **Workaround**: Run standalone before deploy — `pnpm --filter @workspace/scripts run test:multi-user-trade-queue`.
- **Owner**: scripts / orchestrator
- **Launch-blocking?** No
- **Recommended fix phase**: post-launch (raise orchestrator budget or split into 2 probes)

### `ARX-OPS-001` · By-design (informational only)

- **Issue**: `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults unset in dev and prod. Live broker dispatch will **always deny** until an operator explicitly sets it.
- **Workaround**: This **is** the workaround — it's the master safety switch. Documented in `replit.md` and `docs/LAUNCH_CANDIDATE.md`.
- **Owner**: operations
- **Launch-blocking?** No (by design)
- **Recommended fix phase**: never auto-flip

### `ARX-OPS-002` · By-design (informational only)

- **Issue**: EA-side `ReadOnlyMode` defaults `true`. Until operator flips it in MT5 → EA Inputs, every live/demo dispatch returns `REJECTED_READ_ONLY_MODE_ACTIVE`.
- **Workaround**: Safe default. Operator unsets `ReadOnlyMode` in MT5 EA Inputs after demo readiness checks pass.
- **Owner**: operations / tester
- **Launch-blocking?** No (by design)
- **Recommended fix phase**: never auto-flip

---

## Summary

| Severity | Count | Launch-blocking |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | none |
| Low | 2 | none |
| By-design notes | 2 | none |
