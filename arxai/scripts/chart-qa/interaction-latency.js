async outer => {
  // Smart Chart local-control latency, adapting scripts/scanner-qa/responsiveness.js
  // (which listens in the document capture phase): trusted Playwright input is captured
  // in the window capture phase here, because the drawing editor stops pointerup in its
  // own window capture listener, and the
  // acknowledgement is the second requestAnimationFrame after that event (a render
  // opportunity after DOM commit, not a hardware presentation timestamp). A separate
  // completion witness is checked from that frame onwards on every later frame.
  // Offline synthetic fixture only: no market feed, broker, account or order entry.
  const REPS = 40, WARMUP = 2, PASSES = 2, TARGET_P95_MS = 100, WITNESS_TIMEOUT_MS = 5000;
  // Report-only while recorded controls miss the target (see the baseline table in
  // docs/SMART_CHART_ACCEPTANCE.md); set to true to fail like the scanner scenario
  // whenever any control's second-rAF p95 exceeds 100 ms.
  const ENFORCE_P95_GATE = false;
  // 49 controls (41 before the four display-style pairs were appended): the exact set is
  // asserted so a control cannot silently drop out.
  const EXPECTED_CONTROLS = 49;
  // Own page: the init script and capture listeners below never leak into a shared
  // session page that later acceptance scripts reuse.
  const page = await outer.context().newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  const viewport = { width: 1600, height: 1100 };
  // Optional target, default unchanged: a CHART_QA_BASE_URL global in the evaluating context
  // or, where the runner exposes process, the CHART_QA_BASE_URL environment variable.
  // prod-server.mjs serves the production build on 4179 and labels it in a meta tag.
  const DEFAULT_BASE_URL = 'http://127.0.0.1:4178';
  const BASE_URL = (typeof CHART_QA_BASE_URL === 'string' && CHART_QA_BASE_URL) || (typeof process === 'object' && process?.env?.CHART_QA_BASE_URL) || DEFAULT_BASE_URL;
  // Another spelling of the dev server (trailing slash, localhost, letter case of scheme and
  // host) is still the dev server. String-only: a vm context may have no URL global.
  const normalise = url => String(url).trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, origin => origin.toLowerCase().replace(/^(https?:\/\/)(localhost|\[::1\])(?=:|$)/, (_, scheme) => `${scheme}127.0.0.1`))
    .replace(/\/+(?=[?#]|$)/, '');
  const DEFAULT_TARGET = normalise(BASE_URL) === normalise(DEFAULT_BASE_URL);
  const DEV_BUILD = 'Vite dev server / React development build';
  let BUILD = DEV_BUILD;
  const LABEL = rate => `offline synthetic fixture, Chromium, ${rate === 1 ? 'no CPU throttle (1x)' : `${rate}x CPU throttle`}, rAF opportunity not paint, ${BUILD}, shared container, not reference hardware`;

  await page.addInitScript(() => {
    if (window.__latency) return;
    const lat = window.__latency = { armed: null, samples: [], longTasks: [], waiters: new Map() };
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries()) lat.longTasks.push({ start: e.startTime, duration: e.duration }); })
        .observe({ type: 'longtask', buffered: true });
    } catch { lat.longTasksUnsupported = true; }
    const chartCanvas = () => document.querySelector('[data-testid="arx-native-canvas"]');
    // Visible-range witness: the primary chart's rendered time-axis row changed.
    const axisHash = () => {
      const rows = chartCanvas()?.querySelectorAll('tr'), row = rows?.[rows.length - 1];
      let hash = 2166136261, pixels = 0;
      for (const canvas of row ? row.querySelectorAll('canvas') : []) {
        if (!canvas.width || !canvas.height) continue;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 8) hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16) ^ (data[i + 3] << 24), 16777619);
        pixels += data.length / 4;
      }
      return pixels ? hash >>> 0 : null;
    };
    const find = w => w.selector ? document.querySelector(w.selector)
      : [...document.querySelectorAll('button')].find(button => button.textContent.trim() === w.text);
    const json = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    lat.snapshot = w => w.type === 'axis' ? axisHash() : w.type === 'drawing' ? localStorage.getItem(w.key) : null;
    lat.check = (w, before) => {
      if (w.type === 'pressed') return find(w)?.getAttribute('aria-pressed') === String(w.value);
      if (w.type === 'value') return find(w)?.value === w.value;
      if (w.type === 'present') return !!find(w);
      if (w.type === 'count') return document.querySelectorAll(w.selector).length === w.value;
      if (w.type === 'study') return json('arx.chart.preferences.v1')?.studies?.[w.index]?.[w.field] === w.value;
      if (w.type === 'axis') { const hash = axisHash(); return hash !== null && hash !== before; }
      if (w.type === 'drawing') {
        const raw = localStorage.getItem(w.key); if (raw === before) return false;
        const next = JSON.parse(raw || '[]'), previous = JSON.parse(before || '[]');
        const moved = next.find(d => d.id === w.id), old = previous.find(d => d.id === w.id);
        const othersKept = JSON.stringify(next.filter(d => d.id !== w.id)) === JSON.stringify(previous.filter(d => d.id !== w.id));
        return next.length === w.value && !!moved && !!old && moved.start.price !== old.start.price && othersKept;
      }
      return false;
    };
    lat.wait = id => new Promise((resolve, reject) => {
      if (lat.samples.some(s => s.id === id)) return resolve();
      const timer = setTimeout(() => reject(Error(`No measured event for sample ${id}`)), 20000);
      lat.waiters.set(id, () => { clearTimeout(timer); resolve(); });
    });
    const finish = sample => { lat.samples.push(sample); lat.waiters.get(sample.id)?.(); lat.waiters.delete(sample.id); };
    // Window capture, registered before any page script: the drawing editor stops pointerup
    // propagation in its own window capture listener.
    for (const type of ['click', 'keydown', 'pointerup', 'input']) window.addEventListener(type, event => {
      const a = lat.armed;
      if (!a || a.event !== type || (a.key && event.key !== a.key) || (!event.isTrusted && !a.allowUntrusted)) return;
      lat.armed = null;
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const sample = { id: a.id, control: a.control, cpuRate: a.cpuRate, pass: a.pass, record: a.record, trusted: event.isTrusted,
          start, nextFrameOpportunityMs: performance.now() - start, completionMs: null, completionFrame: null, witnessAtSecondFrame: false };
        let frame = 2;
        const poll = () => {
          if (lat.check(a.witness, a.before)) {
            sample.completionMs = performance.now() - start; sample.completionFrame = frame; sample.witnessAtSecondFrame = frame === 2;
            return finish(sample);
          }
          if (performance.now() - start > a.witnessTimeoutMs) return finish(sample);
          frame++; requestAnimationFrame(poll);
        };
        poll();
      }));
    }, true);
  });

  let seq = 0;
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(resolve, { timeout: 100 })))));
  const measure = async (control, spec, act, ctx) => {
    const id = ++seq;
    await page.evaluate(a => { const lat = window.__latency; a.before = lat.snapshot(a.witness); lat.armed = a; }, { id, control, witnessTimeoutMs: WITNESS_TIMEOUT_MS, ...ctx, ...spec });
    await act();
    await page.evaluate(n => window.__latency.wait(n), id);
    await settle();
  };
  const primary = page.getByTestId('arx-native-chart').first();
  const button = name => primary.getByRole('button', { name, exact: true });
  const canvas = primary.getByTestId('arx-native-canvas');
  const studiesOpen = () => primary.getByRole('region', { name: 'Study settings', exact: true }).count().then(Boolean);
  const openStudies = async () => { if (!await studiesOpen()) await primary.getByRole('button', { name: /^Studies \(\d+\)$/ }).click(); };
  const DRAWING_KEY = 'arx.chart.drawings.v1:EURUSD:M15';
  const utc = daysAgo => new Date(Math.floor((Date.now() - daysAgo * 86400000) / 3600000) * 3600000).toISOString().slice(0, 16);
  const click = (control, locator, witness) => ctx => measure(control, { event: 'click', witness }, () => locator.click(), ctx);
  const axis = { type: 'axis' };
  const pair = (a, b) => async ctx => { await a(ctx); await b(ctx); };
  const key = (control, keyName, witness) => ctx => measure(control, { event: 'keydown', key: keyName, witness }, async () => { await canvas.focus(); await page.keyboard.press(keyName); }, ctx);
  const selectStep = (label, values) => async ctx => {
    const select = primary.getByLabel(label, { exact: true });
    for (const [direction, value] of [['ArrowDown', values[1]], ['ArrowUp', values[0]]]) {
      await select.focus();
      // Trusted keyboard selection; Playwright selectOption would dispatch untrusted events.
      await measure(`${label} (${value})`, { event: 'keydown', key: direction, witness: { type: 'value', selector: `select[aria-label="${label}"]`, value } }, () => page.keyboard.press(direction), ctx);
    }
  };
  // Display-style switches on the same select. Each pair is named with both styles because
  // a style appears in two pairs; the candles <-> bars group keeps its original names.
  const styleSelect = () => primary.getByLabel('Chart style', { exact: true });
  const styleGroup = (from, to) => ({ name: `chart style (${from} to ${to})`,
    // Untrusted selectOption outside measurement puts the select on `from`.
    setup: async () => { await styleSelect().selectOption(from); await settle(); },
    step: async ctx => {
      for (const [direction, origin, value] of [['ArrowDown', from, to], ['ArrowUp', to, from]]) {
        await styleSelect().focus();
        await measure(`Chart style (${origin} to ${value})`, { event: 'keydown', key: direction, witness: { type: 'value', selector: 'select[aria-label="Chart style"]', value } }, () => page.keyboard.press(direction), ctx);
      }
    },
    // Restore candles so the next pass's earlier groups run exactly as before.
    teardown: async () => { await styleSelect().selectOption('candles'); await settle(); } });
  let horizontalId = null, horizontalY = 80;

  const groups = [
    { name: 'timeframes', step: async ctx => {
      for (const tf of ['M30', 'H1', 'H4', 'D1', 'M1', 'M5', 'M15']) await click(`Timeframe ${tf}`, primary.getByTestId(`arx-native-tf-${tf}`), { type: 'pressed', selector: `[data-testid="arx-native-tf-${tf}"]`, value: true })(ctx);
    } },
    { name: 'chart style', step: selectStep('Chart style', ['candles', 'bars']) },
    { name: 'price scale', step: selectStep('Price scale', ['linear', 'log']) },
    { name: 'invert scale', step: pair(click('Invert scale (on)', button('Invert scale'), { type: 'pressed', text: 'Invert scale', value: true }),
      click('Invert scale (off)', button('Invert scale'), { type: 'pressed', text: 'Invert scale', value: false })) },
    // Latest keeps bar spacing, so it is a visual no-op while the newest bar is already in
    // view (for example right after Fit history). Each sample starts from a view it changes.
    { name: 'fit history / latest', step: async ctx => {
      await button('Reset chart scale').click(); await settle();
      await click('Fit history', button('Fit history'), axis)(ctx);
      await button('Reset chart scale').click(); await button('Pan to earlier candles').click(); await settle();
      await click('Latest', button('Latest'), axis)(ctx);
    } },
    { name: 'reset chart scale', step: async ctx => { await button('Fit history').click(); await settle(); await click('Reset chart scale', button('Reset chart scale'), axis)(ctx); } },
    { name: 'range presets', step: async ctx => {
      for (const label of ['1D', '5D', '1M', '3M', '1D', '1Y']) await click(`Range ${label}`, primary.getByLabel('Chart date navigation', { exact: true }).getByRole('button', { name: label, exact: true }), axis)(ctx);
    } },
    { name: 'go to UTC', step: async ctx => {
      for (const days of [10, 20]) {
        await primary.getByLabel('Go to UTC date and time', { exact: true }).fill(utc(days));
        await click('Go to UTC', button('Go to UTC'), axis)(ctx);
      }
    } },
    { name: 'pan mode', step: pair(click('Pan mode (on)', button('Pan'), { type: 'pressed', text: 'Pan', value: true }),
      click('Pan mode (off)', button('Pan'), { type: 'pressed', text: 'Pan', value: false })) },
    { name: 'pan buttons', step: pair(click('Pan to earlier candles', button('Pan to earlier candles'), axis), click('Pan to later candles', button('Pan to later candles'), axis)) },
    { name: 'zoom buttons', step: pair(click('Zoom in chart', button('Zoom in chart'), axis), click('Zoom out chart', button('Zoom out chart'), axis)) },
    { name: 'keyboard pan', step: pair(key('Key ArrowLeft', 'ArrowLeft', axis), key('Key ArrowRight', 'ArrowRight', axis)) },
    { name: 'keyboard zoom', step: pair(key('Key +', '+', axis), key('Key -', '-', axis)) },
    { name: 'fullscreen', step: pair(click('Fullscreen', button('Fullscreen'), { type: 'present', text: 'Exit fullscreen' }),
      click('Exit fullscreen', button('Exit fullscreen'), { type: 'present', text: 'Fullscreen' })) },
    { name: 'add study', setup: openStudies, step: async ctx => {
      await click('Add study (12th)', primary.getByRole('button', { name: 'Add Stochastic oscillator', exact: true }), { type: 'present', text: 'Studies (12)' })(ctx);
      await primary.getByRole('button', { name: 'Remove study 12', exact: true }).click();
      await primary.getByRole('button', { name: 'Studies (11)', exact: true }).waitFor();
    } },
    { name: 'SMA period blur', setup: openStudies, step: async ctx => {
      for (const period of [10, 20]) {
        await primary.getByLabel('SMA 1 Period', { exact: true }).fill(String(period));
        await measure('SMA period (Tab blur)', { event: 'keydown', key: 'Tab', witness: { type: 'study', index: 0, field: 'period', value: period } }, () => page.keyboard.press('Tab'), ctx);
      }
    } },
    { name: 'study colour', setup: openStudies, step: async ctx => {
      for (const color of ['#ef4444', '#fbbf24']) {
        // A native colour picker has no trusted automation path; this sample is the
        // input event dispatched by Playwright fill and is reported as untrusted.
        await measure('SMA colour input', { event: 'input', allowUntrusted: true, witness: { type: 'study', index: 0, field: 'color', value: color } },
          () => primary.getByLabel('SMA 1 Color', { exact: true }).fill(color), ctx);
      }
    } },
    { name: 'drawing drag commit', setup: async () => {
      if (await studiesOpen()) await primary.getByRole('button', { name: /^Studies \(\d+\)$/ }).click();
      await button('Reset chart scale').click(); await button('Latest').click(); await settle();
    }, step: async ctx => {
      for (const to of [150, 80]) {
        await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
        await measure('Drawing drag commit', { event: 'pointerup', witness: { type: 'drawing', key: DRAWING_KEY, id: horizontalId, value: 40 } }, async () => {
          await page.mouse.move(box.x + 300, box.y + horizontalY); await page.mouse.down();
          await page.mouse.move(box.x + 300, box.y + to, { steps: 8 }); await page.mouse.up();
        }, ctx);
        horizontalY = to;
      }
    } },
    { name: 'layout', step: async ctx => {
      for (const [label, count] of [['Two charts', 2], ['Four charts', 4], ['One chart', 1]]) {
        await click(label, page.getByRole('group', { name: 'Chart layout', exact: true }).getByRole('button', { name: label, exact: true }),
          { type: 'count', selector: '[data-testid="arx-native-chart"]', value: count })(ctx);
        await page.waitForFunction(n => [...document.querySelectorAll('[data-testid="arx-native-canvas"]')].filter(node => node.querySelector('canvas')).length === n, count);
      }
    } },
    // Appended last: every group above still runs in candles, so its columns stay comparable.
    // Measured on the same 5,000-bar, 11-study, 40-drawing fixture.
    styleGroup('line', 'area'),
    styleGroup('area', 'baseline'),
    styleGroup('baseline', 'heikinAshi'),
    styleGroup('heikinAshi', 'hollow'),
  ];

  const nearest = (sorted, p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const median = sorted => sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  const stats = values => { const s = [...values].sort((a, b) => a - b); return { median: round(median(s)), p95: round(nearest(s, .95)), p99: round(nearest(s, .99)), max: round(s.at(-1)) }; };

  const runs = [];
  try {
  for (const cpuRate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.setViewportSize(viewport);
    await page.goto(BASE_URL);
    if (!DEFAULT_TARGET) {
      // The build label comes from the page. The dev server (under any spelling) carries
      // none and keeps the dev label without a read; any other unlabelled target says so.
      const meta = await page.evaluate(() => document.querySelector('meta[name="arx-chart-qa-build"]')?.content);
      BUILD = meta ? `${meta} at ${BASE_URL}` : `unlabelled build at ${BASE_URL}`;
    }
    await page.evaluate(() => localStorage.clear());
    // Preload heavy state through storage, not UI clicks: 11 studies (the 12-study stress
    // set minus the stochastic oscillator, so Add study stays enabled) with 1000-period
    // Bollinger/CCI, plus 39 Fibonacci drawings; one horizontal line is added through the UI.
    await page.evaluate(() => {
      const catalog = [
        { kind: 'sma', period: 20, color: '#fbbf24' }, { kind: 'ema', period: 50, color: '#38bdf8' },
        { kind: 'bollinger', period: 1000, multiplier: 2, color: '#a78bfa' }, { kind: 'rsi', period: 14, color: '#e879f9' },
        { kind: 'macd', period: 12, slow: 26, signal: 9, color: '#2dd4bf' }, { kind: 'smma', period: 20, color: '#fb923c' },
        { kind: 'wma', period: 20, color: '#4ade80' }, { kind: 'dema', period: 20, color: '#f472b6' },
        { kind: 'tema', period: 20, color: '#818cf8' }, { kind: 'atr', period: 14, method: 'smma', color: '#fb923c' },
        { kind: 'cci', period: 1000, source: 'hlc3', color: '#38bdf8' },
      ];
      localStorage.setItem('arx.chart.preferences.v1', JSON.stringify({ style: 'candles', scale: 'linear', studies: catalog.map((study, i) => ({ ...study, id: `latency-${i}` })) }));
      const interval = 900, end = Math.floor(Date.now() / 1000 / interval) * interval, time = index => end - (4999 - index) * interval;
      localStorage.setItem('arx.chart.drawings.v1:EURUSD:M15', JSON.stringify(Array.from({ length: 39 }, (_, i) => ({
        id: `latency-fib-${i}`, kind: 'fibonacci', start: { time: time(4850 + i), price: 1.0785 + i * .00005 }, end: { time: time(4950 + i), price: 1.0815 - i * .00004 }, color: '#fbbf24' }))));
    });
    await page.reload();
    await canvas.waitFor();
    await primary.getByRole('button', { name: 'Studies (11)', exact: true }).waitFor();
    await primary.getByRole('button', { name: 'Objects (39)', exact: true }).waitFor();
    await primary.getByLabel('Drawing tool', { exact: true }).selectOption('horizontal');
    horizontalY = 80; await canvas.click({ position: { x: 300, y: horizontalY } });
    await primary.getByRole('button', { name: 'Objects (40)', exact: true }).waitFor();
    horizontalId = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).find(d => d.kind === 'horizontal')?.id, DRAWING_KEY);
    if (!horizontalId) throw Error('Horizontal drawing for drag commit was not created');
    await settle();
    const replayMounted = await primary.getByRole('button', { name: 'Replay loaded bars', exact: true }).count() > 0;

    const startedAt = Date.now();
    for (let pass = 1; pass <= PASSES; pass++) {
      for (const group of groups) {
        await group.setup?.();
        for (let rep = 0; rep < WARMUP + REPS; rep++) await group.step({ cpuRate, pass, record: rep >= WARMUP });
        await group.teardown?.();
      }
    }
    const { samples, longTasks, longTasksUnsupported } = await page.evaluate(() => ({ samples: window.__latency.samples, longTasks: window.__latency.longTasks, longTasksUnsupported: !!window.__latency.longTasksUnsupported }));
    const recorded = samples.filter(s => s.record && s.cpuRate === cpuRate);
    const names = [...new Set(recorded.map(s => s.control))];
    const controls = names.map(control => {
      const items = recorded.filter(s => s.control === control);
      const overlapping = items.flatMap(s => longTasks.filter(t => t.start < s.start + (s.completionMs ?? s.nextFrameOpportunityMs) && t.start + t.duration > s.start));
      const ack = stats(items.map(s => s.nextFrameOpportunityMs));
      return { control, samples: items.length, untrustedSamples: items.filter(s => !s.trusted).length,
        eventToSecondAnimationFrameMedianMs: ack.median, eventToSecondAnimationFrameP95Ms: ack.p95, eventToSecondAnimationFrameP99Ms: ack.p99, eventToSecondAnimationFrameMaxMs: ack.max,
        completion: { ...stats(items.filter(s => s.completionMs != null).map(s => s.completionMs)), witnessMissing: items.filter(s => s.completionMs == null).length,
          witnessAtSecondFrame: items.filter(s => s.witnessAtSecondFrame).length, maxFrame: Math.max(...items.map(s => s.completionFrame ?? 0)) },
        passes: Array.from({ length: PASSES }, (_, i) => { const own = items.filter(s => s.pass === i + 1).map(s => s.nextFrameOpportunityMs); return { pass: i + 1, samples: own.length, ...stats(own) }; }),
        longTasks: { count: overlapping.length, maxMs: round(Math.max(0, ...overlapping.map(t => t.duration))) },
        meetsTarget: ack.p95 <= TARGET_P95_MS };
    });
    await page.screenshot({ path: `/private/tmp/arx-chart-latency-${cpuRate}x.png`, fullPage: false });
    runs.push({ cpuRate, label: LABEL(cpuRate), viewport: await page.viewportSize(), seconds: (Date.now() - startedAt) / 1000, replayMounted,
      longTasksUnsupported, longTasks: { count: longTasks.length, maxMs: round(Math.max(0, ...longTasks.map(t => t.duration))), totalMs: round(longTasks.reduce((sum, t) => sum + t.duration, 0)) },
      targetMisses: controls.filter(c => !c.meetsTarget).map(c => `${c.control} ${c.eventToSecondAnimationFrameP95Ms}ms`), controls });
  }
  } finally {
    // Never leave a throttled page or an attached CDP session behind on failure.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
  }
  // Page errors first: a page error is the likeliest cause of a missing sample or witness.
  if (errors.length) throw Error(errors.join('\n'));
  for (const run of runs) {
    // Invariants (always enforced): every control was sampled REPS x PASSES times and
    // every sample reached its completion witness.
    const short = run.controls.filter(c => c.samples < REPS * PASSES).map(c => `${c.control}=${c.samples}`);
    if (run.controls.length !== EXPECTED_CONTROLS || short.length) throw Error(`Incomplete sampling at ${run.cpuRate}x: ${short.join(', ') || run.controls.length + ' controls'}`);
    const missing = run.controls.filter(c => c.completion.witnessMissing).map(c => `${c.control}=${c.completion.witnessMissing}`);
    if (missing.length) throw Error(`Completion witness missing at ${run.cpuRate}x within ${WITNESS_TIMEOUT_MS}ms: ${missing.join(', ')}`);
  }
  const misses = runs.filter(run => run.targetMisses.length).map(run => `${run.cpuRate}x: ${run.targetMisses.join(', ')}`);
  if (ENFORCE_P95_GATE && misses.length) throw Error(`Offline click-feedback p95 exceeded the ${TARGET_P95_MS}ms target. ${misses.join(' | ')}`);
  return { fixture: 'Actual SmartChartLayout + ARXNativeChart / synthetic 5,000-bar EURUSD M15 / 11 studies incl. 1000-period Bollinger and CCI / 40 drawings',
    method: 'Trusted input capture to second requestAnimationFrame after DOM commit; completion witness checked from that frame onwards. A render opportunity proxy, not a hardware presentation timestamp',
    replay: runs.every(run => !run.replayMounted) ? 'Not measured: the chart-qa fixture does not mount ChartReplayBoundary' : 'Replay entry present but not sampled by this scenario',
    gate: { targetP95Ms: TARGET_P95_MS, enforced: ENFORCE_P95_GATE }, repetitions: { warmup: WARMUP, perPass: REPS, passes: PASSES },
    // The target is recorded only when it is not the dev server (under any spelling), so
    // dev output is unchanged.
    ...(!DEFAULT_TARGET && { baseUrl: BASE_URL }), runs, errors };
}
