# Truth/chart source identity alignment — 1 November 2026

Base: `d535c3f32795be9bb84dc59b708137cf5c8ce66a`.
Development change only; no release or competitor-parity claim.

## Problem and change

The server already binds composed component evidence to an opaque source identity, including observed account/bridge/environment provenance. The frontend previously checked provider name and newest candle boundary, but omitted this identity. A current chart on a different underlying source could therefore preserve cached directional advice from the old source when provider and bar time coincided.

The existing TruthData contract now carries optional nullable `sourceIdentity`. The server publishes only the existing chart identity, when symbol/timeframe/provider match and its hash is well formed. It never reconstructs an identity or exposes account credentials. The scanner hook passes the same chart query's original identity into the existing symbol Truth cap. A missing, malformed or mismatching identity now withholds direction, components and levels. Existing expiry, fetch-error, source, symbol and candle-boundary checks remain in place; execution permissions are unchanged.

The field is optional for wire compatibility. Older server responses without identity still parse, but cannot preserve actionable frontend advice. Coordinated development source deployment is needed to restore confirmed advice against such older servers.

## Validation

- Before the fix: 10 new identity cases failed, 26 existing unit cases passed. All ten incorrectly preserved advice with absent/malformed/mismatching identities.
- After: five frontend files, 71 tests passed, 0 failed. Includes a real QueryClient/hook source change at the same provider and bar, plus expiry, selected-market and original chart evidence checks.
- Backend `test:truth-component-evidence`: 47 passed, 0 failed, 0 skipped. New assertions cover exact opaque identity propagation and malformed/symbol/timeframe/provider disagreement.
- Typecheck: libraries, API and scripts passed in the combined runner. Frontend initially failed because shared dependency links resolved the parent's older generated schema. A child-only dependency overlay pointing workspace packages at this worktree corrected that setup; frontend typecheck then passed. No type assertion or application workaround was added.
- OpenAPI/client/Zod regeneration succeeded with the existing offline native-build environment. Initial direct generator attempt failed missing arm64 esbuild; no dependency installation or shared dependency modification was performed.
- `git diff --check` passed.
- Independent read-only review by the AI capability agent found no blocking issue; parent integration review remains required.

Commands used: `vitest run src/lib/symbolTruthEvidence.test.ts src/hooks/useSymbolTruth.evidence.test.tsx src/lib/chartCandlesQuery.evidence.test.ts src/hooks/useScannerTruth.expiry.test.tsx src/hooks/useScannerTruth.selectedMarket.test.tsx`; API `test:truth-component-evidence`; `node --import tsx ./src/typecheckCi.ts`; frontend `typecheck`; Orval configured in `lib/api-spec/orval.config.ts`. All ran locally with the existing offline environment wrapper. No broker, real database, API startup, deployment or trading validation was performed.

This is a display evidence correctness fix. No browser acceptance, measured latency claim, full combined release check or architecture completion is implied.

## Existing volume evidence audit (no volume implementation in this change)

- MT5 v154 candle batches send `tickVolume` from `MqlRates.tick_volume` (EA line 1662); its stream sends that same tick count as generic `volume` (1880). v152 does the same. These are tick counts, not exchange traded size.
- `routes/mt5.ts` (2249), `lib/data/mt5History.ts` (156), and `lib/data/brokerCandleStore.ts` (425, 548) collapse tick volume into generic volume.
- BrokerHub `mt5ReadOnlyAdapter.ts` (417) selects `realVolume ?? tickVolume`, losing which kind supplied the value.
- Deriv public `normalizePublicCandles` retains OHLC only. Synthetic prices have no traded volume; zero must not be shown as measured market inactivity.
- Real TwelveData `assistant/marketProvider.ts` (434), Polygon (537), Finnhub (701) default missing volume to zero. Their generic numeric field does not retain a volume kind/unit or prove instrument-specific semantics.
- `mockProvider.ts` generates random volume; this is simulation data.
- Shared `candleNormalization.ts` (444, 649–650) turns missing/nonfinite volume into zero and sets tickVolume null. Forming `chartDataService.ts` (153) can provide tickCount separately. Scanner display/engine candles retain OHLC only.

A source-qualified real/tick/unavailable volume contract is required before adding honest volume-dependent chart studies. Numeric presence or normalized zero alone is insufficient. Root owns that follow-up; no new competing evidence authority was created here.

## Remote heads inspected read-only

`git ls-remote` returned:

- `claude/truth-system-improvements`: `16c8a1a0c66c01088346c0127d0323d9f0f9e167`
- `claude/truth-r3-integration`: `eb385d0e1305429f4c4a925e3961aa2b399f6e0f`
- `codex/platform-evidence-integration`: `cd44c73cb3392574ff4aa6593232597278db0657`

No remote branch was changed. The earlier GitHub connector read failed with Transport closed; read-only git lookup succeeded.
