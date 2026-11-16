async page => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('http://127.0.0.1:4194/?performance');
  await page.getByTestId('opportunity-row-EURUSD').waitFor();
  await page.getByLabel('Scanner refresh interval').selectOption('0');
  const originalStamp = await page.getByTestId('opportunity-map-summary').textContent();
  for (const symbol of ['EURUSD', 'GBPUSD', 'USDJPY', 'EURUSD']) {
    await page.getByTestId(`opportunity-row-${symbol}`).click();
    if (await page.locator('button[data-testid^="opportunity-row-"]').count() !== 43) throw Error('Rows disappeared during selection');
    if (await page.getByTestId(`opportunity-row-${symbol}`).getAttribute('aria-pressed') !== 'true') throw Error('Selected highlight delayed');
    if (await page.getByTestId('opportunity-map-best-vs-selected').count()) throw Error('Old comparison survived pending selection');
  }
  await page.waitForFunction(() => window.__scannerRequests.active === 0);
  if (await page.getByTestId('opportunity-map-best-vs-selected').textContent() !== 'Comparison for EURUSD') throw Error('Latest selection lost');
  const requestCounts = await page.evaluate(() => window.__scannerRequests);
  if (requestCounts.cancelled < 2) throw Error('Obsolete reads were not cancelled');
  await page.evaluate(() => {
    window.__filters = [];
    document.querySelector('input[aria-label="Find in scanner results"]').addEventListener('input', event => {
      const start = performance.now(), value = event.target.value.toLowerCase();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rows = [...document.querySelectorAll('button[data-testid^="opportunity-row-"]')];
        window.__filters.push({ value, ms: performance.now() - start, count: rows.length,
          correct: rows.every(row => row.textContent.toLowerCase().includes(value)) });
      }));
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 390, height: 844 });
  for (let i = 0; i < 20; i++) {
    await page.getByLabel('Find in scanner results').fill(i % 2 ? '' : 'USD');
    await page.waitForFunction(n => window.__filters.length >= n, i + 1);
  }
  const filters = await page.evaluate(() => window.__filters);
  if (filters.some(item => !item.correct)) throw Error('Filter painted wrong rows');
  const timing = filters.map(item => item.ms).sort((a,b) => a-b);
  if (timing.at(-1) > 200) throw Error('Filter exceeded offline200ms budget');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow');
  await page.screenshot({ path: '/private/tmp/arx-scanner-speed-mobile-final.png', fullPage: false });
  await page.getByTestId('opportunity-row-EURUSD').focus();
  await page.keyboard.press('Enter');
  if (await page.getByTestId('opportunity-row-EURUSD').getAttribute('aria-pressed') !== 'true') throw Error('Keyboard selection failed');
  await page.getByRole('button', { name: 'Change fixture universe' }).click();
  // Different universes must never use the old43-row placeholder.
  if (await page.locator('button[data-testid^="opportunity-row-"]').count() === 43) throw Error('Cross-universe rows leaked');
  await page.waitForFunction(() => window.__scannerRequests.active === 0);
  const forexCount = await page.locator('button[data-testid^="opportunity-row-"]').count();
  if (!forexCount || forexCount >= 43) throw Error('Universe did not settle to forex');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  if (errors.length) throw Error(errors.join('\n'));
  return { rapidSelection: true, requestCounts, originalStamp, keyboard: true, mobileOverflow: false,
    filters: { count: filters.length, p95SecondAnimationFrameMs: timing[Math.ceil(timing.length * .95)-1], maxMs: timing.at(-1), cpuThrottle: 4 },
    crossUniverse: { forexCount }, errors };
}
