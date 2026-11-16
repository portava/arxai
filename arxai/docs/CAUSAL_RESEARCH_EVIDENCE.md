# Durable diagnostic research evidence

This adds an internal server module and a prepared PostgreSQL migration on top of `arx-mid-ohlc-research-v1`. It does not add a route, worker, startup task, UI integration, strategy promotion or broker execution. The existing engine remains a fixed-parameter diagnostic with explicitly declared midpoint prices and scenario costs. Storing its output does not make it a verified broker backtest.

## Acceptance contract

- The caller supplies the owner only from authenticated server context. There is no request-body owner authority. Every read, list and request key is owner scoped.
- The server runs the pinned engine itself, then stores the exact input/configuration/output as canonical JSON text. Caller-provided results or hashes are not accepted. Dataset/source references must be the same opaque UUID; source attribution is never silently rewritten. Negative-zero numeric inputs are refused because JSON would otherwise erase their sign and change the reloaded snapshot. Request fields are whitelisted; no prompt, account credential, arbitrary name or note field exists.
- An exact same-owner request retry resolves the original record before quota checks, including at capacity. Conflicting dataset, source, input or configuration under that key is refused. No outcome can be updated in place.
- Success follows PostgreSQL COMMIT acknowledgement. A failed or uncertain commit never returns accepted evidence. Retrying the same key discovers the actual durable state. A failed rollback discards the client rather than returning an uncertain transaction to the pool.
- Full reads verify canonical payload/manifest hashes, their semantic links and a fresh run of the pinned deterministic engine. Metadata pages verify only manifest metadata and explicitly return `payloadVerified: false`.
- The result's exact `authority.persistedExperiment=false` and original limitations remain unchanged. The outer storage receipt separately proves committed evidence, without granting promotion or broker verification.

## Schema and concurrency

`research_experiments_v1` stores owner/request/dataset UUID identity, exact engine/strategy/manifest versions, input/configuration/strategy/result/payload/manifest hashes, scalar input/byte counts, canonical text and a recorded timestamp. A unique `(owner_id, request_id)` index prevents duplicate records. `(owner_id, created_at DESC, id DESC)` supports bounded keyset metadata pages; pages never return result payloads.

CPU validation, simulation, cloning and hashing happen before the transaction. The transaction explicitly uses READ COMMITTED and a dedicated two-integer advisory namespace (`1095915602`, owner ID). A per-owner insert trigger uses the same namespace and sums scalar byte/count metadata, never payloads. Direct inserts under non-READ-COMMITTED isolation are refused: waiting for an advisory lock must not preserve an old repeatable-read quota snapshot. PostgreSQL remains authoritative across processes. The transaction does not acquire any trading, command, position or ledger lock.

Initial bounds are 10,000 bars, 8 MiB per canonical result, 256 records and 256 MiB of canonical payload per owner, and 50 metadata records per page. These are refusal limits, not a production capacity claim. Lock and statement timeouts are local to the transaction. Pool acquisition/connection timeouts remain the responsibility of the authenticated caller's existing pool; this module creates no pool or timer.

The migration checks row/hash/manifest consistency and prevents ordinary UPDATE, DELETE and TRUNCATE. A privileged database administrator can disable triggers or change both payload and hashes. This is not cryptographic WORM, an external signature, a full selection-history audit or a guarantee that a declared dataset came from a real market. Hashes identify supplied evidence; they do not authenticate its provenance.

## Release and retention gaps

Migration-before-use is required. The migration is prepared only and was tested only on disposable local PostgreSQL. Schema-push does not install its constraints/triggers. No external database was changed.

Owner deletion is RESTRICTed while evidence exists. There is no expiry, purge, export policy, privileged correction workflow or account-deletion exception yet. These retention/privacy decisions must be resolved before deployment. The owner argument is a trusted internal contract; any later route must authenticate it and enforce request limits. Future engine versions need their own explicit reader/manifest compatibility policy rather than rewriting this evidence.

Legacy float4 backtest history is unchanged. The engine continues to report price units per unit, not account-currency returns. Repeated trials, optimization selection, untouched holdout, real spreads, liquidity, partial fills and terminal behavior remain unverified.

## Verification and measurement

Run `pnpm --filter @workspace/api-server run test:research-evidence-postgres` with PostgreSQL binaries available, or `ARX_TEST_PG_BIN` pointing to their directory. The runner creates a unique temporary Unix-socket-only cluster, does not inherit application credentials and always attempts to stop/remove it. Failure preserves its database log. This test is registered in the existing explicit integration lane; no claim is made that a remote workflow ran.

The optional paired benchmark uses `ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH=/absolute/output.json` with the same runner. It alternates engine-only computation and full engine-plus-committed-evidence return on the same generated 5,000-bar input/configuration, including cloning, hashes, database checks, inserts and COMMIT. It also measures verified full reads. Median/p95/p99/max and every raw sample are retained; the predeclared durable-completion p95 budget is 100 ms. The engine-only path is a processing reference with less responsibility, not a competitor or durability-equivalent speed claim. No broker, public provider, network deployment or frontend time is measured.

The local final database run passed 25/25 assertions, including the paired timing case. The generated 5,000-bar artifact was 1,535,547 bytes. Full durable completion was median 41.175 ms, p95 42.563 ms, p99/max 53.010 ms; the engine-only processing reference was median 4.653 ms, p95 4.870 ms and p99/max 5.054 ms. Verified full reads were median 15.123 ms, p95 19.012 ms, p99/max 21.115 ms. PostgreSQL 17.11 had `fsync=on` and `synchronous_commit=on`. The 100 ms local completion p95 budget passed; this is not a production or competitor measurement.

The receipt at `/Users/areyouok/arx-tier1-release/causal-research-evidence-20261026/receipt.json` retains exact source hashes, all raw timing samples and setup/type failures. The initial sandbox shared-memory failure and subsequent exhausted shared-memory-ID retry were resolved by removing only the exact unattached segment left by this task's failed disposable initdb, not by changing or stopping any existing database.

## Primary approach references

- [PostgreSQL INSERT](https://www.postgresql.org/docs/current/sql-insert.html): unique-index behavior and conflict handling; this module resolves exact retries and refuses conflicts rather than updating output.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): transaction-scoped advisory locks and normal database lock ownership. Isolation must still be chosen deliberately.
- [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html): JSONB normalizes representation; exact canonical text preserves the engine's numeric serialization while checked JSONB projections validate semantic links.
- [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking/): experiment parameters, metadata and artifacts are established tracking responsibilities. This bounded store does not claim MLflow feature parity or model-registry capability.
