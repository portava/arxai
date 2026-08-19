# ARX Multi-Broker Foundation Audit

**Status:** Review required — read-only audit; no implementation authorized  
**Scope:** Maps `attached_assets/ARX_AI_MULTI_BROKER_IMPLEMENTATION_1787155023264.md` to the current ARX TypeScript, Drizzle, Express, React, and MT5 architecture.  
**Audit result:** ARX has a reusable **MT5-specific read-only and default-deny execution foundation**, but does **not** yet have a tenant-scoped multi-broker connection hub. Phase 0 must begin with compatibility contracts and safety guards, not an adapter, credential flow, or execution path.

## 1. Executive decision

The specification's safety principles align with the current product:

- deterministic controls outrank AI;
- broker acknowledgement is not a fill;
- live trading remains default-deny;
- current MT5 manual and AI-assisted live actions use the existing Phase B pipeline and its 18 gates;
- broker-originated symbols and market data must not be guessed or silently substituted;
- reconciliation evidence is safety-relevant; and
- credentials and broker account identifiers must not leak.

However, the specified target is a Python/UUID-oriented general broker architecture while ARX is a Node/TypeScript application with numeric MT5 connection identities and an operational MT5 bridge. The specification must therefore be implemented as **additive TypeScript compatibility seams**. It must not replace the MT5 bridge, convert MT5 IDs, merge tables, force non-MT5 venues through EA-specific gates, or promote the current demonstration broker-read-only service into the production connection authority.

The current 18-gate Phase B evaluator is authoritative for **MT5 live dispatch**. It cannot be the literal common kernel for Deriv, OANDA, or another direct API because several gates require MT5-specific evidence: EA heartbeat/version, EA input flags, terminal connectivity, and terminal algorithm permission. Any later non-MT5 execution phase therefore requires a separately approved broker-neutral control plane with common deterministic gates (global controls, environment/rollout, approval, reconciliation, provenance/freshness, capabilities, risk, idempotency) plus venue-specific evidence gates. MT5 continues to route through Phase B unchanged.

### Approval recommendation

Approve only the following after review:

1. a no-I/O, read-only common broker-domain contract;
2. feature-flagged, default-disabled connection metadata and discovery schema;
3. contract/source-scan tests that pin the MT5 and Phase B boundaries.

Do **not** approve any venue OAuth/API key intake, outbound broker network calls, account connection state changes, quote/candle ingestion, demo orders, or live routing in this task's successor until the corresponding prior slice and red tests are accepted.

## 2. Current architecture inventory

### 2.1 Authority map

