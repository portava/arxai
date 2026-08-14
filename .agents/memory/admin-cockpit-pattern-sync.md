---
name: Admin Cockpit + Pattern Sync (Task #752)
description: How the admin-only Admin Cockpit and its Pattern Sync engine are built in this env, and the deviation from Task #751.
---

# Admin Cockpit / Pattern Sync

**Deviation:** Task #751 (trader-facing Pattern Sync engine) was NEVER merged into
this isolated env. There was no trader-facing Pattern Sync to "remove" — the
admin-cockpit-only re-scope is satisfied by construction. Pattern Sync was built
self-contained in `artifacts/api-server/src/lib/patternSync/` (engine +
comparator), advisory-only, consumed ONLY by `GET /api/admin/cockpit/pattern-sync`.
No `/api/pattern-sync/*` routes, no `pattern_sync_*` tables, no execution wiring.

**Pattern Sync engine = pure + deterministic, ADVISORY ONLY.** Never feeds the
18-gate live pipeline / kill switch / risk limits / any execution path. Honest-empty
(`sufficient:false`) below `PATTERN_SYNC_MIN_CANDLES` (20). Risk-language only, no
profit/guarantee words. `runPatternSyncEngine(input)` → scores + levels + signature;
`comparePatternSync(inputs[], {timeframe,now})` → leader/follower/lagging + H4/M15
alignment + match scores. `patternMatchScore(a,b)` 0–100.

**Swing-pivot gotcha:** detect pivots on CLOSES, not highs/lows. A pullback
candle whose `open` == the prior peak's `close` produces an equal HIGH, which
breaks strict `>`-pivot detection on highs and yields a false `MIXED` swing
pattern. Close-based pivots avoid the wick-tie artifact (return high/low as the
level, but compare closes).

**Cockpit safety contract:** all `/api/admin/cockpit/*` routes admin/owner-only,
gate on EFFECTIVE role via `operatorRoleFromSession(req.authUser?.role)` (NOT
realRole), reject missing sessions. Every write delegates to an EXISTING audited
admin handler AND writes an `admin_cockpit_audit_log` row; relaxes no gate, adds
no execution path. Emergency actions require explicit reason (≥3 chars). Broker
account values masked unless OWNER (`maskConnection`). 3 new tables in
`lib/db/src/schema/adminCockpit.ts`.

**Backend delegation surface (verified paths):**
- gate: `operatorRoleFromSession(role)` from `lib/security/adminRoleGate.js` →
  "ADMIN"|"OWNER"|null; auth via `req.authUser` (`realRole` preserved).
- emergency close: `runEmergencyClose(scope, sourcePage, options?)` from
  `lib/live/emergencyClose.js`; scope union incl `{kind:"user",userId}`,
  `{kind:"ticket",userId,brokerTicket}`, `{kind:"all_shared"}`.
- bridge mask/detail: `maskConnection(row, now?)` from `lib/live/bridgeConnectionView.js`.
- fundbook NAV: `getPoolNav(poolId,tx?)`, `getHolding(userId,poolId,tx?)` from
  `lib/fundbook/navEngine.js`; `aggregatePoolFloatingPl` from `lib/fundbook/plAllocator.js`.
- audit read: `listAllAuditEvents(limit?)` from `lib/auditVault.js`.
- provider health: `getProviderHealthSnapshot()` from `lib/data/providerHealth.js`.
- global settings/kill-switch: `getGlobalSettings()` from
  `lib/adminTrading/safetyEnvelope.js` (emergencyKillSwitch, platformMode).
- db: `import { db } from "@workspace/db"`, tables from `@workspace/db/schema`.
- investor status: `investorProfilesTable.status` ACTIVE/PAUSED, audited in tx.
