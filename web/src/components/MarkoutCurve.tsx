import { useEffect, useMemo, useRef, useState } from 'react';
import { useDashboard, LB_WIN_DAYS } from '../store';
import { C, CH, venueColor } from '../theme';
import { Pills, FieldLegend } from './ui';
import { fmtUsd, fmtInt } from '../lib/format';
import { curveView, niceTicks, FLOW_OPTS, ROUTE_OPTS, MIN_CURVE_FILLS, type VenueCurve } from '../lib/curves';

/** Table columns (offset seconds) — the paper's reading points: the pre-fill
 *  leg, the fill, its 2s headline horizon, and the end of the window. */
const TABLE_OFFSETS = [-5, 0, 2, 15];
const GRID = '1.5fr 64px 86px 74px 62px 78px 62px 62px 62px 62px';

const FIELDS = [
  { term: 'curve', unit: 'bps', desc: 'notional-weighted mean MAKER markout vs the pair’s CEX reference, from 5s before to 15s after the fill. Positive = the pool is ahead of the reference at that moment.' },
  { term: 'FLOW', unit: '—', desc: 'QUIET = the reference moved under 1bp from 5s before to 1s after the fill (flow that arrived independently of the market: the retail proxy); MOVING = everything else.' },
  { term: 'ROUTE', unit: '—', desc: 'what else the transaction did on TRACKED venues: SINGLE = the only tracked leg; SPLIT = several legs, one direction; TWO-SIDED = bought on one leg and sold on another (the atomic-arbitrage shape). Legs on untracked DEXes are invisible, so SINGLE can still hide an arbitrage against an AMM.' },
  { term: 'ENTRY', unit: '—', desc: 'the fill’s routing category (DIRECT, ROUTER, AGG, MEV, UNKNOWN) — compare what each kind of counterparty is charged.' },
  { term: 'COVERAGE', unit: '%', desc: 'share of the venue’s notional in the window that has a complete curve. Curves are captured live, from the 100ms reference feed, once a fill ages past +15s — older fills and feed gaps have none, so wide windows fill in going forward.' },
  { term: 'QUIET / TWO-SIDED', unit: '% notional', desc: 'the venue’s flow mix over all its curve fills — independent of the filters.' },
] as const;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const fmtBps = (v: number | null) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2));
const bpsColor = (v: number | null) => (v == null ? C.faint2 : v > 0.02 ? C.green : v < -0.02 ? C.red : C.dim);
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export function MarkoutCurvePanel() {
  const d = useDashboard();
  const { curves, venuesById, displayVenues, lbWin } = d;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const current = curves && curves.days === (LB_WIN_DAYS[lbWin] ?? 1) ? curves : null;
  const view = useMemo(
    () => curveView(current, { flow: d.cvFlow, route: d.cvRoute, entry: d.cvEntry }, displayVenues.map((v) => v.id)),
    [current, d.cvFlow, d.cvRoute, d.cvEntry, displayVenues],
  );
  const name = (id: string) => (id === 'ALL' ? 'All venues' : venuesById[id]?.name ?? id);
  const plotted = view.venues.filter((v) => v.fills >= MIN_CURVE_FILLS);
  const pooled = view.pooled && view.pooled.fills >= MIN_CURVE_FILLS && plotted.length > 1 ? view.pooled : null;

  // ── geometry ──────────────────────────────────────────────────────────────
  const H = 240;
  const direct = width >= 560 && plotted.length <= 4;
  const m = { l: 44, r: direct ? 104 : 14, t: 18, b: 24 };
  const W = Math.max(width, 280);
  const offs = view.offsets;
  const x0 = offs[0] ?? -5, x1 = offs[offs.length - 1] ?? 15;
  const xs = (s: number) => m.l + ((s - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const series = [...plotted, ...(pooled ? [pooled] : [])];
  const vals = series.flatMap((v) => v.maker.filter((y): y is number => y != null));
  const ticks = niceTicks(vals.length ? Math.min(...vals) : -1, vals.length ? Math.max(...vals) : 1);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const ys = (v: number) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const pathOf = (v: VenueCurve) => {
    let dStr = '', pen = false;
    v.maker.forEach((y, i) => {
      if (y == null) { pen = false; return; }
      dStr += `${pen ? 'L' : 'M'}${xs(offs[i]).toFixed(1)},${ys(y).toFixed(1)}`;
      pen = true;
    });
    return dStr;
  };
  const colorOf = (v: VenueCurve) => (v.venueId === 'ALL' ? CH[d.theme].label : venueColor(venuesById[v.venueId], d.theme));

  // direct labels at the right edge, nudged apart (≥12px) so they never collide.
  const labels = useMemo(() => {
    if (!direct) return [];
    const last = (v: VenueCurve) => [...v.maker].reverse().find((y) => y != null) ?? 0;
    const rows = series.map((v) => ({ v, y: ys(last(v)) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < rows.length; i++) if (rows[i].y - rows[i - 1].y < 12) rows[i].y = rows[i - 1].y + 12;
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, series.map((v) => v.venueId + v.maker.join()).join('|'), W, y0, y1]);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!offs.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
    let best = 0;
    offs.forEach((o, i) => { if (Math.abs(o - sx) < Math.abs(offs[best] - sx)) best = i; });
    if (best !== hoverIdx) setHoverIdx(best);
  };

  const filterNote = [d.cvFlow, d.cvRoute, d.cvEntry].filter((v) => v !== 'ALL').join(' · ').toLowerCase();

  return (
    <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
      <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
      <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
      <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
        <span style={{ color: C.purple }}>~</span>{' '}
        <span style={{ color: C.text, fontWeight: 600 }}>MARKOUT_CURVE_{lbWin}</span>{' '}
        <span style={{ color: C.faint }}>maker bps · 5s before → 15s after the fill{filterNote ? ` · ${filterNote}` : ''}</span>
        <FieldLegend items={FIELDS} note={<>
          The shape that separates active from passive liquidity (Solmaz, Heimbach &amp; Milionis, <em>Active Liquidity On Chain</em>, 2026): a pool that only reprices on trades is <strong style={{ color: C.text3, fontWeight: 600 }}>ahead before the fill and behind after it</strong> — it was picked off. A venue that reprices as the reference moves shows the inverse: behind before the fill (the move it repriced into), ahead after.{' '}
          Monad block timestamps are whole seconds, so t = 0 is the middle of the fill&rsquo;s block second (±0.5s) — which is why 0s here can differ slightly from the table&rsquo;s T+0S.
        </>} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '10px 12px 4px', fontSize: 9, color: C.faint2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>FLOW</span>
          <Pills options={[...FLOW_OPTS]} value={d.cvFlow} onChange={(v) => d.set('cvFlow', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>ROUTE</span>
          <Pills options={[...ROUTE_OPTS]} value={d.cvRoute} onChange={(v) => d.set('cvRoute', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>ENTRY</span>
          <Pills options={['ALL', ...view.categories]} value={d.cvEntry} onChange={(v) => d.set('cvEntry', v)} sm />
        </div>
      </div>

      {/* legend — always present for ≥2 series (one series is named by its
          direct label); identity is never colour alone */}
      {(series.length > 1 || (series.length === 1 && !direct)) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '6px 12px 0', fontSize: 10, color: C.dim2 }}>
          {series.map((v) => (
            <span key={v.venueId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={colorOf(v)} strokeWidth={2} strokeDasharray={v.venueId === 'ALL' ? '4 3' : undefined} /></svg>
              {name(v.venueId)}
            </span>
          ))}
        </div>
      )}

      <div ref={boxRef} style={{ position: 'relative', padding: '4px 0 0' }} onMouseLeave={() => setHoverIdx(null)}>
        {!series.length ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px', textAlign: 'center', fontSize: 11, color: C.faint2 }}>
            {current ? 'No venue has enough fills with a complete curve under these filters yet. Curves are captured live once a fill ages past +15s, so a new window fills in going forward.' : 'Loading markout curves…'}
          </div>
        ) : width > 0 && (
          <svg width={W} height={H} role="img" aria-label="Maker markout curve per venue, 5 seconds before to 15 seconds after each fill" style={{ display: 'block', fontFamily: 'inherit' }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={W - m.r} y1={ys(t)} y2={ys(t)} stroke={t === 0 ? CH[d.theme].label2 : CH[d.theme].grid} strokeWidth={1} />
                <text x={m.l - 6} y={ys(t) + 3} textAnchor="end" fontSize={9} fill={CH[d.theme].label}>{(t > 0 ? '+' : '') + t}</text>
              </g>
            ))}
            {offs.filter((o) => o % 5 === 0 || o === 2).map((o) => (
              <text key={o} x={xs(o)} y={H - 8} textAnchor="middle" fontSize={9} fill={CH[d.theme].label}>{o === 0 ? '0s' : `${o > 0 ? '+' : ''}${o}s`}</text>
            ))}
            <line x1={xs(0)} x2={xs(0)} y1={m.t - 6} y2={H - m.b} stroke={CH[d.theme].label2} strokeDasharray="3 3" />
            <text x={xs(0) + 4} y={m.t - 8} fontSize={8.5} fill={CH[d.theme].label}>FILL</text>
            <line x1={xs(2)} x2={xs(2)} y1={m.t} y2={H - m.b} stroke={CH[d.theme].grid} strokeDasharray="1 3" />

            {series.map((v) => (
              <path key={v.venueId} d={pathOf(v)} fill="none" stroke={colorOf(v)} strokeWidth={2}
                strokeDasharray={v.venueId === 'ALL' ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
            ))}

            {labels.map(({ v, y }) => (
              <g key={v.venueId}>
                <line x1={W - m.r + 6} x2={W - m.r + 14} y1={y} y2={y} stroke={colorOf(v)} strokeWidth={2} />
                <text x={W - m.r + 18} y={y + 3} fontSize={9.5} style={{ fill: C.text2 }}>{name(v.venueId)}</text>
              </g>
            ))}

            {hoverIdx != null && (
              <g pointerEvents="none">
                <line x1={xs(offs[hoverIdx])} x2={xs(offs[hoverIdx])} y1={m.t} y2={H - m.b} stroke={CH[d.theme].label2} />
                {series.map((v) => v.maker[hoverIdx] != null && (
                  <circle key={v.venueId} cx={xs(offs[hoverIdx])} cy={ys(v.maker[hoverIdx] as number)} r={4}
                    fill={colorOf(v)} style={{ stroke: C.panel }} strokeWidth={2} />
                ))}
              </g>
            )}
            <rect x={m.l} y={0} width={Math.max(0, W - m.l - m.r)} height={H} fill="transparent" onMouseMove={onMove} />
          </svg>
        )}
        {hoverIdx != null && series.length > 0 && (
          <div style={{
            // beside the crosshair (never on it), on whichever side has room
            position: 'absolute', top: 8, left: xs(offs[hoverIdx]) + (xs(offs[hoverIdx]) < W / 2 ? 14 : -14),
            transform: xs(offs[hoverIdx]) < W / 2 ? undefined : 'translateX(-100%)',
            background: C.overlay, border: `1px solid ${C.line}`, padding: '7px 10px', zIndex: 10, pointerEvents: 'none', fontSize: 10.5, minWidth: 150,
          }}>
            <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.05em', paddingBottom: 4, borderBottom: `1px solid ${C.line2}`, marginBottom: 4 }}>
              {offs[hoverIdx] === 0 ? 'AT THE FILL' : `${Math.abs(offs[hoverIdx])}S ${offs[hoverIdx] < 0 ? 'BEFORE' : 'AFTER'} THE FILL`}
            </div>
            {[...series].sort((a, b) => (b.maker[hoverIdx] ?? -1e9) - (a.maker[hoverIdx] ?? -1e9)).map((v) => (
              <div key={v.venueId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(v), flex: 'none' }} />
                <span style={{ color: C.text2, flex: 1 }}>{name(v.venueId)}</span>
                <span style={{ color: C.text, fontWeight: 600 }}>{fmtBps(v.maker[hoverIdx])}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* table view — the same numbers, readable without the chart */}
      <div style={{ padding: '6px 14px 12px', overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 8px', padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}`, minWidth: 820 }}>
          <div>VENUE</div>
          <div style={{ textAlign: 'right' }}>FILLS</div><div style={{ textAlign: 'right' }}>VOLUME</div>
          <div style={{ textAlign: 'right' }}>COVERAGE</div><div style={{ textAlign: 'right' }}>QUIET</div><div style={{ textAlign: 'right' }}>TWO-SIDED</div>
          {TABLE_OFFSETS.map((o) => <div key={o} style={{ textAlign: 'right' }}>{o === 0 ? '0S' : `${o > 0 ? '+' : '−'}${Math.abs(o)}S`}</div>)}
        </div>
        {[...view.venues, ...(view.pooled ? [view.pooled] : [])].map((v) => {
          const thin = v.fills < MIN_CURVE_FILLS;
          return (
            <div key={v.venueId} style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 8px', padding: '9px 6px', fontSize: 11, borderBottom: `1px solid ${C.line3}`, alignItems: 'center', minWidth: 820, opacity: thin ? 0.55 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(v), flex: 'none' }} />
                <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: v.venueId === 'ALL' ? 600 : 400 }}>{name(v.venueId)}</span>
                {thin && <span style={{ fontSize: 9, color: C.faint2 }} title={`fewer than ${MIN_CURVE_FILLS} fills — not drawn`}>thin</span>}
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{fmtInt(v.fills)}</div>
              <div style={{ textAlign: 'right', color: C.text }}>{fmtUsd(v.usd)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{pct(v.coverage)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{pct(v.quietShare)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{pct(v.twoSidedShare)}</div>
              {TABLE_OFFSETS.map((o) => {
                const val = v.maker[offs.indexOf(o)] ?? null;
                return <div key={o} style={{ textAlign: 'right', color: bpsColor(val), fontWeight: o === 2 ? 600 : 400 }}>{fmtBps(val)}</div>;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
