async page => {
  // Integrated scanner page: the real dashboard build (prod-server.mjs --target=app or
  // app-dev-server.mjs), route /market-scanner, Broad Scan tab, real Opportunity Map rows.
  // Same method and rule as responsiveness.js: 20 trusted row clicks at 1x and at 4x CPU
  // throttle, p95 from click to the second requestAnimationFrame, 100 ms target. Every
  // /api call is answered here with invented, deterministic JSON (43 approved-registry
  // symbols; a 450 ms delay when the map is asked for a selected symbol, as in the
  // fixture); non-GET calls, other origins and WebSockets are refused. No broker or API.
  // Endpoints not modelled here answer 503 and are reported (unknownEndpoints).
  const base = (typeof SCANNER_QA_APP_BASE_URL === 'string' ? SCANNER_QA_APP_BASE_URL : 'http://127.0.0.1:4187').replace(/\/$/, '');
  const origin = new URL(base).origin;
  const errors = [], requests = [], unknown = [], blocked = [];
  let active = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.context().routeWebSocket(/.*/, ws => { blocked.push({ kind: 'websocket', url: ws.url() }); ws.close(); });
  await page.addInitScript(() => {
    localStorage.setItem('arx.pageTab.market-scanner', 'broad-scan');
    localStorage.setItem('highroll.chartSymbol', 'EURUSD');
    localStorage.setItem('highroll.onboarding.firstrun.dismissed.v1', '1');
    class OfflineEventSource { constructor(url) { this.url = String(url); this.readyState = 2; } close() {} addEventListener() {} removeEventListener() {} }
    window.EventSource = OfflineEventSource;
  });
  const symbols = ['V75','V75_1S','V100','V50','V50_1S','V25_1S','V10','BOOM1000','CRASH1000','BOOM500','CRASH500','JUMP10','JUMP25','JUMP50','JUMP75','JUMP100','BOOM300','CRASH300',
    'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD','EURJPY','EURGBP','EURAUD','EURCAD','GBPJPY','GBPAUD','GBPCAD','AUDJPY','CADJPY','CHFJPY',
    'XAUUSD','XAGUSD','DXY','SPX500','GER30','US30','BTCUSD','ETHUSD'];
  const categories = ['READY_NOW', 'FORMING_SOON', 'WATCH_AFTER_NEWS', 'TOO_LATE', 'AVOID', 'NO_CLEAN_SETUP'];
  const generatedAt = new Date().toISOString();
  const opportunityMap = (marketGroup, selectedSymbol, timeframe) => {
    const rows = symbols.map((symbol, i) => ({ symbol, displayName: symbol, direction: i % 2 ? 'SELL' : 'BUY', recommendedAction: 'WAIT',
      setupType: 'Offline fixture', edgeScore: 80 - i % 30, entryQuality: 65, executionQuality: 80, newsRisk: 'none', hasLiveData: true, isLate: false,
      reason: 'Offline fixture: no actual market assessment.', category: 'READY_NOW', kind: 'MOMENTUM', bestAction: 'Fixture', stageLabel: 'Fixture' }));
    return { universe: marketGroup, timeframe, generatedAt, universeCount: rows.length,
      map: { rows, categories: Object.fromEntries(categories.map(key => [key, rows.filter(row => row.category === key)])),
        best: { bestScalp: rows[0], bestMomentum: null, bestRetest: null, bestReversal: null }, scannedCount: rows.length, liveCount: rows.length },
      bestVsSelected: { selectedSymbol, selectedEdge: null, hasCleanerAlternative: false, best: null, message: selectedSymbol ? `Comparison for ${selectedSymbol}` : null },
      skippedSymbols: [], dataNote: 'OFFLINE FIXTURE — no market assessment' };
  };
  const user = { id: 900007, email: 'offline@example.invalid', name: 'Offline QA', role: 'USER', lastLoginAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const accountMode = { ok: true, userId: 900007, currentAccountMode: 'LIVE_SHARED', cleanModeLabel: 'Offline read-only fixture', cleanUserMessage: 'No broker connection', cleanBlockedReason: 'OFFLINE_FIXTURE',
    role: 'USER', isAdmin: false, isAdminPreviewingUserMode: false, adminDiagnosticsAvailable: false, liveExecutionArmed: false, userSharedMasterAssignment: { attached: false },
    accountShellStatus: { accountMode: 'SHARED_MASTER_MT5', tradingMode: 'DISABLED', tradingModeLabel: 'Disabled', approvalStatus: 'APPROVED', tradingStatus: 'DISABLED' },
    userAllocation: { hasAllocation: false, currentBalance: 0, assignedStartingBalance: null, equity: 0, marginUsed: 0 },
    userRiskCaps: { maxLotSize: 0, maxOpenTrades: 0, maxDailyLossAmount: 0, allowedSymbols: [], requireStopLoss: true }, userFrozenStatus: { isFrozen: true, freezeMessage: 'Offline fixture' },
    userApprovalStatus: 'APPROVED', userCanManualTrade: false, userCanAutoTrade: false, aiSleeveStatus: { enabled: false, autoEnabled: false }, demoAvailable: false, paperAvailable: false, modeSwitchOptions: [], adminDiagnostics: null };
  // Selected-market read and chart candles as in full-page-setup.js (synthetic, levels withheld).
  const selectedMarket = (symbol, timeframe) => ({ ok: true, symbolRaw: symbol, symbol, timeframe,
    highlights: { bias: 'WAIT', confidenceLabel: 'Very Low', confidenceScore: 0, volatilityLabel: 'Calm', trendState: 'neutral', entryZone: null, suggestedStop: null, suggestedTakeProfit: null, riskRewardRatio: 0, riskWarnings: ['Offline fixture: not market analysis'] },
    explanation: { hedge: 'Offline fixture; no live market read.', why: 'Synthetic historical candles for UI validation only.', whyItMatters: 'No financial inference is available.', risk: 'Unavailable.', invalidation: 'Unavailable.', cautions: ['No live source'], disclaimer: 'OFFLINE QA ONLY' },
    upcomingEvents: [], newsRisk: { riskLevel: 'none', blockTrading: true, summary: 'News unavailable in offline fixture' }, dataSource: 'LIVE_FEED', dataSourceLabel: 'Offline fixture — no live feed',
    dataState: 'UNAVAILABLE', dataAsOf: '2026-01-02T12:00:00.000Z', generatedAt: '2026-01-02T12:00:01.000Z', levelsWithheld: true, levelsWithheldReason: 'Offline fixture', cacheHit: false });
  const candles = (symbol, timeframe, limit) => {
    const step = ({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, H8: 28800, D1: 86400, W1: 604800 })[timeframe] ?? 300, end = 1767355200, count = Math.min(limit, 1000);
    const bars = Array.from({ length: count }, (_, i) => { const ms = (end - (count - i) * step) * 1000, close = 1 + Math.sin(i / 17) * .003;
      return { symbol, timeframe, openTime: new Date(ms).toISOString(), closeTime: new Date(ms + step * 1000).toISOString(), open: close - .0001, high: close + .0003, low: close - .0003, close, volume: 0,
        source: 'offline_fixture', isComplete: true, isFinal: true, sourceMode: 'MOCK', qualityFlags: ['MOCK_DATA'] }; });
    const feedStatus = { symbol, displaySymbol: symbol, assetClass: 'forex', source: 'offline_fixture', quality: 'invalid', isLive: false, stale: true, aiUsable: false, lastCandleTime: '2026-01-02T12:00:00.000Z',
      lastTickTime: null, latencyMs: 0, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 9999,
      warning: 'OFFLINE FIXTURE — synthetic historical bars, not market data', message: 'Offline fixture', feedReadinessState: null, completenessReason: null };
    return { symbol, displaySymbol: symbol, timeframe, assetClass: 'forex', source: 'offline_fixture', quality: 'invalid', aiUsable: false, requestedLimit: limit, candleCount: bars.length, candles: bars,
      feedStatus, truthResult: null, chartTruthScore: null };
  };
  // Reads the selected row starts (market truth, timing brain, chart overlays, annotations,
  // trade health), answered with populated, invented, direction-free data so the click path
  // renders content rather than error states. Same safety flags the API sends: paper only,
  // read only, no order execution.
  const safety = { safetyMode: 'paper_only', liveLocked: true, readOnlyMode: true, allowOrderExecution: false };
  const truth = (symbol, timeframe) => {
    const component = label => ({ present: true, alignment: 'NEUTRAL', label, asOf: '2026-01-02T12:00:00.000Z' });
    return { symbol, displaySymbol: symbol, timeframe, generatedAt: '2026-01-02T12:00:01.000Z',
      data: { state: 'STALE', source: 'offline_fixture', sourceLabel: 'Offline fixture — no live feed', price: 1, lastCandleAt: '2026-01-02T12:00:00.000Z', lastTickAt: null },
      news: { providerConnected: false, events: [], riskLabel: 'News unavailable in offline fixture', highImpactWindowActive: false, disclaimer: 'OFFLINE QA ONLY' },
      components: { scanner: component('Offline scanner fixture'), flame: component('Offline flame fixture'), timing: component('Offline timing fixture'), scalp: component('Offline scalp fixture') },
      levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [], withheld: true, withheldReason: 'Offline fixture' },
      verdict: { stage: 'DEVELOPING', bias: 'NEUTRAL', headline: 'Offline fixture: no market read', evidenceFor: ['Offline fixture evidence A'], evidenceAgainst: ['Offline fixture evidence B'],
        bestAction: 'WATCH_ONLY', bestActionText: 'Watch only (offline fixture)', invalidation: null } };
  };
  const timing = (symbol, timeframe) => ({ symbol, timeframe, generatedAt: '2026-01-02T12:00:01.000Z', heatScore: 48, tradeabilityScore: 52, edgeScore: 50, dangerScore: 35,
    trapProbability: 30, roomToMove: 55, buyPressure: 50, sellPressure: 50, pressureBias: 'NEUTRAL', timingGrade: 'C', entryPermission: 'WAIT_FOR_ENTRY', heatState: 'NEUTRAL', moveStage: 'DEVELOPING',
    heatSource: { primary: 'offline_fixture', primaryConfidence: 0.5, backup: null, backupConfidence: null, explanation: 'Offline fixture heat; not a market read.' },
    session: { sessionName: 'London', killZone: 'none', isKillZoneActive: false, utcHour: 12, sessionHeatBonus: 0, fakeoutRisk: 30, tradeabilityBonus: 0, bestSymbols: ['EURUSD', 'GBPUSD'], dangerSymbols: [],
      sessionDescription: 'Offline fixture session.', userLocalTime: null },
    newsOverlay: { phase: 'NONE', eventName: null, minutesUntil: null, minutesSince: null, eventType: 'none', surpriseScore: null, heatAdjustment: 0, blocksTrade: false },
    broadFlow: { verdict: 'UNAVAILABLE', institutionalFlowScore: 0, competingCatalyst: false, description: 'Offline fixture: no flow data.', correlatedAssets: [], dataQuality: 'unavailable' },
    bestAction: 'WATCH_ONLY', actionReason: 'Offline fixture: advisory display only.',
    dataQuality: { label: 'basic_timing_estimate', hasCandleData: true, hasQuoteData: false, hasNewsData: false, hasBroadFlowData: false, note: 'Offline fixture.' } });
  const smartLayers = (symbol, timeframe) => ({ symbol, timeframe, signal: null, layers: [],
    newsRadar: { symbol, provider: { connected: false, name: 'offline_fixture', note: 'No calendar provider in offline QA' }, events: [], topSeverity: null, highImpactWindowActive: false, summary: 'No news provider (offline fixture)' },
    newsBehavior: { mode: 'NO_PROVIDER', note: 'Offline fixture' },
    handshake: { overallStatus: 'WARN', checks: [{ key: 'signalExists', status: 'NOT_AVAILABLE', detail: 'Offline fixture' }], userFacingMessage: 'Offline fixture overlays', warnings: [] },
    handshakeInputs: { signalSymbol: symbol, signalExists: false, hasSufficientData: false, levelCount: 0, newsMapped: false }, ...safety });
  // Minimal shape: the scanner page reads only state.trendlineOverlay from this endpoint.
  const chartIntelligence = (symbol, timeframe) => ({ state: { symbol, displaySymbol: symbol, timeframe, aiUsable: false, stale: true, trendlineOverlay: null, lastUpdated: '2026-01-02T12:00:01.000Z' }, ...safety });
  const partialModels = ['/api/me/chart/intelligence (minimal state: only trendlineOverlay, which the scanner page reads)'];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { blocked.push({ kind: 'external', url: request.url() }); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const p = url.pathname, item = { method: request.method(), path: p, query: url.search, status: 200, cancelled: false };
    requests.push(item); active++;
    let payload, delay = 20;
    if (request.method() !== 'GET') { item.status = 503; payload = { ok: false, error: 'OFFLINE_MUTATION_BLOCKED' }; blocked.push({ kind: 'mutation', method: request.method(), path: p }); }
    else if (p === '/api/me') payload = { user };
    else if (p === '/api/me/account-mode') payload = accountMode;
    else if (p === '/api/me/assistant-settings') payload = { displayName: 'Eleanor', isDefault: true };
    else if (p === '/api/onboarding/status') payload = { status: { status: 'COMPLETED', walkthroughCompleted: true, totalSteps: 0, completedSteps: [], skippedSteps: [], nextStep: null } };
    else if (p === '/api/feature-announcements') payload = { announcements: [] };
    else if (p === '/api/me/opportunity-map') {
      const selectedSymbol = url.searchParams.get('selectedSymbol');
      payload = opportunityMap(url.searchParams.get('marketGroup') ?? 'all', selectedSymbol, url.searchParams.get('timeframe') ?? 'M5');
      delay = selectedSymbol ? 450 : 20;
    }
    else if (p === '/api/market-scanner/universes') payload = { universes: [{ id: 'all', label: 'Offline universe', symbols, available: true, note: 'Fixture symbols only' }], defaultUniverse: 'all' };
    else if (p === '/api/market-scanner/status') payload = { running: false, universe: 'all', lastScanAt: null, feedNote: 'OFFLINE QA — no live feed' };
    else if (p === '/api/market-scanner/opportunities') payload = { opportunities: [], universe: 'all', universeSymbols: symbols, generatedAt, dataSource: 'AWAITING_FEED' };
    else if (p === '/api/market-scanner/selected-market') { payload = selectedMarket(url.searchParams.get('symbol') ?? 'EURUSD', url.searchParams.get('timeframe') ?? 'M15'); delay = 450; }
    else if (p === '/api/chart/candles') { payload = candles(url.searchParams.get('symbol') ?? 'EURUSD', url.searchParams.get('timeframe') ?? 'M15', Number(url.searchParams.get('limit') ?? 200)); delay = 450; }
    else if (p === '/api/chart/history') payload = { ok: true, source: 'offline_fixture', candles: [], status: 'unavailable', returnedCount: 0, oldest: null, newest: null, hasMoreHistory: false, nextBefore: null, providerLimitReached: true, limitationReason: 'Offline fixture', cacheHit: false };
    else if (p === '/api/market-data/deriv/status') payload = { configured: false, connected: false, status: 'OFFLINE_FIXTURE' };
    else if (p === '/api/watchlists') payload = [];
    else if (p === '/api/me/live/positions') payload = { positions: [] };
    else if (p === '/api/me/live/commands') payload = { commands: [] };
    else if (p.startsWith('/api/me/market/truth/')) payload = truth(decodeURIComponent(p.slice('/api/me/market/truth/'.length)), url.searchParams.get('timeframe') ?? 'M15');
    else if (p.startsWith('/api/me/timing-brain/')) payload = timing(decodeURIComponent(p.slice('/api/me/timing-brain/'.length)), url.searchParams.get('timeframe') ?? 'M15');
    else if (p === '/api/me/chart/smart-layers') payload = smartLayers(url.searchParams.get('symbol') ?? 'EURUSD', url.searchParams.get('timeframe') ?? 'M15');
    else if (p === '/api/me/chart/intelligence') payload = chartIntelligence(url.searchParams.get('symbol') ?? 'EURUSD', url.searchParams.get('timeframe') ?? 'M15');
    else if (p === '/api/me/chart/annotations') payload = { annotations: [], ...safety };
    else if (p === '/api/me/trade-health') payload = { evaluatedAt: '2026-01-02T12:00:01.000Z', chartSymbol: url.searchParams.get('chartSymbol'), assessments: [], conflicts: [], correlations: [], overtrading: [], overlays: [],
      summary: 'No open positions (offline fixture)', ...safety };
    else { unknown.push(p); item.status = 503; payload = { ok: false, error: 'OFFLINE_FIXTURE_UNAVAILABLE', message: 'Unavailable in offline QA' }; }
    await new Promise(resolve => setTimeout(resolve, delay));
    try { await route.fulfill({ status: item.status, contentType: 'application/json', body: JSON.stringify(payload) }); }
    catch { item.cancelled = true; }
    finally { active--; }
  });
  // Waits until no intercepted call is pending for 100 ms (the 450 ms map read included).
  const settle = async () => {
    const until = Date.now() + 15000;
    let quietSince = null;
    while (Date.now() < until) {
      if (active === 0) { quietSince ??= Date.now(); if (Date.now() - quietSince >= 100) return true; }
      else quietSince = null;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  };
  const cdp = await page.context().newCDPSession(page);
  const runs = [];
  for (const cpuRate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.setViewportSize(cpuRate === 1 ? { width: 1440, height: 1100 } : { width: 390, height: 844 });
    await page.goto(`${base}/market-scanner`);
    await page.getByTestId('opportunity-row-EURUSD').waitFor();
    await page.getByLabel('Scanner refresh interval').selectOption('0');
    const settledBeforeClicks = await settle();
    const requestsBefore = requests.length;
    await page.evaluate(() => {
      window.__speed = { interactions: [], emptyTransitions: [], minRows: 43, longTasks: [] };
      const rows = () => document.querySelectorAll('button[data-testid^="opportunity-row-"]').length;
      new MutationObserver(() => {
        const count = rows(); window.__speed.minRows = Math.min(window.__speed.minRows, count);
        if (!count) window.__speed.emptyTransitions.push(performance.now());
      }).observe(document.querySelector('[data-testid="opportunity-map"]'), { subtree: true, childList: true });
      new PerformanceObserver(list => window.__speed.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask' });
      document.addEventListener('click', event => {
        const row = event.target.closest('button[data-testid^="opportunity-row-"]');
        if (!row) return;
        const start = performance.now(), symbol = row.dataset.testid.slice('opportunity-row-'.length);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const now = document.querySelector(`button[data-testid="opportunity-row-${symbol}"]`);
          window.__speed.interactions.push({
            symbol, trusted: event.isTrusted, nextFrameOpportunityMs: performance.now() - start,
            rows: rows(), selectedMarker: now?.getAttribute('aria-pressed') ?? null,
            otherSelected: [...document.querySelectorAll('button[data-testid^="opportunity-row-"][aria-pressed="true"]')].map(b => b.dataset.testid.slice(16)).filter(s => s !== symbol),
          });
        }));
      }, true);
    });
    // EURUSD is the initial chart symbol, so start with GBPUSD: every click changes the selection.
    const unsettled = [];
    for (let index = 0; index < 20; index++) {
      const symbol = index % 2 ? 'EURUSD' : 'GBPUSD';
      await page.getByTestId(`opportunity-row-${symbol}`).click();
      await page.waitForFunction(n => window.__speed.interactions.length >= n, index + 1);
      // Wait for the delayed map read and every other read the selection started.
      if (!await settle()) unsettled.push(index);
    }
    const result = await page.evaluate(() => window.__speed);
    const timings = result.interactions.map(item => item.nextFrameOpportunityMs).sort((a, b) => a - b);
    const runRequests = requests.slice(requestsBefore);
    runs.push({ cpuRate, viewport: await page.viewportSize(), clicks: timings.length,
      eventToSecondAnimationFrameP95Ms: timings[Math.ceil(timings.length * .95) - 1],
      eventToSecondAnimationFrameMaxMs: timings.at(-1), settledBeforeClicks, unsettledAfterClicks: unsettled,
      requests: runRequests.length, opportunityMapReads: runRequests.filter(r => r.path === '/api/me/opportunity-map').length,
      cancelledRequests: runRequests.filter(r => r.cancelled).length, ...result });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (const run of runs) {
    if (run.clicks !== 20 || run.interactions.some(item => !item.trusted || item.selectedMarker !== 'true' || item.otherSelected.length)) {
      throw Error('A selection failed to reach the next measured render opportunity');
    }
    if (run.minRows !== 43 || run.emptyTransitions.length) throw Error('Same-universe selection blanked the results');
    if (run.eventToSecondAnimationFrameP95Ms > 100) throw Error('Integrated scanner page click-feedback p95 exceeded the 100ms target');
  }
  if (errors.length) throw Error(errors.join('\n'));
  return { surface: 'Integrated dashboard /market-scanner, Broad Scan tab, real Opportunity Map rows / invented data / 450ms delayed selected-symbol map read',
    method: 'Trusted click capture to second requestAnimationFrame after DOM commit; a render opportunity proxy, not a hardware presentation timestamp',
    base, runs, errors, unknownEndpoints: [...new Set(unknown)].sort(), partialModels, blocked };
}