| Concern | Current source of truth / key paths | Current state | Audit disposition |
|---|---|---|---|
| Existing MT5 bridge identity and safety state | `lib/db/src/schema/mt5Connection.ts`; `routes/mt5.ts`; MT5 Setup pages | Per-user bridge token hashes, heartbeat, account metadata, read-only/execution locks, EA version/capabilities | **Retain as authoritative MT5 bridge state.** Future connection model references it; it does not replace it. |
| EA command mailbox | `lib/db/src/schema/mt5Commands.ts`; `routes/mt5.ts` | Per-user MT5 outbox and EA result data | **Protected.** The future hub may read/project MT5 state, never write this mailbox outside current guarded routes. |
| Phase B live commands | `lib/db` `arx_live_*` schemas; `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` | Draft → one confirmation → approved → EA mailbox; CAS and idempotency safeguards | **Protected.** It remains the only MT5 live-open path. Any future non-MT5 execution requires the separately approved broker-neutral control plane. |
| Deterministic MT5 live gate | `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` | Pure, default-deny 18-gate evaluator with MT5/EA-specific evidence | **Protected for MT5.** A later broker-neutral kernel must preserve equivalent common controls while composing venue-specific evidence; it must not alter or route around Phase B for MT5. |
| Instant trade routing | `routes/instantTrade.ts`; `lib/live/instantTrade.ts` | Live-only router; paper rejected, demo directed to its existing endpoints | **Retain.** No broker-hub execution endpoint in Phase 0/1. |
| Demo lane | `routes/demoExecution.ts`; `mt5_commands` | Separate, env-gated MT5 demo command path; real accounts fail closed | **Retain and isolate.** Do not reinterpret read-only connection data as demo permission. |
| Broker-native MT5 candles | `brokerCandles.ts`; `brokerCandleBackfillStatus.ts`; `lib/data/brokerCandleStore.ts`; MT5 candle ingestion route | Durable, bridge/account-scoped MT5 candle store and backfill status; closed bars mirror into a generic read projection | **Reusable model.** Preserve MT5 key and provenance; add a new generalized store rather than collapse source identities. |
| Market-data routing and feed verdict | `lib/data/marketDataRouter.ts`; `sharedFeedVerdictContractTest.ts` | MT5 first; real-provider fall-through with honest errors, feed freshness verdicts | **Adapt with a broker-bound request context.** Do not treat generic router success as proof that data came from an execution connection. |
| Runtime MT5 symbol discovery | `lib/mt5/symbolDirectory.ts`; `brokerSymbolName.ts`; `arx_symbol_specs`; EA `ENUMERATE_SYMBOLS` | Exact broker symbol and capability metadata, ambiguity/no-match errors | **Reusable discovery pattern.** Generalize only behind an account/connection namespace. |
| MT5 reconciliation and position truth | `routes/mt5Live.ts`; `lib/reconciliation/detect.ts`; live-position reconcile helpers; `broker-reconciliation.tsx` | Complete snapshot marker, phantom detection, audited reconcile states | **Retain.** Build generalized per-account reconciliation beside it; never downgrade existing MT5 reconciliation. |
| Audit and redaction | `audit_events`, `vault_events`, `state_transitions`; `lib/security/redact.ts` | Append-only safety evidence; redaction/masking | **Protected.** Connection actions will use the established audited mutation pattern. |
| Existing broker abstraction | `lib/broker/types.ts`, `registry.ts`, `mt5BridgeProvider.ts`, `mockProvider.ts` | Small read-only provider interface and MT5 projection | **Reuse only as a prototype.** It is process-global and insufficient for multi-tenant connections. |
| Existing broker read-only feature | `lib/brokerReadOnly/service.ts`; `routes/brokerReadOnly.ts`; `pages/broker-readonly.tsx` | Explicitly no execution; partly demo/stub data | **Prior foundation, not authority.** It requires tenant/provenance/fallback hardening before it represents real connections. |
| Legacy typed MT5 provider/secrets layer | `lib/broker/mt5BridgeProvider.ts`; `lib/broker/secrets.ts` | Still requires the deprecated server-wide `MT5_BRIDGE_TOKEN`, reads unscoped `mt5_state`/positions/orders, and publishes a hardcoded symbol list | **Do not use for the future MT5 projection.** Read per-user `mt5_connection`, owned positions/orders, and the EA-enumerated directory instead. |

### 2.2 Existing execution and safety behavior retained verbatim

The following surfaces are out of bounds for the read-only hub, and remain the MT5 execution authority:

1. **MT5 authentication and bridge transport.** EA-facing endpoints require a per-user `X-MT5-Bridge-Token`; only a hash is stored, a raw token is displayed once, and prior hash rotation has bounded grace. The legacy server-wide `MT5_BRIDGE_TOKEN` is rejected by the active architecture.
2. **The Phase B pipeline.** `createLiveDraft`, confirmation, and dispatch are the only lifecycle for an open live command. Dispatch re-evaluates the gate to prevent time-of-check/time-of-use drift.
3. **The 18-gate MT5 contract.** The master switch, user arming, approval, global controls, kill switch, account type, bridge freshness/readiness, EA capability, symbol/lot/loss controls, SL/TP governance, and disclosure remain required for MT5. The environment switch is necessary but never sufficient.
4. **The EA mailbox.** A Phase B command is mirrored into `mt5_commands` only after the guarded live command is sent. A mailbox write or acknowledgement is not evidence of execution.
5. **The demo lane.** Demo is independently enabled and bridge-gated; it is not a fallback for an unavailable broker or a route for a live request.
6. **Close/reduce-risk exception handling.** Existing narrow close behavior and global kill-switch constraints retain their present meaning. A future connection model must not broaden them.
7. **Audit and reconciliation evidence.** Append-only tables stay append-only. MT5 snapshots, bridge ticket truth, and audited reconciliation states remain authoritative.

## 3. Specification-to-current-system mapping

