# ARX launch preparation — 2026-10-25

Production API and web builds, five launcher tests and seven production HTTP checks passed on an isolated database. The API now builds and runs the nested ARX application. The initial launch wrapper enforces production auth, invite-only registration, LIVE disabled, and removes legacy shared broker credentials and account bootstrap variables from its process. No app was published.

The rehearsal created zero users, DEMO commands or LIVE commands. Its API and isolated PostgreSQL were stopped. The development workflow and account data were not changed by this rehearsal. See the JSON companion for configuration and evidence hashes. Private logs: `.arx-tier1-private/launch-20261025`.

The configured provider chain answered, but AAPL and EURUSD observations were from Friday. Neither returned bid/ask; EURUSD M1 candles were empty. A quote freshness defect discovered by that probe is being fixed separately. Connectivity alone does not pass market readiness.

Before publishing, confirm the public origin, production database isolation and an always-on worker topology. The API starts in-process watchdogs, reconcilers and feed caches, while the outer configuration currently says autoscale. A dedicated always-on instance is a candidate; no paid hosting option was selected. Production backup/migrations, email delivery, current market data and an owner-selected DEMO lifecycle remain unverified. Live activation is not authorized.

Architecture: `docs/ARCHITECTURE_MAP.md`. Owner procedure: `docs/TIER1_OWNER_RUNBOOK.md`.
