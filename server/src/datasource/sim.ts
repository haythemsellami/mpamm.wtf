import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, HISTORY_START_UTC, ASSETS, pairOf, cexForBase, depthSizes,
  type DataSourceMode, type DepthSnapshot, type MarketState, type QuoteSnapshot, type QuoteRow,
  type Fill, type DailyVolume, type VenueMeta, type Side, type FillCategory,
  type GasResponse, type VenueGasDaily,
} from '@shared';
import { config } from '../config.js';
import { NoteBuffer } from '../notes.js';
import { clamp, utcDay, nextId, annotateCex } from '../util.js';
import { ADAPTERS, venueMeta, validateRegistry } from '../venues/registry.js';
import { buildDepthSnapshot } from '../depth.js';

/**
 * SimDataSource — a venue-agnostic simulator for offline/dev (`DATA_SOURCE=sim`).
 * It reads the venue registry (so the same adapters appear) and produces the
 * exact same generic contract the live source does: `venueId` quotes/fills and
 * `byVenue` daily volume. Per-venue quote/markout params are assigned
 * deterministically by registry order — no venue names are hardcoded.
 */

/** Rough synthetic USD prices per base asset (dev only; the live source uses the CEX feeds). */
const ASSET_PX: Record<string, number> = { MON: 0.01928, BTC: 98000, ETH: 3500 };
const BASE_MON = ASSET_PX.MON;

interface SimFill extends Fill { bornMs: number; }
/** `capDecades` = how many log10 decades above $100 this venue can still fill
 *  in full — its quoted depth cap, the thing BID_ASK_DEPTH draws a leg up to. */
interface Param { offset: number; half: number; slip: number; markoutBias: number; weight: number; capDecades: number }