| Specification area | Existing implementation | Reuse assessment | Missing capability / required adaptation |
|---|---|---|---|
| Owner boundary and default-off execution (§1) | `replit.md`; `livePhaseBDispatchGate.ts`; `liveCommandPipeline.ts`; `safetyCore.ts` | Strong reuse | Add a source guard preventing new broker-hub routes/services from importing live dispatch or mailbox writers in Phase 0/1. |
| Venue catalog and onboarding (§2–3) | `BrokerKind` currently names `mock`, `mt5`, `deriv`; no durable venue catalog | Partial | A catalog may describe `ONBOARDING_REQUIRED` venues but must not imply credentials, connected state, market access, or trading capability. |
| Connection cards and global controls (§3) | MT5 Setup, Broker Read-Only, Broker Reconciliation, existing global/live controls | Partial | No per-connection owner/approval/allocation/health model; no broker-wide close-only control. UI must not be built until an owned read model exists. |
| Connection flow and credential policy (§3.2, §8) | Per-user MT5 hash-only bridge token, rotation/audit, redaction; generic provider key presence checks | Partial | No OAuth PKCE/state/nonce, KMS/envelope credential vault, venue scope inspection, or account-specific credential reference. No credential onboarding in Phase 1 until a dedicated reviewed security slice. |
| Adapter/registry architecture (§4–6) | Read-only `BrokerProvider`; MT5 and mock provider implementations | Partial | Registry is process-global and provider selection is environment-driven. The current MT5 implementation also relies on a deprecated shared secret and unscoped reads. Need connection-bound adapter factories, explicit capability/read-operation contracts, typed unavailable result, and no execution methods in Phase 1. |
| Canonical connection/account/instrument schema (§7) | `mt5_connection`, `mt5_commands`, `live_positions`, MT5 symbol directory, broker candle tables | Partial | No general `broker_connections`, `broker_accounts`, or `broker_instruments`. New additive tables must not migrate/re-key MT5 tables. Use the existing MT5 connection ID as an external/native reference. |
| Credentials and authorization (§8) | Hash-only MT5 bridge credential; redactor/masking; audit events | Partial | Dedicated encrypted per-connection credentials, OAuth lifecycle and withdrawal-scope rejection absent. This is deliberately not a Phase 0/1 connection action. |
| Eligibility and capability verification (§9) | MT5 EA capability disclosure; account type/read-only checks; role and approval gates | Partial | No durable legal-residency/venue eligibility or account-specific capability snapshots. No connection can be declared trading-ready in Phase 1. |
| Symbol normalization/discovery (§10) | Exact MT5 resolver, account symbol directory, EA enumeration | Strong pattern | Current generic symbol data lacks broker-account identity. Add a generalized mapping keyed by owned connection/account/instrument; reject non-discovered symbols. |
| Broker-native market data (§10.1–10.3) | MT5 broker candles, ingest provenance, stale rejection, feed verdict, backfill state | Strong MT5-only pattern | Generalize provenance into every broker-bound quote/tick/candle record. Current router fall-through must be prevented from serving an execution decision absent matching broker provenance. |
| Deterministic risk kernel (§11) | 18-gate Phase B evaluator plus allocation, entitlement and instant-trade guards | Strong but MT5-specific | No new kernel in Phase 1. Before any non-MT5 demo execution, design a broker-neutral deterministic kernel for common gates and venue-specific evidence. MT5 continues through its existing Phase B evaluator unchanged. |
| Execution state machine/orchestrator (§12–13) | Phase B command lifecycle, CAS terminal writes, idempotency handling | Partial | `UNKNOWN` and `RECONCILIATION_REQUIRED` are not first-class Phase B command states; unknown delivery presently resolves to failed/expired semantics. Address only in a later, separately approved execution compatibility review. |
| Reconciliation (§14) | MT5 complete snapshots, position truth joins, phantom detection, admin reconciliation state | Strong MT5-only pattern | No broker-account-keyed reconciliation-run/discrepancy ledger or connection freeze model. Read-only health/reconciliation records come before any demo execution. |
| HTTP API (§15) | Legacy `/broker*`, `/broker-readonly*`, MT5, and `/me/mt5*` paths | Partial | OpenAPI does not document several active `/me/mt5*`, `/broker-readonly*`, and reconciliation APIs. Do not expose new connection writes until contract coverage and auth/ownership semantics are defined. |
| Adapter certification (§16) | Targeted ingestion/feed/redaction/live-gate tests; CI guards | Partial | No uniform read-only adapter certification suite or capability-evidence registry. Add this before any adapter advertises connected, real-time, or discovery support. |
| Observability/incidents (§18) | Structured logger/redaction, bridge freshness, feed verdict, alerts, reconciliation UI | Partial | Need per-connection health, provenance violation, discovery, entitlement, and reconciliation metrics. Must not log raw response or credential material. |
| Delivery phases (§19–20) | Phase B MT5 live exists; read-only broker foundation exists in part | Partial | Apply the dependency order in §6, with all other venues explicitly disabled. |

## 4. Collision and risk register

Severity means the risk to safety, data truth, tenant privacy, or architecture if implementation begins without the listed mitigation.

