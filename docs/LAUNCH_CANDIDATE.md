# ARX AI — Launch Candidate

**Version:** `ARX_AI_LAUNCH_CANDIDATE_0.1`
**Status:** Feature surface FROZEN — bug fixes only beyond this point.

## Hard launch invariants (must hold at all times)

- `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults **unset/false** in dev and prod.
- `arx_live_commands` row count must not grow during any QA or test run.
- Demo path is the default. Live path is default-deny with 23 gates (see
  `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`).
- Legacy server-wide `MT5_BRIDGE_TOKEN` env value is rejected on every
  EA endpoint. Per-user bridge tokens only.
- Server stores SHA-256 hashes of bridge tokens. Raw tokens are shown
  exactly once at creation and never re-served.
- AI assistant (Ruby) cannot place trades, modify connections, or read
  another user's data. Every response carries
  `{safetyMode:"paper_only", liveLocked:true, readOnlyMode:true, allowOrderExecution:false}`.

## Do not enable live without explicit approval

Setting `ARX_LIVE_BROKER_EXECUTION_ENABLED=true` flips the runtime gate
from "always deny" to "evaluate 23 gates." It does **not** auto-fire
trades. But it requires written operator approval AND a green run of
the launch gate commands listed below.

## Required pre-deploy QA commands (the launch gate)

```bash
pnpm run ci:guards                                       # 56/56 invariant guards
pnpm --filter @workspace/scripts run test:live-phaseB    # 19/19 truth table
psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"
```

All must exit 0; the `arx_live_commands` count must read `0` before and
after the QA sweep.

> **Note on root `pnpm run typecheck`:** the `@workspace/scripts` package
> has a pre-existing `TS6059` rootDir cascade from QA-only drivers
> (documented in `KNOWN_ISSUES.md` as `ARX-REFACTOR-001`). It does not
> affect any shipped artifact. The gate above is the authoritative
> launch criterion.

## Environment checklist

- [ ] `DATABASE_URL` set (Postgres)
- [ ] `SESSION_SECRET` set (non-default)
- [ ] `TWELVEDATA_API_KEY` set (or scanner returns honest empty)
- [ ] `ARX_LIVE_BROKER_EXECUTION_ENABLED` **unset** or `false`
- [ ] `MT5_BRIDGE_TOKEN` env variable **unset** (legacy — rejected)

## Deployment checklist

- [ ] `pnpm run ci:guards` 21/21
- [ ] `pnpm --filter @workspace/scripts run test:live-phaseB` 19/19
- [ ] `SELECT COUNT(*) FROM arx_live_commands;` before == after == 0
- [ ] `pnpm --filter @workspace/api-server run typecheck` green
- [ ] `pnpm --filter @workspace/trading-dashboard run typecheck` green
- [ ] Production secrets configured (no defaults)
- [ ] All admin routes return 401/403 to unauthenticated/non-admin probes
- [ ] No raw bridge tokens, hashes, IPs, or account numbers in any API response
- [ ] Operator Command Center page loads for OWNER/ADMIN, 403 for users

## Rollback notes

- All schema changes in this candidate are additive — rollback by
  reverting application code; DB columns can remain.
- No destructive migrations have been issued.
- Disable live broker execution by unsetting `ARX_LIVE_BROKER_EXECUTION_ENABLED`.
- If a runaway live command is detected: engage the global kill switch
  via `/admin/trading-control` → Emergency Kill, then investigate.

## Freeze guard

After this candidate is cut, code changes should be classified as one of:

- **HOTFIX** — critical bug / safety / privacy. Allowed.
- **DOC** — documentation, release notes. Allowed.
- **TEST** — adding regression coverage. Allowed.
- **FEATURE** — requires explicit re-opening of feature surface. Blocked
  by convention; do not merge without written approval.
