# Performance and reliability operations

These changes bound advisory/display work. They do not change strategy signals,
risk limits, live dispatch gates, broker confirmation, or execution authority.

## Configuration

- `ARX_DB_POOL_MAX` defaults to 10 per process; accepted range 1–100. Budget the
  sum across replicas, workers, migrations, and administration below the database
  connection limit. Increasing replicas without this budget can exhaust it.
- `ARX_DB_CONNECT_TIMEOUT_MS` defaults to 10000; accepted range 1–120000. This
  bounds connection acquisition, not SQL execution or broker operations.
- Verify the application's PostgreSQL connections use UTC (`SHOW TimeZone`).
  Existing timestamp-without-time-zone defaults are interpreted as UTC by the
  application. In an isolated America/New_York database, three existing
  deduplication/reconciliation tests failed on both the original and modified
  source; they passed on UTC connections. Do not change a populated production
  database's timezone or rewrite timestamps without auditing existing data and
  migration semantics. The optimization patch does neither automatically.

## Behavior and bounds

- Session authorization, expiry, and roles are read from the database on every
  request. Only last-seen telemetry is limited to one update per minute.
- Account stream reads share one running task and one trailing refresh per
  subscriber, with a 250 ms minimum start gap and the existing 3-second fallback.
  This does not share reads across subscribers or processes.
- Account/chart SSE display streams buffer at most one frame after writable
  backpressure. Intermediate display updates are dropped until drain; a socket
  stalled for 10 seconds is destroyed and unsubscribed. Frame size is not capped
  by this helper. This transport must never carry order commands or sole broker
  execution evidence.
- Account fallback polling has one in-flight request, a 10-second deadline, and
  cancellation on recovery/unmount. Superseded responses cannot replace newer
  SSE evidence. Missing balance evidence is not promoted to fresh.
- Advisory single-flight caches retain pending jobs beyond their reuse TTL to
  prevent duplicate work. Completed result freshness is never extended. When
  all bounded slots are pending, new keys are rejected until capacity returns.
- Scanner cache retention is capped at 1000 entries. These caches are process
  local; they are not a distributed consistency mechanism.
- AI deadlines cancel the SDK transport and cover streaming body reads. Models,
  prompts, token budgets, tool permissions, and SDK retry policy are unchanged.
- The monitor and Ruby outcome workers skip overlapping ticks and expose stop
  behavior. Whole-process graceful shutdown/drain is still incomplete across
  the other workers and long-lived streams.

## Diagnostics

The existing authenticated admin diagnostics show bounded per-route p50/p95/p99,
5xx counts, process CPU, memory, event-loop utilization, and PostgreSQL total,
idle, and waiting connections. CPU is process usage relative to one core and can
exceed 100%. Samples are process local and reset on restart. Pool waiting raises
`DATABASE_POOL_WAITING` in the admin payload; this is not an external pager.
Other existing bridge, freshness, reconciliation, AI, and execution diagnostics
remain in place. No new production SLO or broker latency claim is implied.

## Verification

Use a disposable local PostgreSQL database with the repository schema. Keep
`ARX_LIVE_BROKER_EXECUTION_ENABLED=false` and omit real provider/broker keys.
Never point fixture tests at production.

```sh
pnpm install --frozen-lockfile
PORT=55441 BASE_PATH=/ pnpm run build
pnpm run ci:guards
pnpm run check:performance
ARX_PERF_TEST_DB=1 pnpm --filter @workspace/api-server run test:performance
pnpm run ci:integration
pnpm --filter @workspace/trading-dashboard exec vitest run
```

`DATABASE_URL` is required even by some nominally offline guards. Database
performance fixtures additionally require `ARX_PERF_TEST_DB=1` and a localhost
database URL. The security regression CI script expects an already-running API
at `BASE_URL`; use the real production authentication posture, a test session
secret, `ARX_BETA_INVITE_REQUIRED=true`, and a test registration-key pepper.
The historical `api-server/tests/*.test.mjs` suite retains localhost:80 and
retired-route assumptions and is not the canonical integration lane.

The build enforces an initial-JavaScript budget of 720000 raw / 210000 gzip bytes
(Node gzip defaults). It counts script and modulepreload references in built
HTML. Lazy-loaded route chunks are additional bytes when those routes open.
The budget is not a measurement of browser startup time or 60 FPS rendering.

Before production rollout, resolve the existing frontend registry/navigation
test failures, audit database timezone/data semantics, run a realistic staged
load/soak test with execution disabled, and verify reconnect, acknowledgement,
partial-fill, restart, and reconciliation behavior against an authorized demo
broker. Deployment and real broker execution are not part of this patch.

## Rollback

Revert the optimization patch and rebuild/redeploy using the existing release
procedure. No database migration or dependency-version change accompanies it.
Do not roll back by disabling authorization, risk, freshness, or reconciliation
checks. Keep broker execution governed by the existing owner-controlled gates.