function rnd(): number { return Math.random() * 2 - 1; }
/** deterministic string → [0,1) — stable per-(day,venue) sim jitter. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10_000) / 10_000;
}
function wpick<T>(a: T[], w: number[]): T {
  const r = Math.random() * w.reduce((x, y) => x + y, 0);
  let c = 0;
  for (let i = 0; i < a.length; i++) { c += w[i]; if (r < c) return a[i]; }
  return a[a.length - 1];
}
function rhex(n: number): string {
  let s = ''; const c = '0123456789abcdef';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * 16)];
  return s;
}
function txS(): string { return '0x' + rhex(4) + '…' + rhex(4); }

export class SimDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'sim';

  private venues: VenueMeta[] = venueMeta();
  private display: VenueMeta[] = this.venues.filter((v) => v.role === 'venue');
  private baselines: VenueMeta[] = this.venues.filter((v) => v.role === 'baseline');
  private references: VenueMeta[] = this.venues.filter((v) => v.role === 'reference');
  private param: Record<string, Param> = {};
  /** the sim's one note: what this data is. Raised at construction, not per
   *  request, so its timestamp says when the process started. */
  private notes = new NoteBuffer();

  private px: Record<string, number> = { ...ASSET_PX };
  /** MON price alias (the header/`monUsd`), backed by the per-asset price map. */
  private get mon(): number { return this.px.MON; }
  private set mon(v: number) { this.px.MON = v; }
  /** synthetic USD price for a market's base asset. */
  private basePx(market: string): number { const b = pairOf(market)?.base; return (b && this.px[b]) || this.px.MON || 1; }
  /** synthetic USD price of a market's quote token — $1 for stables, the
   *  asset's own price when the pair is quoted in a crypto asset. */
  private quotePx(market: string): number { const p = pairOf(market); return (p?.quoteKind === 'asset' && this.px[p.quote]) || 1; }
  private chg = 2.3;
  private block = 84_500_000;
  private days: DailyVolume[] = [];
  private fills: SimFill[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pools: Record<string, string> = {};
  private addrs: string[] = [];
  private routers = ['Uniswap Universal Router', 'KyberSwap: Meta Aggregation', 'Relay: Approval Proxy V3', '1inch v6 Router', 'Odos Router v2'];

  constructor() {
    super();
    // baselines simulate a standard-DEX cost envelope (design's UniV4 mock):
    // wide half-spread, strong size sensitivity, slight positive offset.
    this.baselines.forEach((v) => {
      this.param[v.id] = { offset: 0.8, half: 9.0, slip: 4.2, markoutBias: 0, weight: 0, capDecades: 4 };
    });
    // deterministic per-venue params by registry order (venue 0 = tightest/heaviest).
    // Depth caps shrink down the order too, so the offline preview shows what
    // live venues actually do on BID_ASK_DEPTH: some legs run to the top of the
    // axis, others stop where the venue stops quoting size.
    this.display.forEach((v, i) => {
      this.param[v.id] = {
        offset: -0.4 - i * 0.7, half: 1.2 + i * 0.7, slip: 1.0 + i * 1.3,
        markoutBias: i === 0 ? 0.6 : i === 1 ? 0.0 : -0.4,
        weight: Math.max(0.1, 0.55 - i * 0.22),
        capDecades: Math.max(2.5, 4 - i * 0.35),
      };
    });
    this.notes.note('source.sim', 'simulated data — set DATA_SOURCE=live for on-chain quotes');
  }

  async start(): Promise<void> {
    validateRegistry(); // fail loud on a duplicate/invalid venue id (dev parity with live)
    this.initEntities();
    for (let i = 0; i < 220; i++) this.mutate();   // warm the walk so opening quotes look settled
    this.seedHistory();
    this.seedFills();
    this.timer = setInterval(() => this.tick(), config.quoteIntervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  // ── reads ─────────────────────────────────────────────────────────────────
  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: this.mon, monChangePct: this.chg,
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'sim', venues: this.venues,
      notes: this.notes.list(),
      realtime: {
        headBlock: this.block, quoteBlock: this.block, lagBlocks: 0, frameMs: 0, headToFrameMs: 0, eventLoopLagMs: 0,
        coveragePct60s: 100, coalescedBlocks60s: 0, headSource: 'sim', wsStatus: 'disabled',
      },
    };
  }
  getQuotes(): QuoteSnapshot {
    const ts = Date.now();
    return {
      block: this.block,
      monUsd: this.mon,
      ts,
      rows: this.buildMatrix(),
      frame: {
        headSource: 'sim', headObservedAt: ts, quoteStartedAt: ts, quoteCompletedAt: ts, emittedAt: ts,
        durationMs: 0, adapterMs: {}, missingVenues: [], coalescedBlocks: 0,
      },
    };
  }
  getFills(): Fill[] { return this.fills.map(stripFill); }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d, byVenue: { ...d.byVenue } })); }

  /** BID_ASK_DEPTH, simulated — the same model over the log-spaced grid, run
   *  through the SAME builder live uses, so the panel exercises the real shape
   *  (skewed legs, depth caps, one-sided venues) with no network. Free here:
   *  the sim's quoter is arithmetic, not RPC, so there is nothing to throttle. */
  private buildDepth(market: string): DepthSnapshot {
    if (!config.depthEnabled) return { market, asOfBlock: this.block, refMid: 0, ts: Date.now(), venues: [] };
    const sizes = depthSizes(config.depthSamples);
    // the sim's bps are all measured off basePx — the same number quoteAt() uses
    // as the mid, so refMid and the curve can never be anchored differently.
    return buildDepthSnapshot(this.buildMatrix(sizes), market, sizes, this.basePx(market), this.block, Date.now());
  }

  protected onDepthDemand(market: string, active: boolean): void {
    if (active) this.publishDepth(this.buildDepth(market));
  }

  /** QUOTE_UPDATE_BURN, simulated. Which venues have a series mirrors live
   *  exactly: the adapters that declare gasSources() (venue-agnostic — a venue
   *  with an external oracle simply never declares the hook). Values are
   *  deterministic per (day, venue) so polls don't flicker; today's partial
   *  bucket scales with the elapsed day fraction like real accrual. */
  gasSeries(): GasResponse {
    const gasAdapters = ADAPTERS.filter((a) => typeof a.gasSources === 'function');
    const vids: string[] = [];
    const approx: string[] = [];
    for (const a of gasAdapters) {
      const v = a.venues()[0];
      if (!v) continue;
      vids.push(v.id);
      // 'blocks'-mode venues are estimates (≈). Before discovery the source
      // can't be enumerated (throws) — those are exactly the sampled ones.
      try { if (a.gasSources!().some((s) => s.mode === 'blocks')) approx.push(v.id); }
      catch { approx.push(v.id); }
    }
    // venue-lifetime like live: each venue's series runs from its sinceUtc
    // (clamped to the sim's own history start).
    const sinceOf = new Map(this.venues.map((v) => [v.id, v.sinceUtc ?? '']));
    const dayFrac = Math.max(0.02, (Date.now() - Date.parse(`${utcDay()}T00:00:00Z`)) / 86_400_000);
    const days = this.days
      .map((d) => {
        const byVenue: Record<string, VenueGasDaily> = {};
        vids.forEach((vid, i) => {
          const since = sinceOf.get(vid) ?? '';
          if (since && d.utcDay < since) return; // venue didn't exist yet
          const j = 0.94 + 0.12 * hash01(d.utcDay + vid);
          const scale = (d.partial ? dayFrac : 1) * j;
          byVenue[vid] = { mon: (820 - i * 185) * scale, txs: Math.round((3300 - i * 740) * scale) };
        });
        return { utcDay: d.utcDay, partial: d.partial, byVenue };
      });
    return { days, approx };
  }

  // ── quote model ─────────────────────────────────────────────────────────────
  /** Half-spread in bps at a notional: a linear cost of size plus a CONVEX tail
   *  that runs away as the notional approaches the venue's depth cap. Real
   *  books/pools deplete rather than degrade linearly, and it is that bend the
   *  BID_ASK_DEPTH curve exists to show — a linear model draws a straight line
   *  and hides the thing being measured. */
  private halfSpread(id: string, size: number): number {
    const p = this.param[id];
    const st = Math.log10(size / 100);
    return p.half + p.slip * st + (st / p.capDecades) ** 3.6 * p.slip * 0.6 * p.capDecades;
  }

  /** True while the venue can still fill the whole notional (QuoteRow.filledFull). */
  private fillsFull(id: string, size: number): boolean {
    return Math.log10(size / 100) <= this.param[id].capDecades + 1e-9;
  }

  private quoteAt(id: string, market: string, size: number): { bidBps: number; askBps: number; bidPx: number; askPx: number } {
    const mid = this.basePx(market);
    const hsz = this.halfSpread(id, size);
    const o = this.param[id].offset;
    const bid = o - hsz, ask = o + hsz;
    return { bidBps: bid, askBps: ask, bidPx: mid * (1 + bid / 1e4), askPx: mid * (1 + ask / 1e4) };
  }

  /** One quote matrix over an arbitrary notional grid. The four SIZE pills feed
   *  the streamed frame; the log-spaced depth grid feeds BID_ASK_DEPTH — same
   *  model, same params, so the two agree wherever the grids overlap. */
  private buildMatrix(sizes: readonly number[] = SIZES_USD): QuoteRow[] {
    const ts = Date.now();
    const rows: QuoteRow[] = [];
    for (const v of this.display) {
      for (const market of MARKETS) {
        for (const size of sizes) {
          const q = this.quoteAt(v.id, market, size);
          const sizeStep = Math.log10(size / 100);
          rows.push({
            venueId: v.id, market, sizeUsd: size,
            bidBps: q.bidBps, askBps: q.askBps, bidPx: q.bidPx, askPx: q.askPx,
            spreadBps: q.askBps - q.bidBps,
            filledFull: this.fillsFull(v.id, size),
            feeBps: v.kind === 'amm' ? 0.3 + 0.04 * sizeStep : 0,
            ts,
          });
        }
      }
    }
    // baseline (standard-DEX band) rows — quote-only, exec page. Fee tier label
    // parity with live: feeBps = the mock pool's tier (0.05% → 5bps).
    for (const v of this.baselines) {
      for (const market of MARKETS) {
        for (const size of sizes) {
          const q = this.quoteAt(v.id, market, size);
          rows.push({
            venueId: v.id, market, sizeUsd: size,
            bidBps: q.bidBps, askBps: q.askBps, bidPx: q.bidPx, askPx: q.askPx,
            spreadBps: q.askBps - q.bidBps,
            filledFull: this.fillsFull(v.id, size), feeBps: 5, ts,
          });
        }
      }
    }
    // reference (CEX) taker rows: routed per market (Bybit for MON, Binance for
    // BTC/ETH), a tight symmetric band + that CEX's taker fee.
    const refRows: QuoteRow[] = [];
    const refIds = new Set(this.references.map((r) => r.id));
    for (const market of MARKETS) {
      const base = pairOf(market)?.base ?? 'MON';
      const refId = cexForBase(base);
      if (!refIds.has(refId)) continue;
      const takerBps = refId === 'binance' ? config.binanceTakerBps : config.takerBps;
      const mid = this.basePx(market);
      for (const size of sizes) {
        // fee-dominated and barely size-sensitive — the CEX leg is the wide,
        // near-vertical reference the on-chain curves are read against.
        const half = 0.15 + takerBps + 0.08 * Math.log10(size / 100);
        const bid = -half, ask = half;
        refRows.push({
          venueId: refId, market, sizeUsd: size,
          bidBps: bid, askBps: ask, bidPx: mid * (1 + bid / 1e4), askPx: mid * (1 + ask / 1e4),
          spreadBps: ask - bid, filledFull: true, feeBps: takerBps, ts,
        });
      }
    }
    annotateCex(rows, refRows);
    return [...rows, ...refRows];
  }

  private mutate(): void {
    for (const key of Object.keys(ASSETS)) {
      const anchor = ASSET_PX[key] ?? 1;
      this.px[key] = clamp((this.px[key] ?? anchor) * (1 + rnd() * 0.0006), anchor * 0.95, anchor * 1.05);
    }
    this.chg = clamp(this.chg + rnd() * 0.05, -8, 8);
    for (const v of this.display) {
      const p = this.param[v.id];
      p.offset += rnd() * 0.15; p.half += rnd() * 0.08;
      if (Math.random() < 0.05) { p.half += rnd() * 0.8; p.offset += rnd() * 0.6; }
      p.offset = clamp(p.offset, -6, 6);
      p.half = clamp(p.half, 0.5, 13);
    }
  }

  // ── volume history (byVenue) ────────────────────────────────────────────────
  private weights(): number[] { return this.display.map((v) => this.param[v.id].weight); }

  private splitAcross(total: number, sw: number): Record<string, { usd: number; swaps: number }> {
    const ws = this.weights();
    const sumW = ws.reduce((a, b) => a + b, 0) || 1;
    const byVenue: Record<string, { usd: number; swaps: number }> = {};
    let swLeft = sw;
    this.display.forEach((v, i) => {
      const frac = ws[i] / sumW;
      const swaps = i === this.display.length - 1 ? swLeft : Math.round(sw * frac);
      swLeft -= swaps;
      byVenue[v.id] = { usd: total * frac * 1e6, swaps: Math.max(0, swaps) };
    });
    return byVenue;
  }

  private seedHistory(): void {
    const start = Date.parse(HISTORY_START_UTC + 'T00:00:00Z');
    const today = Date.parse(utcDay() + 'T00:00:00Z');
    const n = Math.max(2, Math.round((today - start) / 86_400_000) + 1);
    for (let i = 0; i < n; i++) {
      const dt = new Date(start + i * 86_400_000);
      const ramp = Math.min(1, i / 20);
      let total = 0.06 + ramp * ramp * (3.2 + Math.random() * 1.8);
      if (Math.random() < 0.13) total *= 1.5 + Math.random() * 1.5;
      const partial = i === n - 1;
      if (partial) total *= 0.42;
      const sw = Math.round(total * (95 + Math.random() * 45));
      this.days.push({ utcDay: dt.toISOString().slice(0, 10), byVenue: this.splitAcross(total, sw), partial });
    }
  }
  private bumpVolume(): void {
    const d = this.days[this.days.length - 1];
    if (!d) return;
    const add = (0.004 + Math.random() * 0.02);
    const swAdd = Math.round(1 + Math.random() * 2);
    const inc = this.splitAcross(add, swAdd);
    for (const [id, vd] of Object.entries(inc)) {
      const cur = (d.byVenue[id] ??= { usd: 0, swaps: 0 });
      cur.usd += vd.usd; cur.swaps += vd.swaps;
    }
  }

  // ── fills ─────────────────────────────────────────────────────────────────
  private initEntities(): void {
    for (const v of this.display) for (const m of MARKETS) this.pools[v.id + m] = txS();
    this.addrs = Array.from({ length: 14 }, () => txS());
  }

  private makeFill(ageSec: number, big: boolean): SimFill {
    const market = MARKETS[Math.floor(Math.random() * MARKETS.length)];
    const side: Side = Math.random() < 0.5 ? 'buy' : 'sell';
    const v = this.display.length ? wpick(this.display, this.weights()) : this.venues[0];
    const cr = Math.random();
    const cat: FillCategory = cr < 0.14 ? 'ROUTER' : cr < 0.22 ? 'AGG' : cr < 0.34 ? 'CEX/DEX' : 'DIRECT';
    const usd = big ? 60000 + Math.random() * 640000 : (Math.random() < 0.72 ? 50 + Math.random() * 9000 : 9000 + Math.random() * 90000);
    // execPx is quote units per base unit (the @shared Fill contract): a
    // market quoted in a crypto asset divides by that asset's USD price.
    // baseAmount is then derived from usd through the quote leg, so usd,
    // baseAmount and execPx always agree — noise included.
    const quoteUsd = this.quotePx(market);
    const execPx = this.basePx(market) / quoteUsd * (1 + rnd() * 0.0009);
    const e0 = (this.param[v.id]?.markoutBias ?? 0) + rnd() * 1.6;
    const ss = side === 'buy' ? 1 : -1;
    let dd = 0;
    const mk: number[] = [e0];
    for (const h of [5, 10, 30, 60]) { dd += rnd() * Math.sqrt(h) * 1.05; mk.push(e0 + ss * dd); }
    const pool = this.pools[v.id + market] ?? txS();
    const to = (cat === 'ROUTER' || cat === 'AGG')
      ? this.routers[Math.floor(Math.random() * this.routers.length)]
      : (Math.random() < 0.85 ? this.addrs[Math.floor(Math.random() * this.addrs.length)] : txS());
    const bornMs = Date.now() - ageSec * 1000;
    return {
      id: nextId('sim'), bornMs,
      venueId: v.id, market, side, category: cat,
      usd, baseAmount: usd / (execPx * quoteUsd), execPx,
      txHash: txS(), to, pool,
      blockNumber: Math.max(1, this.block - Math.round(ageSec / 0.4)),
      ts: bornMs, markoutsBps: mk,
    };
  }

  private seedFills(): void {
    for (let i = 0; i < 260; i++) this.fills.push(this.makeFill(Math.random() * 86400, Math.random() < 0.18));
    const recent: SimFill[] = [];
    for (let i = 0; i < 48; i++) recent.push(this.makeFill(Math.random() * 85, Math.random() < 0.12));
    recent.sort((a, b) => a.bornMs - b.bornMs);
    this.fills.push(...recent);
    this.fills.sort((a, b) => a.bornMs - b.bornMs);
    if (this.fills.length > 360) this.fills = this.fills.slice(-360);
  }

  private spawnFill(): void {
    if (Math.random() < 0.55) {
      const f = this.makeFill(0, Math.random() < 0.14);
      this.fills.push(f);
      if (this.fills.length > 360) this.fills.shift();
      this.emitMsg({ ch: 'fill', data: stripFill(f) });
    }
  }

  private tick(): void {
    this.mutate();
    // One synthetic block per synthetic quote frame. The simulator's cadence
    // is configurable and its coverage telemetry must describe its own stream,
    // not pretend it skipped every other live-chain block.
    this.block += 1;
    this.bumpVolume();
    this.spawnFill();
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.getQuotes() });
    if (config.depthEnabled) {
      for (const market of this.depthDemandedMarkets()) this.publishDepth(this.buildDepth(market));
    }
    const last = this.days[this.days.length - 1];
    if (last) this.emitMsg({ ch: 'volume', data: { ...last, byVenue: { ...last.byVenue } } });
  }
}

function stripFill(f: SimFill): Fill {
  const { bornMs, ...rest } = f;
  return rest;
}