| Severity | Collision or risk | Current evidence | Required mitigation before affected work |
|---|---|---|---|
| **Critical** | **Silent Deriv-to-mock fallback** | `lib/broker/registry.ts` selects `MockBrokerProvider` for `deriv`; broker-read-only service also defaults unknown providers to demo. | Replace fallback only in a reviewed later slice with explicit `NOT_IMPLEMENTED` / `ONBOARDING_REQUIRED`; source test must reject unknown/Deriv→mock selection. No actual adapter until then. |
| **Critical** | **Global, unscoped broker reads** | Provider registry is singleton/process-global; read-only snapshots/logs are globally listed; routes do not use a connection owner. | Every new connection/account/instrument/read must require `authUser` and owner-scoped database predicates. Reject cross-user IDs, never derive ownership from a client-supplied provider string. |
| **Critical** | **Cross-venue market-data substitution** | Generic `marketDataRouter` has provider fall-through; durable MT5 read projection can be followed by other providers. | Require a broker-account/instrument provenance context for broker-bound reads. A same-broker proof is mandatory for any later decision/execution use; otherwise return `WAIT`/unavailable. |
| **Critical** | **Routing around Phase B or MT5 mailbox** | Spec proposes generic execution endpoints and adapters; ARX has a protected MT5 Phase B/EA flow. | Phase 0/1 adapter contract contains no mutation method. Enforce import/call-site guards: no new hub route writes `mt5_commands`, `arx_live_commands`, or calls instant/live dispatch. Any later MT5 action still uses Phase B. |
| **High** | **Hardcoded MT5 symbols masquerading as discovery** | `MT5BridgeProvider.symbols()` uses a fixed synthetic allowlist while EA directory enumeration exists elsewhere. | Future MT5 common-connection projection reads the enumerated per-user directory only and returns `DISCOVERY_REQUIRED` when unavailable. |
| **High** | **Read-only demo claims a connected broker** | `brokerReadOnly/service.ts` demo provider reports `connected:true` with synthetic content. | Separate demo fixture/test mode from real connection state. UI never labels it venue-connected or broker-native; no user/provider fallback. |
| **High** | **Credential model mismatch** | MT5 uses a hash-only bridge token; generic venue credentials are environment secrets, not per-user vault records. | Design a credential boundary separately: encrypted reference only in DB, redacted logs, OAuth state/nonce/PKCE, scope denial, rotation/revoke audit. No raw credential columns. |
| **High** | **Legacy MT5 provider contradicts active per-user auth** | `lib/broker/secrets.ts` requires server-wide `MT5_BRIDGE_TOKEN`, and `mt5BridgeProvider.ts` reports MT5 unconfigured without it, while active EA routes accept only per-user token hashes. | Exclude both legacy modules from the future MT5 common projection. Add a source/contract test requiring owned `mt5_connection` evidence and forbidding the shared-token requirement. |
| **High** | **Connection/account identity collision** | Spec calls for UUIDs; existing MT5 uses numeric IDs, position ticket uniqueness is tenant-scoped. | Do not retrofit MT5 IDs. New tables get their own immutable IDs and keep `nativeConnectionRef`/adapter metadata. All broker ticket uniqueness is `(connection/account, broker ticket)` and tenant-scoped. |
| **High** | **Acknowledgement mistaken for fill** | Existing Phase B differentiates `SENT_TO_MT5_LIVE` from `LIVE_FILLED` only with a real ticket. | Retain wording and state truth. A future read model must expose `acknowledged`, `filled`, `unknown`, and reconciliation evidence separately; no UI success on transport acknowledgement. |
| **High** | **Unknown outcomes lack first-class state** | Phase B does not expose specification `UNKNOWN` / `RECONCILIATION_REQUIRED` states. | Record as an execution-gap decision for a later execution phase; do not silently map it while adding read-only connections. |
| **High** | **Forcing direct-API venues through MT5-specific gates** | The 18-gate evaluator requires EA/terminal evidence that Deriv/OANDA cannot provide. | Preserve Phase B for MT5; before non-MT5 demo, approve a common broker-neutral gate contract plus venue-specific evidence gates. Never satisfy an MT5 gate with fabricated adapter fields. |
| **Medium** | **Duplicate broker concepts and routes** | `/broker*` typed provider API and `/broker-readonly*` snapshot service have overlapping concepts; some active paths are missing from OpenAPI. | Document one new hub namespace and leave legacy endpoints unchanged. Add OpenAPI parity before a UI consumes new APIs. |
| **Medium** | **Reconciliation is MT5-centric** | Existing page is deferred/MT5-only and reports counts; no generalized discrepancy ledger. | Add read-only per-connection snapshot/reconciliation records before trading controls or demo execution; mismatches must fail closed for later entries. |
| **Medium** | **Free-text status/capability drift** | MT5 status is text and capability JSON; specification assumes enums and common state taxonomy. | Use a typed domain normalization layer, preserve raw/native status, and distinguish `NOT_IMPLEMENTED`, `UNAVAILABLE`, `STALE`, `DELAYED`, and `CONNECTED`. |
| **Medium** | **OpenAPI/client drift hides security surface** | `/me/mt5*`, broker-read-only, and reconciliation paths lack matching OpenAPI coverage. | No new generated client/UI workflow until API contract tests cover ownership, redaction, and disabled-state envelopes. |
| **Medium** | **No broker-wide close-only semantic** | Existing global and allocation freezes are present; no clear generic broker close-only model. | Treat close-only as unimplemented in the new hub; do not claim it in UI/catalog capability metadata. |
| **Low** | **Specification language mismatch** | Spec names Python modules and exact schema names; ARX is TypeScript/Drizzle. | Translate behavioral contracts, not filenames or technology choices. Preserve source-of-truth boundaries and test intent. |

