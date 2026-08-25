import { useEffect, useRef } from 'react';
import { type VenueMeta } from '@shared';
import { useDashboard } from '../store';
import { hexA, venueColor, CH } from '../theme';
import { continuousQuoteRuns, quoteFrameTime, type QuotePoint } from '../lib/quote-series';

const QUOTE_WINDOW_MS = 60_000;

/**
 * Streaming bid/ask QUOTE chart — a STEP (staircase) chart, because quotes are
 * discrete events (one sample per poll/block): hold each sample flat until the
 * next, then step. No smoothing / linear interpolation. Per venue: solid ask +
 * dashed bid step lines and a translucent stepped ribbon between them; the
 * widest-spread venues' fills paint first (underneath) so tighter venues stay
 * legible, then all strokes on top. Port of the design's draw() (data-quote).
 *
 * Reliability (design parity): repaint is driven by the data cadence (`d.frame`)
 * — which survives tab unmount/remount — plus a mount rAF + setTimeout backup for
 * late layout and a resize handler; the canvas ref self-heals via the
 * `data-quote` marker if it's missing or detached.
 */
export function QuoteCanvas() {
  const d = useDashboard();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<() => void>(() => {});

  // rebuilt every render so it closes over the latest series / selection
  paintRef.current = () => {
    // self-heal a missing/detached ref (racy mount, or a stale node after a
    // tab-away-and-back) by re-acquiring the marked canvas.
    let cv = ref.current;
    if (!cv || !cv.isConnected) cv = ref.current = document.querySelector('canvas[data-quote]');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return; // laid out yet? the mount backup retries
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padR = 10, padT = 12, padB = 22;
    const ch = CH[d.theme]; // theme-aware canvas chrome colors (can't use var())
    // propAMM venues + the selected pair's CEX reference (Bybit for MON, Binance for
    // BTC/ETH), filtered by the user's toggles. Everything comes from the registry.
    const cexRef = d.referenceFor(d.pair);
    const chips: VenueMeta[] = [...d.displayVenues, ...d.baselines, ...(cexRef ? [cexRef] : [])];
    const active = chips.filter((v) => d.venueToggles[v.id]);
    if (!active.length) return;

    // Keep the window attached to wall time. If the stream stalls, the last
    // observed quote visibly ages leftward instead of remaining pinned at NOW.
    const endTs = Math.max(Date.now(), d.quotes ? quoteFrameTime(d.quotes) : 0);
    const startTs = endTs - QUOTE_WINDOW_MS;

    let mn = Infinity, mx = -Infinity;
    for (const v of active) {
      const s = d.series[v.id];
      if (!s) continue;
      for (const p of s.points) {
        if (p.ts < startTs) continue;
        for (const px of [p.bid, p.ask]) {
          if (px === null) continue;
          if (px < mn) mn = px;
          if (px > mx) mx = px;
        }
      }
    }
    if (!isFinite(mn) || mn === mx) return;
    const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;

    ctx.font = '9px "JetBrains Mono", monospace';
    // Tick precision comes from the STEP BETWEEN GRIDLINES, never the absolute
    // price: what an axis has to resolve is the span it draws. The old fixed
    // toFixed(5) printed every MON/ETH gridline (~1.1e-5) as the same
    // "0.00001", leaving the axis with no information at all.
    const GRID = 4;
    const tickDp = Math.min(10, Math.max(0, -Math.floor(Math.log10((mx - mn) / GRID))));
    const ticks = Array.from({ length: GRID + 1 }, (_, g) => mn + (mx - mn) * g / GRID);
    const labels = ticks.map((p) => p.toFixed(tickDp));
    // MEASURE the gutter rather than guessing it. The old constant 58px clipped
    // a 5-digit BTC price ("62210.02" drew as "2210.02"), and no constant can
    // also fit the extra decimals a small-unit pair needs — so the axis pays
    // for exactly the width its own labels take.
    const padL = Math.max(58, Math.ceil(Math.max(...labels.map((l) => ctx.measureText(l).width))) + 12);

    const X = (ts: number) => padL + Math.max(0, Math.min(1, (ts - startTs) / QUOTE_WINDOW_MS)) * (w - padL - padR);
    const Y = (p: number) => padT + (1 - (p - mn) / (mx - mn)) * (h - padT - padB);

    ctx.lineWidth = 1;
    for (let g = 0; g <= GRID; g++) {
      const y = Y(ticks[g]);
      ctx.strokeStyle = ch.grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = ch.label; ctx.textAlign = 'right'; ctx.fillText(labels[g], padL - 6, y + 3);
    }
    ctx.textAlign = 'center';
    // The x-axis is wall time, not "sample index × nominal cadence". A dropped
    // block therefore occupies real horizontal space instead of being erased.
    const TICKS = 6;
    for (let k = 0; k <= TICKS; k++) {
      const ts = startTs + (k / TICKS) * QUOTE_WINDOW_MS, x = X(ts);
      const secAgo = Math.round((1 - k / TICKS) * QUOTE_WINDOW_MS / 1000);
      ctx.strokeStyle = ch.grid2;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.fillStyle = ch.label2; ctx.fillText('-' + secAgo + 's', x, h - 7);
    }

    const stepPath = (run: readonly QuotePoint[], side: 'bid' | 'ask') => {
      ctx.beginPath();
      run.forEach((point, i) => {
        const px = point[side]!;
        const x = X(point.ts), y = Y(px);
        if (!i) ctx.moveTo(x, y);
        else { ctx.lineTo(x, Y(run[i - 1][side]!)); ctx.lineTo(x, y); } // hold, then step
      });
    };
    const strokeRun = (run: readonly QuotePoint[], side: 'bid' | 'ask') => {
      if (run.length > 1) stepPath(run, side);
      else {
        ctx.beginPath();
        ctx.arc(X(run[0].ts), Y(run[0][side]!), 1.35, 0, Math.PI * 2);
      }
      ctx.stroke();
    };

    // FILLS first — widest-spread band underneath so tighter venues stay legible.
    const spreadOf = (v: VenueMeta) => {
      const r = d.quotes?.rows.find((x) => x.venueId === v.id && x.market === d.pair && x.sizeUsd === d.size);
      return r ? Math.abs(r.spreadBps) : Infinity; // no live quote → treat as widest (underneath)
    };
    const byW = [...active].sort((a, b) => spreadOf(b) - spreadOf(a));
    for (const v of byW) {
      const s = d.series[v.id];
      if (!s) continue;
      for (const run of continuousQuoteRuns(s.points, 'both', startTs)) {
        if (run.length < 2) continue; // need both sides for a ribbon (one-sided venues skip)
        ctx.beginPath();
        ctx.moveTo(X(run[0].ts), Y(run[0].ask!));
        for (let i = 1; i < run.length; i++) {
          ctx.lineTo(X(run[i].ts), Y(run[i - 1].ask!));
          ctx.lineTo(X(run[i].ts), Y(run[i].ask!));
        }
        const last = run.length - 1;
        ctx.lineTo(X(run[last].ts), Y(run[last].bid!));
        for (let i = last; i > 0; i--) {
          ctx.lineTo(X(run[i - 1].ts), Y(run[i].bid!));
          ctx.lineTo(X(run[i - 1].ts), Y(run[i - 1].bid!));
        }
        ctx.closePath();
        // baseline (standard-DEX) venues render as a HEAVIER cost-envelope band —
        // the design's ribbonB — so the propAMM lines visibly sit inside it.
        ctx.fillStyle = hexA(venueColor(v, d.theme), v.role === 'baseline' ? ch.ribbonB : ch.ribbon); ctx.fill();
      }
    }

    // STROKES on top — solid stepped ask, dashed stepped bid (each side drawn
    // independently so a one-sided venue still shows its real line).
    for (const v of active) {
      const s = d.series[v.id];
      if (!s) continue;
      const bench = v.role === 'baseline'; // heavier strokes frame the band (design)
      ctx.strokeStyle = venueColor(v, d.theme);
      ctx.lineWidth = bench ? 1.9 : 1.5;
      ctx.setLineDash([]);
      for (const run of continuousQuoteRuns(s.points, 'ask', startTs)) strokeRun(run, 'ask');
      ctx.lineWidth = bench ? 1.4 : 1.1;
      ctx.setLineDash([3, 3]);
      for (const run of continuousQuoteRuns(s.points, 'bid', startTs)) strokeRun(run, 'bid');
      ctx.setLineDash([]);
    }
  };

  // repaint on the data cadence + on venue/pair/size/theme changes (survives remount)
  useEffect(() => { paintRef.current(); }, [d.frame, d.venueToggles, d.venues, d.pair, d.size, d.series, d.theme]);

  // mount: paint now + backups for late layout, and repaint on resize
  useEffect(() => {
    const p = () => paintRef.current();
    p();
    const raf = requestAnimationFrame(p);
    const t = setTimeout(p, 80);
    const clock = setInterval(p, 1_000);
    window.addEventListener('resize', p);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); clearInterval(clock); window.removeEventListener('resize', p); };
  }, []);

  return <canvas ref={ref} data-quote="1" style={{ display: 'block', width: '100%', height: 360 }} />;
}
