import type { HeadIdentity } from '../chain/heads.js';

export interface DepthHead { number: bigint; observedAt: number; identity?: HeadIdentity }

/** All demanded markets share a block pass. Serializing markets one by one
 * makes the third market inherit two full RPC waits. Pending heads coalesce,
 * and an interval only limits real head work; it never fabricates a tick. */
export class DepthScheduler {
  private active = new Set<string>();
  private pending = new Set<string>();
  private served = new Map<string, string>();
  private head?: DepthHead;
  private running = false;
  private stopped = false;
  private lastStarted = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private demandImmediate?: ReturnType<typeof setImmediate>;

  constructor(private readonly compute: (markets: string[], head: DepthHead) => Promise<void>,
    private readonly intervalMs = 0, private readonly onError: () => void = () => {}) {}

  demand(market: string, enabled: boolean): void {
    if (this.stopped) return;
    if (enabled) {
      if (!this.active.has(market)) { this.active.add(market); this.pending.add(market); }
    } else { this.active.delete(market); this.pending.delete(market); this.served.delete(market); }
    // IPC can deliver several market subscriptions in one turn. Collect that
    // burst before the first pass consumes the block's start-rate budget.
    this.demandImmediate ??= setImmediate(() => {
      this.demandImmediate = undefined;
      this.drain();
    });
  }
  demanded(market: string): boolean { return this.active.has(market); }
  observe(head: DepthHead): void {
    if (this.head && head.number < this.head.number
      && (head.identity?.revision ?? 0) <= (this.head.identity?.revision ?? 0)) return;
    this.head = head;
    for (const market of this.active) this.pending.add(market);
    this.drain();
  }
  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.demandImmediate) clearImmediate(this.demandImmediate);
  }
  private drain(): void {
    if (this.stopped || this.running || this.timer || this.demandImmediate || !this.head || !this.pending.size) return;
    const wait = this.intervalMs - (Date.now() - this.lastStarted);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, wait);
      return;
    }
    const head = this.head;
    const key = `${head.number}:${head.identity?.hash ?? ''}:${head.identity?.generation ?? 0}:${head.identity?.revision ?? 0}`;
    const markets = [...this.pending].filter((market) => this.active.has(market) && this.served.get(market) !== key);
    this.pending.clear();
    if (!markets.length) return;
    this.running = true;
    this.lastStarted = Date.now();
    for (const market of markets) this.served.set(market, key);
    void this.compute(markets, head).catch(this.onError).finally(() => {
      this.running = false;
      this.drain();
    });
  }
}