## 5. Required MT5 representation boundary

MT5 is a broker/platform implementation already operating inside ARX. A future common model must represent it without creating a second bridge.

### MT5 remains authoritative for

- bridge authentication, heartbeat, account data, EA version and EA-reported capabilities;
- exact Market Watch symbol names and account-specific discovery;
- EA command polling/results and MT5 broker ticket evidence;
- `mt5_commands`, `mt5_connection`, bridge event traces, `live_positions`, and MT5-specific reconciliation state;
- durable MT5 candle and backfill rows keyed by bridge connection and exact broker symbol;
- current demo and Phase B live behavior.

### Allowed future compatibility projection

A read-only `Mt5ConnectionProjection` may expose:

- native connection reference and owner;
- normalized connection health/status plus preserved native status;
- masked account metadata;
- discovered account capabilities and symbol directory timestamp;
- a read-only account/position/open-order snapshot;
- broker-native market-data provenance referencing the MT5 bridge/account/symbol;
- reconciliation freshness and mismatch summary.

It must be produced by **reading** existing MT5 sources. It must not:

- create a second per-user token, duplicate heartbeat table, or copy EA mailbox;
- modify MT5 connection state in response to generic connection actions;
- use a guessed/canonical display symbol in place of the exact resolved broker symbol;
- claim connected/tradable if discovery, heartbeat, entitlement, or snapshot evidence is absent;
- emit a command or bypass any Phase B, demo, authorization, or audit check.
- depend on `lib/broker/secrets.ts` or `MT5BridgeProvider`, whose shared-token requirement and global reads do not match active per-user MT5 authority.

### Later non-MT5 execution boundary (not Phase 0/1 work)

The specification's shared execution control plane is a future architecture decision, not an instruction to send every venue through the EA. Before any non-MT5 demo phase, the reviewed design must:

- define immutable broker-neutral intents and a common deterministic outcome of `ALLOW`, `DENY`, or `WAIT`;
- enforce global master/kill controls, environment/rollout, user/owner approval, fresh reconciliation, exact discovered instrument, same-connection market-data provenance and freshness, capability/account permission, deterministic risk, idempotency, and acknowledgement-versus-fill truth;
- add venue-specific evidence (for example OAuth/session health or WebSocket sequence) without fabricating MT5 heartbeat, EA version, terminal, or algorithm-permission values;
- preserve the MT5 routing branch exactly as instant trade → Phase B → 18 gates → EA mailbox;
- keep live disabled until a separate limited-live review after replay, shadow, and demo evidence.

## 6. Smallest safe dependency order

All feature flags below default to disabled. An unavailable venue must return a typed disabled result such as `ONBOARDING_REQUIRED` or `NOT_IMPLEMENTED`; it must never select mock/demo data or report connected.

### Audit closeout (this task)

- Deliver and approve this report.
- No source code, schema, route, secrets, broker credentials, account approvals, or runtime behavior changes.
- **Rollback boundary:** none; this report is documentation only.

### Phase 0A — Compatibility contracts and containment

**Goal:** Define a no-I/O, read-only common language without adding a broker connection.

