---
name: QA harness conventions
description: Conventions for scripts/src/qa*.ts regression harnesses that mutate the DB and hit live HTTP.
---

# Rule
Every DB-mutating regression harness under `scripts/src/` follows the same safety contract:

1. **Refuse without `QA_ALLOW_DB_MUTATION=true`.** Exit 2 with a clear REFUSED message.
2. **Refuse against production-like targets.** If `NODE_ENV === 'production'` or `QA_BASE_URL` matches `.replit.app`, exit 2.
3. **Default base URL is `http://localhost:80`** (the shared proxy), overridable via `QA_BASE_URL`. Never call service ports directly.
4. **Session minting via `authUserSessionsTable`.** Generate a random raw token, store `sha256(raw)` as `tokenHash`, send the raw token as cookie `arx_user_session=<raw>`. Track every minted `tokenHash` in an array for cleanup.
5. **Token-scoped cleanup in a `finally` block.** Delete only the rows this run created (by id arrays or by minted `tokenHash` set) — never a blanket delete.
6. **Assert `arx_live_commands` count is unchanged.** Snapshot the count at start, re-read in the cleanup block, fail if not equal. This is the universal proof that an admin-route harness did not accidentally trigger a live dispatch.
7. **OWNER fixture is user id `4`.** Verify the row exists and `role IN ('OWNER','ADMIN')` before running — otherwise admin endpoints will return 403 and the harness will produce confusing failures.
8. **Use existing `shared_master_accounts` rows.** Do not insert SMA rows from a harness — query for any `isActive=true` SMA and reuse its id.

**Why:** These rules came out of debugging an earlier round where a harness shadowed real fixtures, leaked sessions, and was indistinguishable from a live-dispatch incident. The `arx_live_commands` assertion in particular is the only mechanical proof that survives review.

**How to apply:** When writing a new `qa*.ts`, copy the header + cleanup block from `qaAttachedActiveCaseVtaVisibility.ts` (the canonical reference). Register the script in `scripts/package.json` with a `test:<kebab>` name so it composes into the full QA suite.

# Decimal columns gotcha
`virtual_trading_accounts` numeric fields (`virtualBalance`, `virtualEquity`, `virtualPnl`) are `doublePrecision` and serialise as JS `number`, not Drizzle decimal strings. Test assertions should compare numerically, not as strings.
