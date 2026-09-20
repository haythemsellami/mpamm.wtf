import { expect, test, type Page } from '@playwright/test';

const health = async (page: Page) => (await (await page.request.get('/api/health')).json()).stream;
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { try { localStorage.setItem('pamm-tour-dismissed', '1'); } catch {} });
});

for (const [tab, topics] of [['markouts', 2], ['volume', 2], ['leaderboard', 1]] as const) {
  test(`${tab} defers quote history until Execution is opened`, async ({ page }) => {
    const history: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/quotes/history') history.push(request.url());
    });
    const bootstrap = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/bootstrap' && response.ok());
    await page.goto(`/${tab}`);
    await bootstrap;
    await expect.poll(async () => (await health(page)).topics).toBe(topics);
    const initialRequests = history.length;
    expect(initialRequests).toBe(0);
    const quoteHistory = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/quotes/history' && response.ok());
    await page.getByRole('button', { name: /EXECUTION$/ }).click();
    await quoteHistory;
    await expect(page.getByText('ROLLING_STATS', { exact: true })).toBeVisible();
    await expect.poll(async () => (await health(page)).topics).toBe(3);
    const executionRequests = history.length;
    expect(executionRequests).toBeGreaterThan(0);
    const back = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/bootstrap' && response.ok());
    await page.getByRole('button', { name: new RegExp(`${tab.toUpperCase()}$`) }).click();
    await back;
    await expect.poll(async () => (await health(page)).topics).toBe(topics);
    const returnRequests = history.length - executionRequests;
    expect(returnRequests).toBe(0);
    await test.info().attach('history-requests.json', { body: JSON.stringify({ tab, initialRequests, executionRequests, returnRequests }), contentType: 'application/json' });
  });
}

test('two browser tabs share one socket, union selections, and keep every dashboard page working', async ({ context, page }) => {
  const errors: string[] = [];
  const failedApi: string[] = [];
  context.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) failedApi.push(`${response.status()} ${response.url()}`);
  });
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('ROLLING_STATS', { exact: true })).toBeVisible();
  await expect.poll(async () => (await health(page)).topics).toBe(3);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('BID_ASK_DEPTH', { exact: true })).toBeVisible();
  await expect.poll(async () => (await health(page)).connections).toBe(1);
  await other.getByRole('button', { name: 'BTC/USDC', exact: true }).click();
  await expect.poll(async () => (await health(page)).topics).toBe(5);
  await other.getByRole('button', { name: /Uniswap/i }).click();
  await expect(other.getByRole('button', { name: /Uniswap/i })).toHaveAttribute('aria-pressed', 'true');
  await expect(other.getByText(/Uniswap.*0\.05%/i).first()).toBeVisible();
  await other.getByRole('button', { name: '$100k', exact: true }).click();
  await expect(other.getByRole('button', { name: '$100k', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await other.close();
  await expect.poll(async () => (await health(page)).topics).toBe(3);
  const paths = new Set<string>();
  page.on('request', (request) => paths.add(new URL(request.url()).pathname));
  await page.getByRole('button', { name: /VOLUME$/ }).click();
  await expect.poll(async () => (await health(page)).topics).toBe(2);
  await expect.poll(() => paths.has('/api/gas')).toBe(true);
  await page.getByRole('button', { name: /MARKOUTS$/ }).click();
  await expect(page.getByRole('button', { name: 'Pause the live tape' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(async () => (await health(page)).connections).toBe(0);
  const restoredFills = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/fills' && response.ok());
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await restoredFills;
  await expect.poll(async () => (await health(page)).connections).toBe(1);
  await page.getByRole('button', { name: 'Pause the live tape' }).click();
  await expect(page.getByRole('button', { name: 'Resume the live tape' })).toBeVisible();
  await page.getByRole('button', { name: /LEADERBOARD$/ }).click();
  await expect.poll(async () => (await health(page)).topics).toBe(1);
  await expect.poll(() => [...paths].some((path) => path.startsWith('/api/analytics/'))).toBe(true);
  const wideWindow = page.waitForResponse(async (response) => new URL(response.url()).pathname.startsWith('/api/analytics/')
    && response.ok() && (await response.json()).days === 30);
  await page.getByRole('button', { name: '30D', exact: true }).click();
  await wideWindow;
  await page.getByRole('button', { name: /EXECUTION$/ }).click();
  await expect.poll(async () => (await health(page)).topics).toBe(3);
  await page.getByRole('button', { name: /Switch to .* theme/ }).click();
  expect(errors).toEqual([]);
  expect(failedApi).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('desktop.png'), fullPage: true });
});

test('mobile and browsers without SharedWorker retain live quotes and reconnect after suspension', async ({ context, page }) => {
  await context.addInitScript(() => Object.defineProperty(window, 'SharedWorker', { value: undefined }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect.poll(async () => (await health(page)).connections).toBe(1);
  await page.getByLabel('Asset pair').selectOption('ETH/USDC');
  await page.getByLabel('Trade size', { exact: true }).selectOption('1000');
  await expect(page.getByLabel('Asset pair')).toHaveValue('ETH/USDC');
  await expect(page.getByText('ROLLING_STATS', { exact: true })).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(61_000);
  await expect.poll(async () => (await health(page)).connections).toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => (await health(page)).connections).toBe(1);
  await expect.poll(async () => (await health(page)).topics).toBe(3);
  await page.clock.setSystemTime(new Date());
  await page.clock.runFor(1000);
  await page.screenshot({ path: test.info().outputPath('mobile.png'), fullPage: true });
});

test('Execution displays each quote block and records browser-local delivery and draw timings', async ({ page }) => {
  const count = 20;
  test.setTimeout(30_000);
  await page.goto('/?timing=1');
  await expect(page.locator('[data-quote-block]')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window as any).__mpammTiming?.filter((s: any) => s.paintOpportunityAt).length ?? 0), { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
  const samples = await page.evaluate(() => (window as any).__mpammTiming.filter((s: any) => s.paintOpportunityAt));
  const blocks = samples.map((s: any) => s.block);
  expect(new Set(blocks).size).toBe(samples.length);
  expect(Math.max(...blocks) - Math.min(...blocks) + 1).toBe(samples.length);
  for (const sample of samples) {
    expect(sample.decodedAt).toBeGreaterThanOrEqual(sample.receivedAt);
    expect(sample.drawnAt).toBeGreaterThanOrEqual(sample.decodedAt);
    expect(sample.paintOpportunityAt).toBeGreaterThanOrEqual(sample.drawnAt);
  }
  const counter = Number(await page.locator('[data-quote-block]').getAttribute('data-quote-block'));
  expect(counter).toBeGreaterThanOrEqual(blocks.at(-1));
  expect(counter - blocks.at(-1)).toBeLessThanOrEqual(1);
});