- Add pure TypeScript types for connection identity, environment, normalized status, read capabilities, discovery evidence, market-data provenance, health, and explicit unavailable reasons.
- Add a read-only adapter interface containing only health/account/capability/instrument/market-data snapshot methods. Do not include order, cancel, close, or credential mutation methods.
- Add a separate MT5 projection adapter that reads per-user `mt5_connection`, owned state, and EA discovery directly; it must not wrap the legacy global `MT5BridgeProvider`.
- Add source guards that prohibit Phase 0/1 hub modules from importing Phase B dispatch, instant trade execution, `mt5_commands` writers, and live mailbox enqueue functions.
- Add a typed unavailable venue catalog. P0/P1 venue entries have no credentials and no `CONNECTED` status.

**Prerequisites:** approval of this audit.  
**Feature flags:** `ARX_BROKER_HUB_READONLY_ENABLED=false`; no execution-related flag is added or changed.  
**Evidence to advance:** pure/contract test suite proves unavailable never becomes mock, no adapter exposes mutation, and MT5 projection is read-only.

### Phase 0B — Owned metadata and credential-boundary design

**Goal:** Create only disabled, tenant-owned metadata needed to describe a future connection.

- Add additive connection/account/instrument/discovery metadata tables with immutable identifiers, `userId`, native MT5 reference support, and foreign-key/index design that prevents cross-tenant ticket/symbol collisions.
- Add metadata statuses such as `NOT_IMPLEMENTED`, `DISCOVERY_REQUIRED`, `DISCONNECTED`, `DEGRADED`, `FROZEN`, and `REAUTH_REQUIRED`; preserve adapter-native status separately.
- Add an encrypted credential-reference abstraction only after an approved security design. Persist a reference and non-secret metadata, never ciphertext in ordinary API serializers. Do not implement an OAuth route yet.
- Project existing MT5 state into the common read model; do not backfill or migrate old MT5 tables.

**Prerequisites:** Phase 0A guards/tests.  
**Feature flags:** metadata endpoints off by default; all `tradingEnabled`, `automationEnabled`, and `canPlaceLiveTrade` equivalents hard false.  
**Rollback boundary:** disable feature flag; additive tables remain unused.  
**Evidence to advance:** tenant-isolation, serialization-redaction, and MT5-no-write tests pass.

### Phase 1A — Read-only discovery with one real existing source

**Goal:** Expose a read-only MT5 common-connection view based on real current bridge evidence.

- Provide owner-scoped GET endpoints for the connection, account, capabilities, and discovered symbols.
- Use MT5 EA enumeration as the only MT5 instrument source. Missing/expired discovery returns `DISCOVERY_REQUIRED`, not an allowlist or guessed symbol.
- Return masked account references only; bind responses to authenticated owner and effective product role.
- Keep legacy broker/broker-readonly routes stable until replacement parity is accepted.

**Prerequisites:** Phase 0B and OpenAPI coverage.  
**Feature flags:** read-only UI/API off by default; no POST except internal/admin migration tooling explicitly reviewed later.  
**Rollback boundary:** route flag off; no live state is mutated.  
**Evidence to advance:** route tests prove user A cannot access user B, unauthorized callers fail, MT5 write paths remain untouched, and stale discovery is honest.

### Phase 1B — Provenance-bound market data and read-only reconciliation

**Goal:** Add common read projections for broker-native market data and broker snapshots without new execution.

- Persist/serve every quote, candle, tick, account snapshot, position, and open order with connection/account/instrument provenance, native timestamps, receive time, quality, delayed/stale/gap state, and discovery evidence.
- Reuse MT5 `broker_candles` data as an MT5 projection. Do not combine it with other broker candles in the generic `market_candles` read path for broker-bound decisions.
- Add a broker-account snapshot/reconciliation record with explicit mismatch evidence, freshness, and freeze recommendation. It is read-only in this phase.
- Require a matching connection/account/instrument provenance context for broker data requests. If same-broker data is missing, return `WAIT`/unavailable; never route to another provider or simulator.

**Prerequisites:** Phase 1A, data-quality contract, and retention/privacy review.  
**Feature flags:** read-only broker data off by default; no signal or execution consumer.  
**Rollback boundary:** disable route/UI; preserve append-only observation records and existing MT5 state.  
**Evidence to advance:** same-broker provenance, stale/gap, no-fallback, and reconciliation-mismatch tests pass.

### Explicitly deferred after Phase 1

- OAuth/API key intake, credential rotation, account linking, or credentials for any new venue;
- all broker actions including test authentication that invokes external provider calls;
- order intent schema conversion, an execution orchestrator, demo orders, fills, cancellation, close, or automation;
- Deriv/OANDA/other adapters;
- changes to Phase B gate ordering, MT5 bridge, demo queue, approval state, live flags, or global control semantics.
- the broker-neutral execution kernel and every venue-specific execution branch.

