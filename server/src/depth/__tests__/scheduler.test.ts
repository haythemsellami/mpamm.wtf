import { afterEach, describe, expect, it, vi } from 'vitest';
import { DepthScheduler } from '../scheduler.js';
afterEach(() => vi.useRealTimers());
const head = (number: bigint) => ({ number, observedAt: Date.now() });

describe('depth block scheduling', () => {
  it('prices all demanded markets in one pass, without idle or repeated block work', async () => {
    const compute = vi.fn(async () => {});
    const scheduler = new DepthScheduler(compute);
    scheduler.observe(head(100n));
    expect(compute).not.toHaveBeenCalled();
    scheduler.demand('MON/USDC', true);
    scheduler.demand('BTC/USDC', true);
    scheduler.demand('ETH/USDC', true);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    expect(compute.mock.calls[0]).toEqual([['MON/USDC', 'BTC/USDC', 'ETH/USDC'], expect.objectContaining({ number: 100n })]);
    scheduler.observe(head(101n));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    expect(compute.mock.calls[1]).toEqual([['MON/USDC', 'BTC/USDC', 'ETH/USDC'], expect.objectContaining({ number: 101n })]);
    scheduler.observe(head(101n));
    await Promise.resolve();
    expect(compute).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it('coalesces slow work and removes withdrawn demand without overlapping a pass', async () => {
    let release!: () => void;
    const compute = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    const scheduler = new DepthScheduler(compute);
    scheduler.demand('MON/USDC', true); scheduler.demand('BTC/USDC', true);
    scheduler.observe(head(100n));
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    scheduler.observe(head(101n)); scheduler.observe(head(102n));
    scheduler.demand('BTC/USDC', false);
    expect(compute).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    expect(compute.mock.calls[1]).toEqual([['MON/USDC'], expect.objectContaining({ number: 102n })]);
    scheduler.stop(); release();
  });
  it.each(['withdraw', 'stop'])('cancels a queued subscription burst on %s', async (action) => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => {});
    const scheduler = new DepthScheduler(compute);
    scheduler.observe(head(100n));
    scheduler.demand('MON/USDC', true);
    if (action === 'withdraw') scheduler.demand('MON/USDC', false);
    else scheduler.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).not.toHaveBeenCalled();
    scheduler.stop();
  });
  it('honors an explicit rate cap using the newest observed block and cancels shutdown timers', async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => {});
    const scheduler = new DepthScheduler(compute, 1_000);
    scheduler.observe(head(100n));
    for (const market of ['MON/USDC', 'BTC/USDC', 'ETH/USDC']) scheduler.demand(market, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(compute.mock.calls).toEqual([[['MON/USDC', 'BTC/USDC', 'ETH/USDC'], expect.objectContaining({ number: 100n })]]);
    await vi.advanceTimersByTimeAsync(300); scheduler.observe(head(101n));
    await vi.advanceTimersByTimeAsync(300); scheduler.observe(head(102n));
    await vi.advanceTimersByTimeAsync(400);
    expect(compute.mock.calls.map((c: any[]) => c[1].number)).toEqual([100n, 102n]);
    scheduler.observe(head(103n)); scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
