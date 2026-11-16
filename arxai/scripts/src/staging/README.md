# Disposable staging acceptance

Run `pnpm --filter @workspace/scripts run qa:staging:full` from the workspace.
The runner requires local PostgreSQL CLI binaries (`initdb`, `pg_ctl`, `psql`)
on PATH; `ARX_TEST_PG_BIN` may select their directory.

Each invocation creates a unique empty database, pushes the current schema,
starts the real Express app on an ephemeral loopback port, and runs every
listed acceptance suite. Application DATABASE_URL, broker/model credentials,
existing API URLs and NODE_OPTIONS are not inherited. Execution workers remain
paused and a preload rejects public HTTP requests and socket connections.
The runner refuses production or an enabled live-execution master switch.

For CI with an already running disposable PostgreSQL cluster, explicitly set
`ARX_STAGING_PG_URL` to its local Unix-socket/loopback administrative URL. The
runner creates and drops its own randomly named database there. It never uses
the supplied connection's existing database as the test database. Passwords,
remote hosts and connection-query overrides other than host/port are refused.

Per-suite logs and server startup logs remain in the printed temporary evidence
directory. Failed suites, timed-out descendants, oversized output, secret
markers and leftover command fixtures all fail acceptance. Temporary databases
and the API listener are cleaned up. A passing local run proves these acceptance
contracts against the checked-out code; it does not certify a deployed service
or broker operation.

`test:staging-harness` exercises environment isolation, network boundaries,
subprocess failure/timeout cleanup, and bounded SSE inspection. It is in root CI.