## 7. Verification matrix

Each proposed gate must have an executable negative fixture. The test names and commands below are the required contracts for the implementation slices; they do not exist yet and are not part of this read-only audit.

| Gate / proposed test | Level and controlled fixture | Injected violation that must fail red | Required assertions |
|---|---|---|---|
| **RO-01 — `brokerHubNoExecutionBoundaryTest.ts`** | Source-scan the future hub directory plus a compile-time read-adapter shape fixture | Import a Phase B/instant/demo/mailbox writer, add `submitOrder`/`cancel`/`close`, or serialize `canPlaceLiveTrade:true` | Test exits nonzero and names the forbidden import/member/token; exact read-method allowlist remains unchanged |
| **DIS-02 — `brokerHubUnavailableProviderTest.ts`** | Pure registry table with fake `mock`, unimplemented, and throwing transports; counters on every fake call | Select Deriv/unknown and return mock/demo, `CONNECTED`, or fabricated account/symbol data | Result is `NOT_IMPLEMENTED`/`ONBOARDING_REQUIRED`, all data arrays empty, live flags false, and mock/network call counts are zero |
| **TEN-03 — `brokerHubTenantIsolationRouteTest.ts`** | DB fixtures: users A/B, two connections, duplicate native ticket/symbol values; authenticated route calls as A | Request B's connection/account/instrument/snapshot/order IDs as A; query list endpoints with B rows present | 403/404 with no B identifier/body leakage; list contains only A; composite keys allow same native IDs across tenants but reject duplicates in one owned account |
| **SEC-04 — `brokerHubSecretRedactionTest.ts`** | Fake adapter error containing API key, bearer/JWT, account number, OAuth code and URL credentials; captured Pino/audit sinks and route serializer | Return/log raw fake secret/ciphertext/account identifier | Forbidden literals absent from response/log/audit; masked account and safe error code remain; redactor failure stores `{}` rather than raw payload |
| **RO-05 — `brokerHubReadAdapterMutationTest.ts`** | Fake adapter with separate read/mutation counters and a transaction spy; exercise every Phase 0/1 route | A GET/discovery/reconciliation read invokes credential rotation, provider write, DB mailbox write, or external mutation seam | Mutation counters and command-table insert counts remain zero; only allowlisted metadata/snapshot writes occur |
| **DISC-06 — `brokerHubDiscoveryRequiredTest.ts`** | Account with no discovery, expired discovery, exact symbol, suffix collision, and ambiguous V75 fixtures | Resolve a client display symbol or hardcoded fallback without current account discovery | Missing/expired returns `DISCOVERY_REQUIRED`; ambiguity returns candidates/no default; successful result preserves exact broker symbol and evidence timestamp |
| **PROV-07 — `brokerHubSameBrokerProvenanceTest.ts`** | Connection B request with only connection A candles and an available generic provider; all provider calls counted | Resolver returns A/generic candles for B or drops connection/account/instrument from output | Returns `WAIT`/unavailable; generic fallback count is zero; every success key exactly matches requested connection/account/instrument/environment |
| **DATA-08 — `brokerHubMarketDataQualityTest.ts`** | Closed/forming, stale, delayed, sequence-gap, reconnect-gap, same-broker backfill, and unavailable-backfill fixtures | Treat forming/stale/delayed/gapped data as real-time/closed, or fill a gap from another venue | Honest quality/complete flags; execution-eligible/readiness false; unresolved same-broker gap returns `WAIT` |
| **CAP-09 — `brokerHubCapabilityEvidenceTest.ts`** | Adapter certification fixture with capability claims independently toggled from evidence | Claim quote/discovery/real-time/order support with no passing evidence record | Capability is false/unavailable and adapter cannot report certified/connected for that capability |
| **REC-10 — `brokerHubReconciliationMismatchTest.ts`** | Owned broker/local snapshots for match, position mismatch, order mismatch, balance mismatch, stale snapshot and read failure | Mismatch/stale/failure reports healthy or future-new-entry eligible | Mismatch evidence is retained; status/freeze recommendation fails closed; future new-entry predicate is false; no record is manufactured to force a match |
| **MT5-11 — `brokerHubMt5ProjectionBoundaryTest.ts`** | Per-user `mt5_connection` + symbol-directory fixtures, shared-token env absent/present, global legacy rows for another user, writer spies | Projection depends on `MT5_BRIDGE_TOKEN`, uses legacy `MT5BridgeProvider`, reads another user's rows, or writes MT5 state | Per-user projection succeeds without shared token; other-user data absent; exact enumerated symbols only; all MT5/demo/live writer counts zero |
| **STATE-12 — `brokerHubExecutionStateProjectionTest.ts`** | Pure future-state fixtures: submitted, acknowledged without ticket, ticketed fill, disconnect-before-ack, reconciled outcome | Ack/transport success becomes fill, or unknown outcome is retried/resolved without broker evidence | Ack remains ack; fill requires broker evidence; unknown maps to reconciliation required and duplicate submission stays blocked |
| **API-13 — `brokerHubOpenApiParityTest.ts`** | Parse Express registrations, OpenAPI and generated schemas for the hub namespace | Add an undocumented route, secret field, write operation, or response that omits disabled/provenance fields | Route/OpenAPI sets match; auth/ownership declared; read-only phase has no venue-mutation operation; generated schema excludes secrets |

