import { useEffect, useMemo, useRef } from 'react';
import { SIZES_USD, TOKENS, pairOf, wrapBasisFor, type VenueMeta, type QuoteRow } from '@shared';
import { useDashboard } from '../store';
import { useViewport } from '../lib/viewport';
import { C, hexA, pill, venueColor } from '../theme';
import { Panel, PanelHead, Field } from '../components/ui';
import { QuoteCanvas } from '../components/QuoteCanvas';
import { sgn, sizeLabel, percentile, stdev } from '../lib/format';

const AX = 22; // bps axis half-range for the depth ladder
const DEFAULT_MARKETS = ['MON/USDC', 'BTC/USDC', 'ETH/USDC'];

export function ExecutionTab() {
  const d = useDashboard();
  const { mobile } = useViewport();
  // mobile control style — pill rows become compact native selects (pamm.wtf
  // pattern): 7 asset pills never fit a phone row, a select always does.
  const selStyle: React.CSSProperties = {
    background: 'transparent', color: C.text, border: '1px solid var(--pill-border)',
    borderRadius: 4, padding: '7px 8px', fontSize: 12, fontFamily: 'inherit',
  };
  const pair = d.pair, size = d.size;
  const realtime = d.state?.realtime;
  const frameTelemetry = d.quotes?.frame;
  const slowestAdapters = frameTelemetry
    ? Object.entries(frameTelemetry.adapterMs).sort((a, b) => b[1] - a[1]).slice(0, 3)
    : [];
  const allMarkets = d.state?.markets ?? DEFAULT_MARKETS;
  // markets a display venue has EVER quoted this session — STICKY, so a momentary
  // gap in a WS frame (a CEX feed blip) can't hide a market or bounce the pair.
  const seenMarkets = useRef<Set<string>>(new Set());
  const markets = useMemo(() => {
    if (d.quotes) {
      const venueIds = new Set(d.displayVenues.map((v) => v.id));
      for (const r of d.quotes.rows) if (venueIds.has(r.venueId) && (r.bidPx > 0 || r.askPx > 0)) seenMarkets.current.add(r.market);
    }
    const list = allMarkets.filter((m) => seenMarkets.current.has(m));
    return list.length ? list : allMarkets;
  }, [allMarkets, d.quotes, d.displayVenues]);
  useEffect(() => {
    // only revert when the pair isn't a registered market at all — never on a blip.
    if (allMarkets.length && !allMarkets.includes(pair)) d.set('pair', markets[0] ?? allMarkets[0]);
  }, [allMarkets, markets, pair, d]);
  // the CEX benchmark for the SELECTED pair — routed by base asset (Bybit for MON,
  // Binance for BTC/ETH). The prose explains it's walked as a taker (book + fee).
  const ref = d.referenceFor(pair);
  // venues that actually quote the SELECTED pair — sticky per session (like
  // seenMarkets above) so a transient quote gap can't pop chips in/out.
  const seenVenuePairs = useRef(new Set<string>());
  useMemo(() => {
    if (!d.quotes) return;
    for (const r of d.quotes.rows) if (r.bidPx > 0 || r.askPx > 0) seenVenuePairs.current.add(`${r.venueId}|${r.market}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes]);
  const pairVenues = d.displayVenues.filter((v) => seenVenuePairs.current.has(`${v.id}|${pair}`));
  // toggle chips: the propAMM venues that support this pair + any BASELINE that
  // quotes it (the standard-DEX band — only pairs with a live, sane Uniswap
  // pool ever emit rows, so illiquid/poolless pairs never grow the chip) + the
  // pair's CEX reference. (Before the first quote tick, fall back to all
  // venues so the row isn't empty.)
  const shown = pairVenues.length ? pairVenues : d.displayVenues;
  const pairBaselines = d.baselines.filter((v) => seenVenuePairs.current.has(`${v.id}|${pair}`));
  const chips: VenueMeta[] = [...shown, ...pairBaselines, ...(ref ? [ref] : [])];
  // active = chips the user has enabled (all registry venues default on).
  const active = chips.filter((v) => d.venueToggles[v.id]);
  const refName = ref?.name ?? 'the CEX reference';
  const refLabel = ref ? ref.name : 'The reference';
  // taker fee shown = the selected pair's CEX row fee (Bybit ~10bps, Binance VIP9 ~2.25bps).
  const taker = (d.quotes?.rows.find((r) => r.venueId === ref?.id && r.market === pair)?.feeBps ?? d.state?.takerBps ?? 4.5).toFixed(1);

  const row = (v: VenueMeta, s: number): QuoteRow | undefined =>
    d.quotes?.rows.find((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === s);

  // baseline label = venue name + the ACTUAL pool tier used for this pair
  // (the adapter reports the pool's fee in QuoteRow.feeBps: 5 → "0.05%").
  const displayName = (v: VenueMeta): string => {
    if (v.role !== 'baseline') return v.name;
    const r = d.quotes?.rows.find((x) => x.venueId === v.id && x.market === pair);
    return r ? `${v.name} · ${(r.feeBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : v.name;
  };

  // legend — active venues at selected pair/size, sorted by spread
  const legend = useMemo(() => {
    const leg = active.map((v) => {
      const r = row(v, size);
      return {
        id: v.id, name: displayName(v), color: venueColor(v, d.theme), baseline: v.role === 'baseline',
        spread: r?.spreadBps ?? 0, bid: r?.bidBps ?? 0, ask: r?.askBps ?? 0,
        // realized buy-MON cost vs the reference-as-taker, + = on-chain worse (docs/architecture.md: fill stream)
        vsCex: r?.cexAskBps, has: !!r,
        // a one-sided quote has only one executable side (the other is thin/backstop);
        // a partial quote (filledFull=false) exhausts before the full notional.
        oneSided: !!r?.oneSided, hasBid: (r?.bidPx ?? 0) > 0, hasAsk: (r?.askPx ?? 0) > 0,
        full: r?.filledFull ?? true,
      };
    }).filter((x) => x.has);
    // executable full-size two-sided rows first (by spread), then partial, then one-sided
    const rank = (x: { oneSided: boolean; full: boolean }) => (x.oneSided ? 2 : !x.full ? 1 : 0);
    leg.sort((a, b) => rank(a) - rank(b) || a.spread - b.spread);
    return leg;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);
  // tightest = tightest genuinely-executable quote (full-size + two-sided), by
  // id — baselines are a comparison overlay, never ★-eligible.
  const tight = legend.find((x) => !x.oneSided && x.full && !x.baseline)?.id;

  // depth ladder — per size, per venue bar widths
  const depth = useMemo(() => SIZES_USD.map((sz) => {
    const segsBid: { w: number; color: string; full: boolean }[] = [];
    const segsAsk: { w: number; color: string; full: boolean }[] = [];
    for (const v of active) {
      const r = row(v, sz);
      if (!r) continue;
      const wb = Math.min(50, Math.abs(Math.min(0, r.bidBps)) / AX * 50);
      const wa = Math.min(50, Math.max(0, r.askBps) / AX * 50);
      const color = venueColor(v, d.theme);
      // dim a venue's bar at a size it can't fill fully (filledFull=false)
      segsBid.push({ w: wb, color, full: r.filledFull });
      segsAsk.push({ w: wa, color, full: r.filledFull });
    }
    segsBid.sort((a, b) => b.w - a.w); segsAsk.sort((a, b) => b.w - a.w);
    return { label: sizeLabel(sz), highlight: sz === size, segsBid, segsAsk };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);

  // rolling stats — percentiles of the spread sample buffer per venue
  const stats = useMemo(() => {
    const rows = active.map((v) => {
      const a = d.samples[v.id] ?? [];
      return {
        id: v.id, name: displayName(v), color: venueColor(v, d.theme), baseline: v.role === 'baseline',
        p5: percentile(a, .05), p25: percentile(a, .25), p50: percentile(a, .5),
        p75: percentile(a, .75), p95: percentile(a, .95),
        avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, sd: stdev(a), n: a.length,
      };
    });
    const eligible = rows.filter((r) => !r.baseline && r.n > 0);
    const tightest = eligible.length ? eligible.reduce((m, r) => (r.p50 < m.p50 ? r : m), eligible[0]).id : null;
    return { rows, tightest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.frame, d.venueToggles, d.venues, d.theme]);

  // hint: active propAMM venues without a selected-size quote should read as
  // unavailable/thin liquidity, not as a broken chart.
  const hint = useMemo(() => {
    const q = d.quotes; if (!q) return null;
    const notes = active.filter((v) => v.role === 'venue').map((v) => {
      if (q.rows.some((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === size)) return null;
      const at = SIZES_USD.filter((s) => q.rows.some((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === s));
      // a venue with NO quotes for the pair has no chip at all now (pair-filtered),
      // so the only note worth showing is the per-size gap on a supporting venue.
      return at.length
        ? `${v.name} quotes ${pair} at ${at.map(sizeLabel).join(' / ')}, not ${sizeLabel(size)}`
        : null;
    }).filter(Boolean);
    return notes.length ? notes.join(' · ') : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);

  // ⚠ unit-conversion notes for the selected pair (pamm.wtf-style): the CEX
  // reference is shown in the pair's OWN terms — wrapped basis + stable cross —
  // driven by the @shared registries, nothing hardcoded per pair.
  const basisNotes = useMemo(() => {
    const p = pairOf(pair);
    if (!p) return [];
    const notes: string[] = [];
    const wrapSym = wrapBasisFor(p); // per-pair: WBTC pairs adjust, cbBTC pairs are parity
    const baseSym = p.symbol.split('/')[0];
    if (wrapSym) notes.push(`${pair} trades a wrapped asset — the ${refName} reference is adjusted by the ${wrapSym} mid (wrapped/native basis, a proxy for the bridged asset), so the CEX line is shown in wrapped terms for a like-for-like comparison.`);
    else if (p.wrapBasisOverride === '') notes.push(`${pair} trades ${baseSym}, a wrapped asset with NO CEX basis market — the ${refName} reference assumes parity with native ${p.base} (${baseSym} is 1:1 mint/redeemable, typically sub-bp; there is no live basis feed to price it).`);
    if (p.quoteKind === 'asset') {
      notes.push(`${pair} is crypto-quoted — the reference is a SYNTHETIC cross: the ${p.base} leg's CEX book converted by the live ${p.quote}/USDT mid (two real markets, possibly on different exchanges), so bps compare like-for-like in ${p.quote} terms.`);
    } else {
      const crossSym = TOKENS[p.quote]?.usdtCross;
      if (crossSym) notes.push(`${pair} is quoted in ${p.quote} but the ${refName} book is USDT — the reference is converted by the live ${crossSym} mid (the ${p.quote}/USDT basis is real, ~±10bps), not a $1 peg.`);
    }
    return notes;
  }, [pair, refName]);

  return (
    <div>
      <div style={{ padding: '18px 18px 10px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em' }}>REALTIME EXECUTION COMPARISON</div>
        <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 880 }}>
          Last 60s of quotes for the selected pair at the chosen notional. Spreads are quoted vs the <span style={{ color: C.text3 }}>{refName}</span> reference BBO mid.{' '}
          <span style={{ color: C.text3 }}>{refLabel}</span> walks the live book for the requested size and overlays the configured taker fee ({taker} bps each side) — realized-vs-realized, the only honest comparison for size-sensitive flow.
        </div>
        {realtime && (
          <div title={slowestAdapters.length ? `Slowest adapters: ${slowestAdapters.map(([id, ms]) => `${id} ${ms.toFixed(1)}ms`).join(' · ')}` : undefined}
            style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 13px', marginTop: 9, fontSize: 9.5, letterSpacing: '.04em', color: C.dim2 }}>
            <span>HEAD <b style={{ color: C.text }}>{realtime.headBlock.toLocaleString()}</b></span>
            <span>FRAME <b style={{ color: C.text }}>{realtime.quoteBlock.toLocaleString()}</b></span>
            <span>LAG <b style={{ color: realtime.lagBlocks > 1 ? C.amber : C.green }}>{realtime.lagBlocks} blk</b></span>
            <span>COMPUTE <b style={{ color: realtime.frameMs >= 300 ? C.amber : C.text }}>{realtime.frameMs}ms</b></span>
            <span>HEAD→FRAME <b style={{ color: realtime.headToFrameMs >= 300 ? C.amber : C.text }}>{realtime.headToFrameMs}ms</b></span>
            <span>LOOP <b style={{ color: realtime.eventLoopLagMs >= 50 ? C.amber : C.text }}>{realtime.eventLoopLagMs.toFixed(1)}ms</b></span>
            <span>COVERAGE 60s <b style={{ color: realtime.coveragePct60s < 99 ? C.amber : C.green }}>{realtime.coveragePct60s.toFixed(1)}%</b></span>
            <span>SKIPPED 60s <b style={{ color: realtime.coalescedBlocks60s ? C.amber : C.text }}>{realtime.coalescedBlocks60s}</b></span>
            <span>SOURCE <b style={{ color: C.text }}>{realtime.headSource.toUpperCase()}</b></span>
            <span>WS <b style={{ color: realtime.wsStatus === 'connected' ? C.green : realtime.wsStatus === 'disabled' ? C.faint2 : C.amber }}>{realtime.wsStatus.toUpperCase()}</b></span>
            {!!frameTelemetry?.missingVenues.length && <span>MISSING <b style={{ color: C.amber }}>{frameTelemetry.missingVenues.join(', ')}</b></span>}
          </div>
        )}
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 14 : 22, flexWrap: 'wrap', padding: '6px 18px 16px' }}>
        <Field label="ASSET">
          {mobile ? (
            <select aria-label="Asset pair" value={pair} onChange={(e) => d.set('pair', e.target.value)} style={selStyle}>
              {markets.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {markets.map((p) => <button key={p} type="button" aria-pressed={pair === p} onClick={() => d.set('pair', p)} style={pill(pair === p)}>{p}</button>)}
            </div>
          )}
        </Field>
        <Field label="SIZE">
          {mobile ? (
            <select aria-label="Trade size" value={size} onChange={(e) => d.set('size', Number(e.target.value))} style={selStyle}>
              {SIZES_USD.map((s) => <option key={s} value={s}>{sizeLabel(s)}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {SIZES_USD.map((s) => <button key={s} type="button" aria-pressed={size === s} onClick={() => d.set('size', s)} style={pill(size === s)}>{sizeLabel(s)}</button>)}
            </div>
          )}
        </Field>
        <div style={{ marginLeft: mobile ? 0 : 'auto' }}>
          <Field label="VENUES">
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {chips.map((v) => {
                const on = d.venueToggles[v.id];
                const color = venueColor(v, d.theme);
                const label = displayName(v).toUpperCase();
                return (
                  <button key={v.id} type="button" aria-pressed={!!on} onClick={() => d.toggleVenue(v.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 4, cursor: 'pointer',
                    fontSize: 11, whiteSpace: 'nowrap',
                    border: `1px solid ${on ? hexA(color, 0.5) : 'var(--pill-border)'}`,
                    color: on ? C.text : C.faint2, background: on ? hexA(color, 0.12) : 'transparent',
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? color : C.ghost }} />
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </div>

      {/* QUOTE */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="~" title="QUOTE" sub={`${pair} · ${sizeLabel(size)} · last 60s`}
          right={<div style={{ fontSize: 9, color: C.faint2 }}>solid = ask · dashed = bid · ★ = tightest · vs CEX = realized buy vs {refName} (+ = worse)</div>} />
        {/* flex row: the plot ends where the legend column begins, so quotes can
            never render underneath it (no absolute overlay). The canvas re-measures
            its own clientWidth each repaint, so it adapts to the narrower slot. */}
        <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'flex-start', padding: '8px 8px 4px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <QuoteCanvas />
          </div>
          {/* width/vs-CEX column is our approved divergence; venue names come
              straight from the registry. Layout matches the design. */}
          <div style={{ flex: 'none', width: mobile ? 'auto' : 382, margin: mobile ? '10px 4px 4px' : '6px 8px 0 14px', background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 42px 50px', gap: '2px 6px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
              <div>VENUE</div><div style={{ textAlign: 'right' }}>SPREAD</div><div style={{ textAlign: 'right' }}>BID</div><div style={{ textAlign: 'right' }}>ASK</div><div style={{ textAlign: 'right' }}>vs CEX</div>
            </div>
            {legend.map((r) => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 42px 50px', gap: '2px 6px', fontSize: 11, padding: '4px 0', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                  <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
                  {/* keep the venue cell on ONE line so the numeric cells stay aligned across rows
                      (a wrapped name grows the row and drops the numbers below the name's baseline).
                      one-sided venues need no badge — the n/a bid/ask already shows it. */}
                  {!r.full
                    ? <span title="liquidity exhausts before the full notional — the price shown is for a partial fill, not executable at the full size" style={{ flex: 'none', fontSize: 7.5, color: C.amber, border: `1px solid color-mix(in srgb, var(--amber) 45%, transparent)`, borderRadius: 3, padding: '0 3px', letterSpacing: '.04em' }}>PARTIAL</span>
                    : r.id === tight
                      ? <span style={{ flex: 'none', fontSize: 9, color: C.green }}>★</span>
                      : null}
                </div>
                <div style={{ textAlign: 'right', color: r.oneSided || !r.full ? C.faint2 : r.id === tight ? C.green : C.text, fontWeight: 600 }}>{r.oneSided ? '—' : r.spread.toFixed(2)}</div>
                <div style={{ textAlign: 'right', color: r.hasBid ? C.red : C.faint2 }}>{r.hasBid ? sgn(r.bid) : 'n/a'}</div>
                <div style={{ textAlign: 'right', color: r.hasAsk ? C.green : C.faint2 }}>{r.hasAsk ? sgn(r.ask) : 'n/a'}</div>
                <div style={{ textAlign: 'right', color: r.vsCex == null ? C.faint2 : r.vsCex > 0.05 ? C.red : r.vsCex < -0.05 ? C.green : C.dim, fontWeight: 600 }}>
                  {r.vsCex == null ? '—' : sgn(r.vsCex)}
                </div>
              </div>
            ))}
          </div>
        </div>
        {hint && (
          <div style={{ padding: '0 14px 10px', fontSize: 9.5, color: C.faint2, lineHeight: 1.5 }}>
            ⓘ {hint}
          </div>
        )}
        {basisNotes.map((n, i) => (
          <div key={i} style={{ padding: '0 14px 10px', fontSize: 9.5, color: C.amber, lineHeight: 1.5 }}>
            ⚠ {n}
          </div>
        ))}
      </Panel>

      {/* BID_ASK_DEPTH */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="≡" title="BID_ASK_DEPTH" sub={`${pair} · spread vs ${refName} mid (bps) by trade size`} />
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ display: 'flex', paddingLeft: 64, marginBottom: 10 }}>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>BIDS — below mid</div>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>ASKS — above mid</div>
          </div>
          {depth.map((rowd) => (
            <div key={rowd.label} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, background: rowd.highlight ? 'var(--accent-row)' : undefined }}>
              <div style={{ width: 54, textAlign: 'right', fontSize: 11, color: C.dim }}>{rowd.label}</div>
              <div style={{ position: 'relative', flex: 1, height: 20 }}>
                <div style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1, background: 'var(--green-line)', zIndex: 5 }} />
                {rowd.segsBid.map((s, i) => <div key={'b' + i} style={{ position: 'absolute', top: 2, height: 16, right: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, s.full ? 0.9 : 0.32), borderRadius: '2px 0 0 2px' }} />)}
                {rowd.segsAsk.map((s, i) => <div key={'a' + i} style={{ position: 'absolute', top: 2, height: 16, left: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, s.full ? 0.9 : 0.32), borderRadius: '0 2px 2px 0' }} />)}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <div style={{ width: 54 }} />
            <div style={{ position: 'relative', flex: 1, height: 16 }}>
              {[-20, -15, -10, -5, 0, 5, 10, 15, 20].map((t) => (
                <div key={t} style={{ position: 'absolute', top: 0, left: `${50 + t / AX * 50}%`, transform: 'translateX(-50%)', fontSize: 8.5, color: t === 0 ? C.green : C.faint2 }}>{(t > 0 ? '+' : '') + t}</div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* ROLLING_STATS */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="#" title="ROLLING_STATS" sub={`last 5m · spread distribution by venue · ${sizeLabel(size)} · ${pair}`} />
        <div style={{ padding: '6px 14px 12px', overflowX: 'auto' }}>
          <div style={{ minWidth: 620 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(7, 1fr) 0.8fr', gap: 6, padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}` }}>
            <div>VENUE</div><div style={{ textAlign: 'right' }}>P5</div><div style={{ textAlign: 'right' }}>P25</div><div style={{ textAlign: 'right' }}>P50</div><div style={{ textAlign: 'right' }}>P75</div><div style={{ textAlign: 'right' }}>P95</div><div style={{ textAlign: 'right' }}>AVG</div><div style={{ textAlign: 'right' }}>σ</div><div style={{ textAlign: 'right' }}>N</div>
          </div>
          {stats.rows.map((r) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(7, 1fr) 0.8fr', gap: 6, padding: '8px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
                {r.id === stats.tightest ? <span style={{ flex: 'none', fontSize: 9, color: C.green }}>★</span> : null}
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p5.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p25.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: r.id === stats.tightest ? C.green : C.text, fontWeight: 600 }}>{r.p50.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p75.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p95.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.avg.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.sd.toFixed(4)}</div>
              <div style={{ textAlign: 'right', color: C.faint2 }}>{r.n}</div>
            </div>
          ))}
          <div style={{ fontSize: 9, color: C.faint3, marginTop: 9 }}>p50 = median round-trip spread (bps, bid/ask vs the {refName} mid) · σ = spread stdev · ★ = tightest p50 in window</div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
