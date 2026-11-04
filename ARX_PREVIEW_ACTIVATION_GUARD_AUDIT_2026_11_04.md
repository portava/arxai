# ARX preview activation and guard audit — 2026-11-04

## Outcome and source

Guard comparison and two copy-only corrections completed. API activation is BLOCKED pending authorization for a preview-safe startup guard. No API build or restart was attempted.

Inspected merge: 5750de533433611ca2d0d7cd478682490763fbdd. Recovery: 0fca9a1db3c5ba4c1eb2933fdbc072e39df23785. The copy-only checkpoint is the commit containing this report.

## Recovery comparison

Ran the application-root scripts/src/ci/run-all.ts suite in detached worktree /tmp/arx-guard-recovery-20261104 at recovery/pre-replit-port-20261104-0fca9a1d. Installed third-party dependencies were shared by links without installing packages; @workspace links resolved to recovery sources, not the merged checkout. No baseline API or database fixture was started. An initial missing-dependency setup error was corrected before obtaining the baseline result.

Recovery and final source both report 83/87 guards, exit 1. All four failures pre-existed. These four guard implementations are unchanged between recovery and the merge and were not edited here.

| Guard | Recovery findings | Merged findings | Final findings | Verdict |
| --- | ---: | ---: | ---: | --- |
| risky-wording-frontend | 50 | 50 | 50 | Pre-existing; existing findings retained |
| no-internal-names-user-ui | 25 | 26 | 25 | Pre-existing; existing findings retained |
| investor-no-guaranteed-return | 3 | 3 | 3 | Pre-existing; existing findings retained |
| test-scripts-wired | 4 | 4 | 4 | Pre-existing; existing findings retained |

The merge added one risky-wording comment and one raw assistant-name log message. Both were corrected. Every named source snippet remaining after the fixes is present in recovery source; the wiring findings also match recovery. Comparing source content avoids shifted line numbers and differences in sampled match order. The counts above are findings reported by the guard, not an exhaustive claim beyond its output limits.

## Exact copy-only changes

- arxai/artifacts/trading-dashboard/src/lib/instantTradeRouter.ts:138
  - Before: Grant or withdraw Ruby's authority to shift this monitor's SL/TP on a fakeout. Server audits both ways.
  - After: Grant or revoke the assistant's authority to shift this monitor's SL/TP on a fakeout. Server audits both ways.
  - Comment only; authority, POST path and payload unchanged.
- arxai/artifacts/api-server/src/lib/assistant/rubyWatchSweeper.ts:110
  - Before log message: [ruby-sweeper] Ruby watch sweeper started
  - After log message: [ruby-sweeper] Assistant watch sweeper started

No protected Replit shell/layout file, guard, allowlist, threshold, trading switch, permission or environment/Secret was changed.

## API activation blocker

arxai/artifacts/api-server/src/app.ts calls startRubyWatchSweeper() unconditionally. Unlike the adjacent workers, this call is outside isPreviewSafeStart(). The worker defaults enabled in rubyWatchSweeper.ts:42 and starts an interval at lines 99–110. It evaluates persisted watch instructions and can invoke the existing trade pipeline. The dedicated disabling flag is not configured; only existence was checked, without accessing Secret values or changing configuration.

Restarting as-is could start autonomous watch evaluation. To preserve the no-broker/no-trading boundary, the existing API was left running. Proposed separate source change, NOT applied: wrap that call with the existing !isPreviewSafeStart() guard. It would reuse the existing development-only policy without changing any environment variable or trading switch, and would leave non-preview startup behavior unchanged.

The existing API is still on its previously built bundle, not the merge or this copy-only checkpoint. Its exact older build commit has not been established. No migrations, schema pushes, post-merge database hooks, broker/MT5 operations, switch activation, publication or deployment occurred.

## Exact remaining files and strings reported

Paths in excerpts are relative to arxai/. Wiring definitions are in scripts/package.json, artifacts/api-server/package.json and artifacts/trading-dashboard/package.json, with missing references in the root arxai/package.json CI command.

### risky-wording-frontend