### Required phase-entry commands

When the corresponding implementation exists, register and run these deterministic lanes:

```bash
pnpm --filter @workspace/scripts run test:broker-hub-contracts
pnpm --filter @workspace/api-server run test:broker-hub-routes
pnpm --filter @workspace/api-server run test:broker-hub-db
pnpm --filter @workspace/scripts run test:broker-hub-no-execution
pnpm --filter @workspace/scripts run test:broker-candle-ingest
pnpm --filter @workspace/scripts run test:shared-feed-verdict
pnpm --filter @workspace/scripts run test:security-redaction
pnpm run ci:guards
pnpm run typecheck:ci
```

The first four are proposed successor-task scripts; a slice is not complete until its script is registered and its negative fixtures are proven to fail when the guarded violation is injected. DB-backed tenant/reconciliation tests belong in the existing integration lane, not offline `ci`.

### Required evidence before later demo or live phases

Before any execution phase, provide all of the following:

1. a certified adapter fixture demonstrating every advertised capability;
2. venue eligibility and permitted account/product evidence;
3. credential-vault design and secret-redaction test evidence;
4. runtime account and instrument discovery evidence for the exact account;
5. same-broker real-time/data-entitlement and stale/gap behavior evidence;
6. broker-account reconciliation snapshots showing balances, positions, and orders match;
7. explicit mapping from common broker-neutral intent controls to venue-specific evidence, with MT5 continuing through existing Phase B safety/risk/audit controls;
8. deterministic failure tests for every new gate, a replay/shadow record, and a kill-switch/close-only drill;
9. separate approval for demo, then separately for limited live. No evidence category can be inferred from UI state or a transport acknowledgement.

## 8. Specific current gaps to resolve only in later approved work

1. The `BrokerProvider` prototype has no quote method, no per-connection factory, and no durable capability/discovery provenance.
2. `brokerReadOnly` is a useful safety-shaped prototype but is globally scoped, permits demo fallback, and persists globally visible snapshots/logs; it cannot serve multi-user connection data unchanged.
3. The typed broker registry is process-global and maps unimplemented Deriv to a mock provider. This is incompatible with a true venue status.
4. MT5 provider symbol output is hardcoded while the EA symbol directory is the correct discovery authority.
5. The same MT5 provider still requires the rejected server-wide bridge token and reads global rows, so it must not be reused for the future per-user MT5 projection.
6. Generic market-data fall-through is intentionally useful for intelligence but is not sufficient to authorize an order for a selected broker account without a broker-provenance constraint.
7. General broker reconciliation, credential vault, account allocation, legal eligibility, and connection-specific close-only controls do not exist.
8. The live command lifecycle has strong CAS/idempotency and a real-ticket fill distinction, but it has no first-class `UNKNOWN`/`RECONCILIATION_REQUIRED` state compatible with the proposed multi-broker state machine.
9. Current OpenAPI coverage does not fully describe active MT5/read-only/reconciliation routes; this must be corrected before a new generated client becomes the source for a broker hub UI.

## 9. Audit conclusion

The safe starting point is not “add brokers.” It is to make ARX’s existing MT5 truth legible through a strictly read-only, tenant-scoped compatibility boundary, while proving that unimplemented venues stay unavailable and cannot fall back to mock/demo data.

The current MT5 bridge, demo lane, Phase B pipeline, 18-gate evaluator, instant-trade router, market-data truth handling, audit evidence, and reconciliation logic are retained and protected for MT5. Non-MT5 execution requires a later broker-neutral deterministic control-plane review; it may not fabricate EA evidence or weaken the common safety outcomes.

**This audit intentionally makes no runtime, schema, route, credential, flag, approval, provider, or live-execution change.**