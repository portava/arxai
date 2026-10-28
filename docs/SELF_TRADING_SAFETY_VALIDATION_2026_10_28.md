# Safety continuation validation — 28 October 2026

Verdict: **focused checks pass; broader ARX release is not green**.
PR #99/#100/#101 remain separate draft work. Nothing merged to main or deployed.

| Evidence | Exact commit | Result |
|---|---|---|
| Full disposable server lane | `83277a73` | 569 tests: 568 pass, 0 fail, 1 skipped |
| Four workspace typechecks | `83277a73` | all pass |
| Architecture guards | `83277a73` | 89/89; 7 master-bridge syntax assertions pass |
| Single-paper-book mutation fixtures | `83277a73` | 67 pass |
| API build | `83277a73` | pass |
| Selected Risk Governor/Trade Engine integration, 14 files | `75a27546` | 171 pass, 0 fail, 0 skip; outer harness 1/1 |

`75a27546` adds only the reproducible integration test helper to `83277a73`;
application source is identical. This report is a later documentation-only
addition. Results above are not claims that every check ran on this document's
commit. The server skip is LOG-3b, requiring authorized live broker execution.
No broker behavior is proven by these tests. External connections were blocked;
both final disposable lanes recorded zero attempted external connections.

Reproduce with a locally installed PostgreSQL, setting `ARX_TEST_PG_BIN` to its
bin directory if needed. These commands create and remove a disposable DB;
do not point them at an existing development or production database:

```sh
pnpm --filter @workspace/api-server run test:isolated-server-lane
pnpm --filter @workspace/api-server run test:isolated-server-lane tests/support/risk-integration.test.mjs
pnpm run typecheck:ci
pnpm run ci:guards
pnpm --filter @workspace/api-server run build
```

Independent review found three defects, all corrected: cross-user access to
new evidence, cancellations labelled as closes, and paper references resolved
against legacy trades. The reviewer ran syntax/diff checks; the parent reviewed
the reference fix and ran DB/HTTP tests. The initial 11 policy regressions failed
11/11 on unchanged `6b77a93`. The privacy test failed before the route gates.
Six of eight typed-reference tests failed on `6b77a93`, all eight pass after.

Failed attempts remain in the local receipt: privacy processing initially ran
twice (repaired), one child integration harness initially skipped tests (not
counted as coverage), old policy fixtures failed (updated with explicit healthy
mode and AI holds), and the `6056cc08` run had a Node child-startup error plus one
guard parse failure (repaired, rerun on `83277a73`).

MT5 compilation later **passed under Mac/Wine**, build 6230, for both EAs
with zero errors/warnings and new EX5 files: [verified result](MT5_MAC_WINE_COMPILE_RESULT_2026_10_28.md).
The exact `6f9e364` package has five sources matching this branch and `cd44c73`.
The earlier terminal-running preflight produced no EX5 and remains preserved.
The rebuilt input ZIP checksum is
`24d4227e8ba7cb68851b6b6348fedd3dd5410b0135a2d91b19f541be6c9db90f`;
it is not verification of the earlier externally generated ZIP checksum.

Read [the policy and material behavior changes](SELF_TRADING_SAFETY_POLICY_2026_10_28.md).
AI confidence remains undefined. Legacy auth/admin audit writers still bypass
chain serialization. Full root CI, the full integration/frontend matrix,
combined draft-branch validation, quiet scanner/chart performance and all
TradingView/MT5 parity claims remain open. Raw logs, checksums and failed runs
are retained in the local `arx-tier1-release/resume-20261028/receipt.json` package.
