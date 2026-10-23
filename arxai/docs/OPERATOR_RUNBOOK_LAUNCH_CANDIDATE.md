# ARX AI — Operator Runbook (`ARX_AI_LAUNCH_CANDIDATE_0.1`)

For the on-call operator. Every procedure here is paper-safe (no live trade
is fired by following these steps).

## 1. Verify live execution is OFF

```bash
# Env probe (will print nothing if unset — which is the safe state)
echo "ARX_LIVE_BROKER_EXECUTION_ENABLED='${ARX_LIVE_BROKER_EXECUTION_ENABLED:-<unset>}'"
```

Then confirm the 16-gate evaluator denies:

```bash
pnpm --filter @workspace/scripts run test:live-phaseB
# expect: 19/19 live Phase B gate tests passed
# expect probe #17: master-switch-off appends BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED
```

## 2. Confirm no-live-command evidence

```bash
psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"
# expect: 0
```

Snapshot before/after any deploy or staging action.

## 3. Pause all live trading (kill switch)

UI: **`/admin/trading-control`** → "Engage Kill Switch" → confirm.

DB-direct (emergency):

```sql
UPDATE arx_global_kill_switch SET engaged = TRUE, engaged_at = NOW();
```

Verification:

```bash
pnpm --filter @workspace/scripts run test:live-kill
# expect: T3 killSwitchEngaged=true; T4 new live refused USER_NOT_ARMED_FOR_LIVE
```

Release:

```sql
UPDATE arx_global_kill_switch SET engaged = FALSE;
```

## 4. Enable close-only mode

UI: **`/admin/trading-control`** → "Enable Close-Only" → confirm.

Behaviour: new opens blocked at the Phase B evaluator; explicit close
commands still allowed.

## 5. Pause a single user

UI: **`/admin/operator-command-center`** → user row → "Pause".

DB-direct:

```sql
UPDATE user_master_live_access SET armed_for_live = FALSE WHERE user_id = $1;
```

## 6. Pause a symbol

UI: **`/admin/trading-control`** → Symbol Allowlist → remove symbol.

DB-direct (per-user):

```sql
UPDATE user_risk_settings
   SET allowed_symbols = array_remove(allowed_symbols, $2)
 WHERE user_id = $1;
```

## 7. Pause a bridge (per-user MT5 connection)

UI: **`/admin/master-bridge`** → user row → "Revoke".

DB-direct:

```sql
UPDATE mt5_connections SET revoked_at = NOW() WHERE id = $1;
```

EA's next heartbeat will be rejected; no new commands will be issued to that bridge.

## 8. View NEEDS_REVIEW

UI: **`/admin/reconciliation-center`** → filter status = `NEEDS_REVIEW`.

DB-direct:

```sql
SELECT id, user_id, kind, detected_at, summary
  FROM reconciliation_items
 WHERE status = 'NEEDS_REVIEW'
 ORDER BY detected_at DESC
 LIMIT 50;
```

## 9. Export audit evidence

UI: **`/admin/audit-log-center`** → choose category + date range → Export (CSV or JSON).

Server masks: bridge tokens, hashes, IPs (except for OWNER), session secrets,
account numbers (except for OWNER).

## 10. Revoke shared master access

UI: **`/admin/master-bridge`** → user → "Revoke Access".

DB-direct:

```sql
UPDATE user_master_live_access
   SET revoked_at = NOW(), armed_for_live = FALSE
 WHERE user_id = $1;
```

## 11. Bridge heartbeat failure

Symptom: a user's MT5 Setup page shows heartbeat > 15s old.

Steps:
1. Check the user's EA is still attached to a chart in MT5.
2. Check `ServerBaseUrl` in EA inputs matches the Replit URL (no trailing slash).
3. Check `BridgeToken` in EA inputs is the per-user token from MT5 Setup (**never** the system `MT5_BRIDGE_TOKEN` env value — it is rejected).
4. EA Experts tab should show `EA version=1.27` and ACK lines.
5. If still failing, advise the user to detach and re-attach the EA.

## 12. Handle stuck reservations

Symptom: queue depth growing, commands stuck in `SENT_TO_MT5_DEMO`.

```sql
-- Inspect
SELECT id, user_id, status, created_at, NOW() - created_at AS age
  FROM mt5_demo_commands
 WHERE status = 'SENT_TO_MT5_DEMO'
   AND created_at < NOW() - INTERVAL '5 minutes'
 ORDER BY created_at;

-- Cancel (only if EA confirmed not running)
UPDATE mt5_demo_commands
   SET status = 'CANCELLED_ORPHAN', cancelled_at = NOW()
 WHERE status = 'SENT_TO_MT5_DEMO'
   AND created_at < NOW() - INTERVAL '5 minutes';
```

## 13. Handle user support issue

1. Look up user in `/admin/operator-command-center`.
2. Check their `user_master_live_access`, `user_risk_settings`, `virtual_trading_accounts`.
3. Check their recent demo commands + reconciliation items.
4. If account state looks correct but user reports issue, ask for screenshot + reproduction steps.
5. Never share another user's data when investigating.

## 14. Rollback

1. Identify last-good Replit checkpoint (UI: Replit sidebar → Checkpoints).
2. Restore to that checkpoint. The platform replays codebase + DB to that point.
3. After rollback, re-verify:
   ```bash
   pnpm --filter @workspace/scripts run qa:final-go-no-go
   psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"   # expect 0
   ```
4. If rollback was due to a safety incident, file an incident report against `replit.md` `## Known issues` section.

---

## Emergency contact tree

- On-call operator: (fill in)
- Backup operator: (fill in)
- Replit support (for platform issues): https://replit.com/support