```text
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/features/trading-school/data/content.ts:336:      "Your balance is your money; equity is your balance including open trades. Margin is the deposit a leveraged trade needs; free margin is what's left. Drawdown is how far your account has dropped from its peak.",
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/features/trading-school/data/content.ts:536:  { term: "Leverage", simple: "Controlling a bigger position with less money — magnifies wins and losses.", example: "Small deposit, larger market exposure.", relatedStep: 2 },
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/features/trading-school/data/content.ts:537:  { term: "Margin", simple: "The deposit a leveraged trade requires.", example: "Opening a trade locks some margin until you close.", relatedStep: 7 },
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/pages/analytics.tsx:560:  const filters = ["All", "Deposits", "Withdrawals", "Allocations", "Trades", "Risk Events", "Reviews", `${name} Lessons`, "Bridge Events"];
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:59:      deposits: 1000,
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:90:    watching: [{ kind: "DEPOSIT_LOCK", message: "A deposit lock releases later this month." }],
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:149:        deposits: 1000,
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:172:        deposits: 1000,
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/PoolsSection.tsx:162:                  <Field label="Deposits allocated" value={fmtMoney(p.depositsAllocated, ccy)} />
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/OverviewSection.tsx:97:    (r) => r.movementType === "DEPOSIT" && PENDING_STATUSES.has(r.status.toUpperCase()),
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/OverviewSection.tsx:203:                  label="Pending deposits"
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/OverviewSection.tsx:210:                  testid="kpi-pending-deposits"
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/FeeSettingsSection.tsx:174:          <NumField label="Deposit lock (days)" value={form.depositLockDays} onChange={(v) => set("depositLockDays", v)} testid="input-lock-days" />
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/FeeSettingsSection.tsx:175:          <NumField label="Min deposit" value={form.minDepositAmount} onChange={(v) => set("minDepositAmount", v)} testid="input-min-deposit" />
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/FeeSettingsSection.tsx:195:      <TierTable title="Deposit speed tiers" tiers={depositTiers} />
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/CapitalMovementsSection.tsx:1:// Capital Movements — the deposit/withdrawal approval queue. No page rendered
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/CapitalMovementsSection.tsx:37:const TYPE_OPTIONS = ["ALL", "DEPOSIT", "WITHDRAWAL"];
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/CapitalMovementsSection.tsx:124:          body="Investor deposit and withdrawal requests appear here for review. Nothing matches the current filters."
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/CapitalMovementsSection.tsx:130:            const isDeposit = r.movementType === "DEPOSIT";
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/cockpit/InvestorsSection.tsx:130:                    <Stat label="Deposits" value={fmtMoney(d.pending?.deposits)} />
[\bdeposit(ed|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/cockpit/CapitalSection.tsx:29:              <Stat label="Deposits" value={fmtMoney(d.pending.deposits)} />
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/pages/market-scanner.direct-results.test.tsx:307:it("withdraws an expired setup and its open ticket exactly after the age boundary", async () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/pages/analytics.tsx:560:  const filters = ["All", "Deposits", "Withdrawals", "Allocations", "Trades", "Risk Events", "Reviews", `${name} Lessons`, "Bridge Events"];
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:60:      withdrawals: 0,
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:150:        withdrawals: 0,
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/pages/investor.weeklyStory.test.tsx:173:        withdrawals: 0,
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/symbolTruthEvidence.ts:45:  // old value, so explicitly withdraw it rather than displaying cached advice as current.
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/symbolTruthEvidence.test.ts:58:  it.each(["wrong symbol", "wrong timeframe", "expired", "future", "invalid time", "failed refresh"])("withdraws the snapshot on %s", (scenario) => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/symbolTruthEvidence.test.ts:72:  it("withdraws an incomplete response instead of crashing or retaining its advice", () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/components/selfTrade/AccountingSummary.test.tsx:155:  it("failed overview refresh withdraws cached accounting", () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/components/selfTrade/AccountingSummary.test.tsx:167:  it("failed detail refresh withdraws cached accounting", () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-live-affordance-guard.test.ts:55:// A context reset may explicitly withdraw both labels immediately before
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-live-affordance-guard.test.ts:287:  it("allows only the exact paired withdrawal followed by clearing the same series", () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.workbench.test.ts:379:it("reads the new series after remount and withdraws its live labels on context reset",()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.workbench.test.ts:402:  it("withdraws stale same-bar volume when a streaming price update has no evidence",()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.workbench.test.ts:437:it('keeps estimated profile on original OHLC under Heikin Ashi and withdraws metadata-only evidence',()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/components/chart-replay/ChartReplayPlayer.test.tsx:159:it("proposes only revealed pivots and withdraws its preview on replay seek",()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.ts:1026:      // reader of the applied OHLC anyway, so it can withdraw mismatched reads.
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartVolumeProfilePrimitive.test.ts:16: primitive.setData(Object.freeze({status:'held',method:'ohlc-uniform-range-v1',reason:'withdrawn'}),'#aabbcc',0,1);context.fillRect.mockClear();draw();expect(context.fillRect).not.toHaveBeenCalled();expect((primitive as any).geometry).toEqual([]);primitive.detached();expect((primitive as any).geometry).toEqual([]);expect(update).toHaveBeenCalledTimes(2);
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartVolumeProfile.ts:44:  if(b.profileEvidence?.finality!=='closed'||b.profileEvidence.clockAuthority!==range.clockAuthority)return hold('Every selected bar needs original closed status and matching original UTC evidence; partial or withdrawn evidence holds the whole profile.');
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartVolumeProfile.test.ts:40:it.each(['OHLC_INVALID','TIMESTAMP_INVALID','DUPLICATE_BUCKET'])('withdraws original corruption flag %s before canonical sanitization',flag=>{expect(profileCandleEvidence({isFinal:true,isComplete:true,isForming:false,qualityFlags:[flag]}).finality).toBe('unqualified');});
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartVolume.test.ts:31:  it("detects evidence-only revisions and withdrawal despite unchanged price",()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartStudyDisplay.test.ts:18: it.each(['absent','wrong-series','forming','withdrawn-clock'])('withdraws saved anchor label when current exact evidence is %s',reason=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartStudyDisplay.test.ts:19:  const bars=reason==='absent'?[]:[{...bar,...(reason==='wrong-series'?{volumeEvidence:{...bar.volumeEvidence!,seriesIdentity:'b'.repeat(64)}}:{}),profileEvidence:{finality:reason==='forming'?'forming' as const:'closed' as const,clockAuthority:reason==='withdrawn-clock'?null:TRADE_VOLUME_AUTHORITY}}] as ChartEngineCandle[];
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartStudyAssistant.volumeProfile.test.ts:66: it('withdraws aggregate explanation after same-price metadata or source evidence withdrawal',()=>{
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/lib/chart-engine/chartAssistantPaneContext.test.ts:6:it('changes tokens for source, interval, renderer replacement and metadata withdrawal',()=>{const key=chartAssistantPaneContext(data,'AAPL','M15',1);for(const changed of [chartAssistantPaneContext(data,'AAPL','M1',1),chartAssistantPaneContext(data,'AAPL','M15',2),chartAssistantPaneContext(undefined,'AAPL','M15',1),chartAssistantPaneContext({...data,candles:[{volumeEvidence:evidence}]},'AAPL','M15',1)])expect(changed).not.toBe(key);});
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/hooks/useSymbolTruth.evidence.test.tsx:73:it("withdraws cached advice immediately after a failed refresh", async () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/hooks/useSymbolTruth.evidence.test.tsx:171:it("withdraws cached advice when the chart changes original source within the same provider and candle", async () => {
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/components/admin/fundControl/PoolsSection.tsx:163:                  <Field label="Withdrawals redeemed" value={fmtMoney(p.withdrawalsRedeemed, ccy)} />
[\bwithdraw(als?|n|ing|s)?\b] artifacts/trading-dashboard/src/hooks/useScannerTruth.ts:123:        // withdraw live affordances for every direct truth consumer as well.
```

