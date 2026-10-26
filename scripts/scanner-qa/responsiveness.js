async page => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  const runs = [];
  for (const cpuRate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.setViewportSize(cpuRate === 1 ? { width: 1440, height: 1100 } : { width: 390, height: 844 });
    await page.goto('http://127.0.0.1:4194/?performance');
    await page.getByTestId('opportunity-row-EURUSD').waitFor();
    await page.getByLabel('Scanner refresh interval').selectOption('0');
    await page.evaluate(() => {
      window.__speed = { interactions: [], emptyTransitions: [], minRows: 43 };
      const rows = () => document.querySelectorAll('button[data-testid^="opportunity-row-"]').length;
      new MutationObserver(() => {
        const count = rows(); window.__speed.minRows = Math.min(window.__speed.minRows, count);
        if (!count) window.__speed.emptyTransitions.push(performance.now());
      }).observe(document.querySelector('[data-testid="opportunity-map"]'), { subtree: true, childList: true });
      document.addEventListener('click', event => {
        const row = event.target.closest('button[data-testid^="opportunity-row-"]');
        if (!row) return;
        const start = performance.now(), symbol = row.dataset.testid.slice('opportunity-row-'.length);
        requestAnimationFrame(() => requestAnimationFrame(() => window.__speed.interactions.push({
          symbol, nextFrameOpportunityMs: performance.now() - start,
          selectionCorrect: document.querySelector('[data-testid="fixture-selection"]').textContent === `Selected: ${symbol}`,
          rows: rows(), selectedMarker: row.getAttribute('aria-pressed'),
        })));
      }, true);
    });
    for (let index = 0; index < 20; index++) {
      const symbol = index % 2 ? 'GBPUSD' : 'EURUSD';
      await page.getByTestId(`opportunity-row-${symbol}`).click();
      // Deliberately wait for the controlled 450ms response so both versions can complete each sample.
      await page.waitForFunction(() => window.__scannerRequests.active === 0);
    }
    const result = await page.evaluate(() => ({ ...window.__speed, requests: window.__scannerRequests }));
    const timings = result.interactions.map(item => item.nextFrameOpportunityMs).sort((a, b) => a - b);
    runs.push({ cpuRate, viewport: await page.viewportSize(), clicks: timings.length,
      eventToSecondAnimationFrameP95Ms: timings[Math.ceil(timings.length * .95) - 1],
      eventToSecondAnimationFrameMaxMs: timings.at(-1), ...result });
    await page.screenshot({ path: `/private/tmp/arx-scanner-speed-${cpuRate}x.png`, fullPage: false });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  if (errors.length) throw Error(errors.join('\n'));
  return { fixture: 'Actual Opportunity Map / approved registry / invented data / 450ms delayed response',
    method: 'Trusted click capture to second requestAnimationFrame after DOM commit; a render opportunity proxy, not a hardware presentation timestamp', runs, errors };
}
