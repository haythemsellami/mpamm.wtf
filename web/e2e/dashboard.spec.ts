import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { topicKey, type MarketsResponse, type StreamEnvelope, type StreamTopic } from '@mpamm/shared';

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

test('Execution renders advancing quote frames and records browser-local delivery and draw timings', async ({ page }) => {
  const count = 20;
  test.setTimeout(30_000);
  await page.goto('/?timing=1');
  await expect(page.locator('[data-quote-block]')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window as any).__mpammTiming?.filter((s: any) => s.paintOpportunityAt).length ?? 0), { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
  const samples = await page.evaluate(() => (window as any).__mpammTiming.filter((s: any) => s.paintOpportunityAt));
  // Coalescing can skip heights; a newer revision can revisit an earlier one.
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i].revision).toBeGreaterThanOrEqual(samples[i - 1].revision);
    if (samples[i].revision === samples[i - 1].revision) expect(samples[i].block).toBeGreaterThanOrEqual(samples[i - 1].block);
  }
  for (const sample of samples) {
    expect(sample.decodedAt).toBeGreaterThanOrEqual(sample.receivedAt);
    expect(sample.drawnAt).toBeGreaterThanOrEqual(sample.decodedAt);
    expect(sample.paintOpportunityAt).toBeGreaterThanOrEqual(sample.drawnAt);
  }
});

test('Execution renders coalesced gaps, same-height replacements and ancestor rollbacks', async ({ context, page }) => {
  await context.addInitScript(() => Object.defineProperty(window, 'SharedWorker', { value: undefined }));
  const bootstrap = await (await page.request.get('/api/bootstrap')).json() as MarketsResponse;
  const base = bootstrap.state.block + 1;
  const venueId = bootstrap.state.venues.find((venue) => venue.role === 'venue')!.id;
  await page.route('**/api/bootstrap', (route) => route.fulfill({ json: bootstrap }));
  await page.route('**/api/quotes/history?*', (route) => route.fulfill({ json: [] }));
  let socket: WebSocketRoute | undefined;
  let topic: Extract<StreamTopic, { channel: 'quotes' }> | undefined;
  await page.routeWebSocket('**/stream', (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const subscription = JSON.parse(String(raw)) as { topics: StreamTopic[] };
      topic = subscription.topics.find((candidate) => candidate.channel === 'quotes');
    });
  });
  await page.goto('/?timing=1');
  await expect(page.locator('[data-quote-block]')).toBeVisible();
  await expect.poll(() => !!topic).toBe(true);
  const frames = [
    { block: base, revision: 0 }, { block: base + 3, revision: 0 },
    { block: base + 3, revision: 1 }, { block: base + 1, revision: 2 },
    { block: base + 6, revision: 2 },
  ];
  for (const [i, identity] of frames.entries()) {
    const ts = Date.now();
    const envelope: StreamEnvelope = {
      v: 2, epoch: 'replacement-fixture', topic: topicKey(topic!), seq: i + 1,
      message: { ch: 'quotes', data: { ...identity, blockHash: `0x${(i + 1).toString(16).padStart(64, '0')}`, monUsd: 1, ts,
        rows: [{ venueId, market: topic!.market, sizeUsd: topic!.sizeUsd, bidPx: 1, askPx: 1.001,
          bidBps: 0, askBps: 10, spreadBps: 10, feeBps: 0, filledFull: true, ts }] } },
    };
    socket!.send(JSON.stringify(envelope));
    await expect.poll(async () => page.evaluate(() => (window as any).__mpammTiming?.filter((s: any) => s.paintOpportunityAt).length ?? 0)).toBe(i + 1);
    await expect(page.locator('[data-quote-block]')).toHaveAttribute('data-quote-block', String(identity.block));
  }
  const samples = await page.evaluate(() => (window as any).__mpammTiming);
  expect(samples.map(({ block, revision }: any) => ({ block, revision }))).toEqual(frames);
  expect(new Set(samples.map((s: any) => `${s.revision}:${s.block}`)).size).toBe(frames.length);
  for (const sample of samples) {
    expect(sample.decodedAt).toBeGreaterThanOrEqual(sample.receivedAt);
    expect(sample.drawnAt).toBeGreaterThanOrEqual(sample.decodedAt);
    expect(sample.paintOpportunityAt).toBeGreaterThanOrEqual(sample.drawnAt);
  }
});

test('Execution replays quotes collected on other pages and loads shared five-minute statistics', async ({ page, context }) => {
  const quoteRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/quotes\/(history|stats)$/.test(new URL(request.url()).pathname)) quoteRequests.push(request.url());
  });
  await page.goto('/volume');
  await expect.poll(async () => (await health(page)).topics).toBe(2);
  const historyUrl = '/api/quotes/history?market=MON%2FUSDC&size=1000';
  const initial = await (await page.request.get(historyUrl)).json();
  const firstBlock = initial.at(-1).block;
  await expect.poll(async () => {
    const quotes = await (await page.request.get(historyUrl)).json();
    return quotes.at(-1)?.block ?? 0;
  }).toBeGreaterThanOrEqual(firstBlock + 8);
  expect(quoteRequests).toEqual([]);
  const replayResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/quotes/history' && response.ok());
  const statsResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/quotes/stats' && response.ok());
  await page.getByRole('button', { name: /EXECUTION$/ }).click();
  const replay = await (await replayResponse).json();
  const stats = await (await statsResponse).json();
  const duringAbsence = replay.filter((q: { block: number }) => q.block > firstBlock && q.block <= firstBlock + 8);
  expect(duringAbsence.map((q: { block: number }) => q.block)).toEqual(Array.from({ length: 8 }, (_, i) => firstBlock + i + 1));
  expect(stats.windowMs).toBe(300_000);
  const reference = stats.rows.find((row: { venueId: string }) => row.venueId === 'bybit');
  expect(reference.n).toBeGreaterThanOrEqual(8);
  await expect.poll(async () => Number(await page.locator('[data-stats-venue="bybit"]').getAttribute('data-stats-n'))).toBeGreaterThanOrEqual(reference.n);
  await expect(page.locator('canvas[data-quote]')).toBeVisible();

  // A new browser context has no local samples or shared worker. It must see
  // the existing server window immediately, rather than start its own count.
  const freshContext = await context.browser()!.newContext();
  try {
    const newcomer = await freshContext.newPage();
    await newcomer.goto('/');
    await expect.poll(async () => Number(await newcomer.locator('[data-stats-venue="bybit"]').getAttribute('data-stats-n'))).toBeGreaterThanOrEqual(reference.n);
  } finally { await freshContext.close(); }
  await page.screenshot({ path: test.info().outputPath('shared-execution-history.png'), fullPage: true });
});