### no-internal-names-user-ui

```text
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/dashboard/cockpit/CockpitDataStates.test.tsx:33: for(const overrides of [{symbol:'UNREQUESTED'},{dangerScore:NaN},{generatedAt:'bad'},{generatedAt:'2999-01-01T00:00:00Z'},{timingGrade:'INVALID'}])it(`rejects malformed timing evidence ${JSON.stringify(overrides)}`,()=>{state.data={results:[timing(overrides)]};render(<AvoidMarketsCard/>);expect(screen.getByText(/unavailable/)).toBeTruthy()});
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/lib/scannerTruthRegression.test.ts:150:            `${base}/${JSON.stringify(read)}/${override} upgraded`,
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx:1457:          <ChartTemplatesPanel key={JSON.stringify([resolvedSymbol,timeframe])} preferences={preferences} onPreferences={setPreferences}/>
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/charts/ChartStudySettings.volumeProfile.test.tsx:16: function Workspace(){const [preferences,setPreferences]=useState<ChartPreferences>(DEFAULT_PREFERENCES);return <><ChartStudySettings adapter={adapter} preferences={preferences} onPreferences={setPreferences}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/charts/ChartStudySettings.test.tsx:9:  return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} /><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/charts/ChartStudySettings.test.tsx:97: function Test(){const [preferences,setPreferences]=useState<ChartPreferences>(DEFAULT_PREFERENCES);return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} adapter={adapter}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/charts/ChartStudySettings.test.tsx:117: function Test(){const [preferences,setPreferences]=useState<ChartPreferences>({...DEFAULT_PREFERENCES,studies:[{kind:'vwap',period:1,color:'#ffffff',source:'hlc3',vwapAnchor:{kind:'observed_bar',time:bars[0]!.time,seriesIdentity:identity}}]});return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} adapter={adapter}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/lib/chart-engine/chartStudies.benchmark.ts:25:const baselineSource = gitSource.replace(/from "\.\/types"/g, `from ${JSON.stringify(typesPath)}`);
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/lib/chart-engine/chartDescriptiveAnalysis.test.ts:114: for(const bad of [{sourceIdentity:null},{source:"unknown"},{timeframe:"INVALID"},{asOfMs:NaN},{visibleRange:{from:9,to:1}}])it(`refuses context ${JSON.stringify(bad)}`,()=>{expect(describeSmartChartWindow({...input([100,101]),...bad}).status).toBe("unavailable");});
[json-stringify-in-jsx] JSON.stringify rendered in JSX — artifacts/trading-dashboard/src/components/help/FloatingHelpWidget.tsx:1050:            {JSON.stringify(safeCtx, null, 2)}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/pages/market-scanner.tsx:952:12: // The Ruby Chart Read store is page-scoped (Task #600): the header strip's
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/pages/my-trades.tsx:310:30: {/* Top row: Summary + Ruby read + Protection */}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/pages/my-trades.tsx:338:13: {/* Ruby's Live Trade Read */}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/pages/my-trades.tsx:522:34: {/* Lower grid: Exposure + Ruby Position Manager + Activity + Quick Actions */}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/pages/my-trades.tsx:547:13: {/* Ruby Position Manager */}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/features/trading-school/pages/TradingSchoolHome.tsx:106:11: {/* Ruby teaching modes preview (uses Step 5 support example) */}
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx:1958:4: // Ruby Chart Read show, for a chat chart-read message (Task #777). The live
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx:1988:11: // Long Ruby answers collapse to a readable height with Show more/less so the
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx:1995:13: // (e.g. "Ruby is reviewing your performance…").
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx:2092:29: and Scanner Ruby Chart Read show, driven off the single resolved
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/scanner/RubyMarketReadCard.tsx:335:48: {/* Standardized, always-visible Ruby Reasoning Block — never behind
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/scanner/RubyMarketReadCard.tsx:487:28: {/* Levels — Ruby speaks in levels. Suppressed when the shared
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/scanner/ScalpSignalCard.tsx:392:46: {/* ONE standardized, ALWAYS-VISIBLE Ruby Reasoning Block (no collapse).
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/trading-dashboard/src/components/scanner/RubyChartRead.tsx:248:15: {/* Ruby's full reasoning — ALWAYS visible (no accordion). Honesty flags
[assistant-name-user-copy] raw internal assistant name "Ruby" in user-facing copy — route it through the name resolver (frontend useAssistantName().name / backend getAssistantDisplayName) — artifacts/api-server/src/routes/meHeat.ts:185:61: logger.warn({ err: String(memErr), userId }, "meHeat: Ruby Memory persist failed (non-fatal)");
```

