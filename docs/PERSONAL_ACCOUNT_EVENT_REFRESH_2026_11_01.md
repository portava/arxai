# Personal account event refresh — 1 November 2026

Application commit: `1612d8cea9b58a65fd927cc664e6a40ffa1c8ccc`. Development source only, not deployed and not release-green. This combined checkout preserves the native study foundation (`650c4728` through `f280728d`) and personal native report (`4d95fb33`, ported as `badff34e`) before the new changes. Earlier independent results are not substituted for the combined checks below.

## Delivered behavior

The existing account SSE stream now issues a personal-account refresh hint after changes on the authenticated user's selected active connection. It reuses the existing connection event bus and serialized/coalesced controller. No amounts, account identifiers or timestamps are sent in the hint. The HTTP reader remains the source of monetary evidence.

Personal scope uses the same active-connection selector as `/mt5/status`, requires the connection owner to match the signed-in user, and checks the captured session before and after the awaited selection read. An authenticated user with no selected connection is distinct from unverifiable scope: the former triggers a canonical reread to clear old funds; the latter unbinds without a hint. Disconnect, revocation and close dispose listeners. Existing post-write user notifications also trigger scope reselection, so a heartbeat-driven active-connection switch can be picked up without waiting for the recovery tick. The three-second reconciliation path remains for silent/missed/cross-process changes.

The existing frontend hint coordinator now serves either the exact shared-summary key or exact personal-status key. Leading reads start immediately; hints during an older read retain one trailing refresh rather than joining and losing the update. Burst coalescing, inactive-query invalidation, cache-removal cleanup and pause/hidden/disconnect/unmount disposal are retained. Hints never update money, observation times or freshness and never stop snapshot fallback reads.

The MT5 Bridge page previously did not mount the account stream. It now uses one instance of the existing hook; header/status consumers add no streams. Its five-second poll remains an independent fallback. Every existing personal status consumer uses the same no-store generated GET with a full-response ten-second recovery deadline. That deadline includes body decoding, aborts on timeout/cancellation, and retires late responses even if the transport ignores abort. Automatic retry backoff is disabled for this shared read; existing hints, polls and manual refresh drive recovery. The shared account reader uses the same generalized implementation.

No balance arithmetic, report qualification, account selector policy, execution gate, producer, database schema, worker or broker behavior was changed.

## Validation and measurements

Independent focused checks cover actual route source, authorization/binding races, the actual Bridge page with the real QueryClient and generated GET, precise native amounts and zero equity, selected-connection removal, all three status consumers, bounded header/body reads, late responses and disposal. Backend focused lane: 54 pass. Frontend focused lane: 61 pass. These counts overlap broader checks and are not a unique coverage total.

Two quiet real-timer measurements used the actual React page, QueryClient and generated GET with an in-memory SSE event and simulated immediate HTTP response. Each batch retained all 35 samples: five warmups and 30 measured updates. Each hint initiated exactly one canonical GET; the displayed report remained explicitly unverified and zero equity stayed zero.

| Batch | Hint to DOM p95 | Hint to DOM max | Hint to GET start p95 | Warmup max |
| --- | --- | --- | --- | --- |
| 1 | 10.62 ms | 11.97 ms | 0.266 ms | 24.41 ms |
| 2 | 11.59 ms | 13.60 ms | 0.196 ms | 24.92 ms |

These are local DOM-update observations, **not physical browser presentation or terminal-to-screen delivery**. They exclude EA capture, persistence, server session/selection reads, server coalescing and real HTTP/SSE latency. No production, MT5 or TradingView speed claim follows. Raw samples and warmups are retained; the optional timing test is skipped by default in ordinary CI.

Combined checks on `1612d8cea9b58a65fd927cc664e6a40ffa1c8ccc`:

| Check | Result |
| --- | --- |
| Full dashboard, including preserved native chart studies | 4,172 passed, zero failed, 12 skipped; 241 passing files and two skipped |
| Account stream/session/producer lane | 54 passed, zero failed/skipped |
| Account projection/native personal route lane | 62 passed, zero failed/skipped |
| API and dashboard typechecks | Pass |
| API and dashboard builds | Pass; existing frontend chunk/module warnings retained |
| Architecture guards | 85/87; both failure blocks byte-identical to the native-study baseline |

The 12 skipped frontend checks include the intentionally opt-in timing check. The two guard failures remain 38 wording and three internal-name findings. Independent source review and repeated focused tests are retained; reviewed backend/frontend source hashes match the application commit. The first dashboard typecheck lacked the local React integration declaration output; a targeted local declaration build and rerun passed without changing application source. Initial failure log remains. Full root CI, real-database integration, authenticated application browser checks and terminal/broker tests were not run for this increment. Prior synthetic native-chart browser results remain tied to their original source/harness.

## Retained failures and limits

- Initial new backend cases included 12 failures, some asserting an absent capability; these are not 12 independent old runtime bugs. The own-user selection regression separately reproduced one hint instead of the expected two before route wiring.
- Frontend before receipts include ignored personal hints and the real page having no stream. Initial tests/typechecks and environment declaration failures are retained. The backend nullable-owner type mismatch was repaired with a rejection test. One root validation command used a nonexistent script name; its corrected existing lane is recorded separately.
- The bus is still process-local. Recovery can take the existing three-second reconciliation interval; the personal poll remains five seconds. A selected connection that changes without an existing notification still relies on recovery.
- The existing server scheduler has a 250 ms minimum gap, and frontend trailing reads use a fixed 25 ms window. Immediate leading dispatch is not a zero-delay guarantee under overlapping work.
- Producer capture still defaults to one second and synchronous terminal work can delay transmission. No terminal/broker acceptance or end-to-end timing was performed.
- Session/selection reads are sequential, not an atomic snapshot. An indefinitely stalled server database read is not bounded by the new client response deadline; server cancellation/load and distributed delivery remain followups.
- Personal and shared allocations remain separate scopes. Native clocks/continuity, every monetary consumer and unrelated MT5 readiness wording remain unverified or unfinished.
- The native chart foundation is still not the registered Scanner adapter. Its full integration, drawings/overlays/replay/all-consumer migration, first-study setup cost, slower-device first-click failures and TradingView/MT5 comparison gaps remain open.

No main merge, deployment, Replit edit, existing database change, worker/trading activation, order or live/demo broker test occurred. The overall architecture goal remains active.

Raw receipts: `/Users/areyouok/arx-tier1-release/account-event-refresh-20261101/`.

Repository receipt archive: `docs/validation/account-event-refresh-20261101/receipts.tar.gz`; source/receipt hashes are in its adjacent manifest.
