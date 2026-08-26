import { describe, expect, it, vi } from 'vitest';
import type { DailyVolume, Fill, MarketState, QuoteSnapshot } from '@shared';
import { BaseSource, type DepthPublication } from '../index.js';

class DemandSource extends BaseSource {
  readonly mode = 'sim' as const;
  readonly demand = vi.fn<(market: string, active: boolean) => void>();

  start(): Promise<void> { return Promise.resolve(); }
  stop(): void {}
  getState(): MarketState { return {} as MarketState; }
  getQuotes(): QuoteSnapshot { return {} as QuoteSnapshot; }
  getFills(): Fill[] { return []; }
  getVolume(): DailyVolume[] { return []; }
  protected onDepthDemand(market: string, active: boolean): void { this.demand(market, active); }
  publish(publication: DepthPublication): void { this.publishDepthPublication(publication); }
}

const publication = (block: number): DepthPublication => ({
  market: 'MON/USDC',
  asOfBlock: block,
  ts: block * 10,
  json: JSON.stringify({ market: 'MON/USDC', asOfBlock: block }),
});

describe('depth demand fanout', () => {
  it('runs one market producer for any number of viewers and stops after the last leaves', () => {
    const source = new DemandSource();
    const first = vi.fn();
    const second = vi.fn();

    const closeFirst = source.watchDepth('MON/USDC', first);
    const closeSecond = source.watchDepth('MON/USDC', second);

    expect(source.demand.mock.calls).toEqual([['MON/USDC', true]]);
    source.publish(publication(10));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    closeFirst();
    expect(source.demand).toHaveBeenCalledTimes(1);
    closeSecond();
    closeSecond();
    expect(source.demand.mock.calls).toEqual([['MON/USDC', true], ['MON/USDC', false]]);
  });

  it('replays the last completed curve immediately while fresh work warms', () => {
    const source = new DemandSource();
    source.publish(publication(20));
    const viewer = vi.fn();

    const close = source.watchDepth('MON/USDC', viewer);

    expect(viewer).toHaveBeenCalledWith(publication(20));
    expect(source.demand).toHaveBeenCalledWith('MON/USDC', true);
    close();
  });
});