### investor-no-guaranteed-return

```text
[guaranteed\s+(return|returns|profit|profits|income|gains?|yield|payout)] artifacts/api-server/src/routes/meInvestor.ts:14://   reported as "no data" until a real source exists. NEVER guaranteed returns.
[guaranteed\s+(return|returns|profit|profits|income|gains?|yield|payout)] artifacts/api-server/src/lib/investor/investorService.ts:219:// per investor — never a projected, fixed, or guaranteed return:
[risk[\s-]?free] artifacts/api-server/src/routes/adminInvestors.ts:12:// - NO guaranteed / fixed / risk-free return wording anywhere.
```

### test-scripts-wired

```text
@workspace/scripts::test:compact-workspace-geometry is a test script but is neither referenced by root "ci" nor allowlisted — wire it into the "ci" script in package.json, or add it to ALLOWLIST in scripts/src/ci/check-test-scripts-wired.ts with a reason
@workspace/scripts::test:shell-header-browser is a test script but is neither referenced by root "ci" nor allowlisted — wire it into the "ci" script in package.json, or add it to ALLOWLIST in scripts/src/ci/check-test-scripts-wired.ts with a reason
@workspace/api-server::test:performance is a test script but is neither referenced by root "ci" nor allowlisted — wire it into the "ci" script in package.json, or add it to ALLOWLIST in scripts/src/ci/check-test-scripts-wired.ts with a reason
@workspace/trading-dashboard::test:performance is a test script but is neither referenced by root "ci" nor allowlisted — wire it into the "ci" script in package.json, or add it to ALLOWLIST in scripts/src/ci/check-test-scripts-wired.ts with a reason
```

## Evidence

Existing runtime checked after the copy edits: frontend HTTP 200 and
/api/healthz HTTP 200. API PID 35197 still has its original
2026-11-04 10:51:31 start time. No restart occurred. All 44 protected shell/layout
files still match their pre-merge hashes.

Full baseline, merged-before-fix and final logs plus structured comparisons: generated-artifacts/arx-preview-activation-20261104/. No runtime or broker tests were performed.
