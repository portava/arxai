# Cockpit manual MT5 account refresh — 2 November 2026

Application `b1fb58b04d7aec791220d2bd0df81fa413c75677`, based on `4ce7e47739ce9cca77e5869080603bef97c1558e`. Development only. Not deployed or release-green; not proof of instantaneous terminal-to-screen agreement.

## Problem and change

The owner requires prompt same-account MT5 money, including external/manual changes and floating P/L. Cockpit's visible Refresh button previously refreshed the legacy slot snapshot or reconnected its stream. Displayed native broker amounts instead come from the existing personal MT5 status and shared-account summary queries. With automatic stream updates paused, the button could finish while native money stayed unchanged until a separate poll.

Explicit Refresh now requests those existing active canonical queries as well as the existing snapshot transport. It preserves their account permissions, no-store readers, exact decimal strings and currency, failure withholding and ten-second started-response deadline. It does not create another account engine, replace values with slot data, activate disabled readers, or enable automatic updates.

Manual coordinators have a lifetime separate from the stream. A pre-click in-flight request cannot consume the change: one trailing canonical read is retained after it settles. Burst notifications coalesce rather than cancel other readers. The refresh button remains busy across required canonical work, even if the slot snapshot finishes first. Cache removal retires old work; only a later explicit click can create a new manual controller. Unmount cleans owned coordination without aborting a reader shared by another mounted surface. Automatic stale recovery retains its existing transport-only path.

Only balance, equity, native account profit, credit, used margin and free margin actually supplied by the canonical report are displayed. No arithmetic substitution, allocation-to-broker substitution, new freshness timestamp, or optimistic released funds is introduced. `currentVerified: false` remains deliberate.

## Evidence

The regression renders the actual control, account card and shared provider with a real QueryClient/generated HTTP readers and synthetic responses. Before the source fix: four new tests fail and three existing tests pass. Personal and owner/shared money remained old, busy completion was premature, and failed canonical reads were not attempted.

Final focused lane: 110/110 pass across five files. Tests include all six KWD monetary fields, large decimals above safe integer range, zero equity and negative profit, both scopes, withholding/retry, pre-click races, enabled stream reconnect, cache removal, unmount and inactive/disabled readers. The assertions occur before the ordinary poll in a fake-time fixture; they are not a wall-clock or broker delivery benchmark.

At clean exact application `b1fb58b0`:

| Check | Result |
| --- | --- |
| Full frontend | 4,601 pass, 0 fail, 12 skipped; 261 passing files, 2 skipped |
| Dashboard typecheck | Pass |
| Production dashboard build | Pass; existing sourcemap and chunk-size warnings retained |
| Architecture guards | 85/87; normalized two failure blocks match previous checkpoint exactly |
| Independent source/test review | No scoped blocker; all four source hashes match application commit |

Initial expanded tests had two fixture mistakes (wrong free-margin test ID and treating heartbeat as slot-read completion); corrections and failures remain in raw logs. The first guard launch was blocked from opening its local process socket and did not run guards; its log is retained separately from the authorized run. Root/API/database suites were not rerun because no backend source changed. No real hosted browser, terminal, broker, funds or trading test ran.

## Limits and next work

- Active React Query work paused before its reader starts remains pending until connection recovery or disposal. The HTTP/body deadline does not bound that pre-start queue. This patch does not guarantee a universal ten-second completion.
- Canonical components' independent polling preferences remain as before; pausing the snapshot stream is not claimed to stop every account poll. Manual correctness is the scope of this fix.
- The earlier EA scheduling improvement remains inherited: account reports precede bulk chart uploads. Capture cadence, other synchronous work and next-timer delays still prevent an instantaneous delivery claim.
- Server notifications remain process-local with periodic recovery. Native clock quality, producer continuity, cross-process ordering, remaining consumers/fields and full terminal-receipt-to-visible-render latency still need work and separately authorized end-to-end evidence.
- User allocation ledgers, per-position estimates and whole-broker-account amounts have distinct meanings. Identical wording cannot make them the same figure. The same account/report/field must agree wherever displayed; missing or stale evidence must stay explicit.

No merge, deployment/Replit sync, existing database mutation, worker/trading activation, email or broker test. All prior Smart Chart, Scanner, Truth, self-trading, Profit Mission and competitor gaps are preserved. Prior chart artifact review is included only as review of its earlier exact source; its timing is not monetary evidence. Goal remains active.

Raw receipts: `/Users/areyouok/arx-tier1-release/account-manual-refresh-20261102/`. Portable archive and per-file hashes: `docs/validation/account-manual-refresh-20261102/`.

Archive: 17 files; SHA-256 `a14d033603d33258d98213be517bce4dea18cf0582eaa2d1ffa157edc77fbeec`.
