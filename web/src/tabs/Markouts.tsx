import { useEffect, useMemo, useRef, useState } from 'react';
import type { Fill } from '@shared';
import { useDashboard } from '../store';
import { C, venueColor } from '../theme';
import { Pills, SideTag } from '../components/ui';
import { fmtUsd, clockMs, clockSec, fmtInt, shortHex } from '../lib/format';

const H = [0, 5, 10, 30, 60];
const TAPE_GRID = '78px 78px 84px 84px 64px 92px 80px 88px 46px 80px 80px 52px 52px 52px 52px 52px';
const OUT_GRID = '78px 82px 92px 84px 84px 46px 88px 88px 84px 96px 1fr 1fr';

// CATEGORY colour — a fill's routing class, coloured from stable semantic/theme
// tokens (never a venue color): UNKNOWN/unbranded ROUTER→amber (attribution
// unavailable), branded router/AGG→accent (identified flow), CEX/DEX→link,
// DIRECT→faint.
function catColor(c: string, router?: string): string {
  if (router) return C.accent;
  return c === 'UNKNOWN' || c === 'ROUTER' ? C.amber : c === 'CEX/DEX' ? C.link : c === 'AGG' ? C.accent : C.faint2;
}
/** category display — DIRECT renders as an em dash; attributed routed flow
 *  carries the intermediary's brand ("Router - Relay"). */
function catLabel(c: string, router?: string): string {
  if (router) return `Router - ${router}`;
  return c === 'DIRECT' ? '—' : c;
}

export function MarkoutsTab() {
  const d = useDashboard();
  const { venuesById, displayVenues, references } = d;

  // venue display name + colour, resolved from the registry by Fill.venueId.
  const venueName = (f: Fill): string => venuesById[f.venueId]?.name ?? f.venueId;
  const venueNameUpper = (f: Fill): string => venueName(f).toUpperCase();
  // markouts are routed PER PAIR (Bybit for MON, Binance for BTC/ETH), so the
  // prose names every reference rather than mislabeling the whole tab as one CEX.
  const refNames = references.length ? references.map((r) => r.name).join(' / ') : 'the CEX reference';

  // local 1s tick so age-based markout reveal advances even when no new fills land.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // filtered + sorted tape (DCLogic mkVals flt), newest first, top 52.
  const tape = useMemo(() => {
    const flt = (f: Fill): boolean => {
      if (d.mkSide === 'BUYS' && f.side !== 'buy') return false;
      if (d.mkSide === 'SELLS' && f.side !== 'sell') return false;
      if (d.mkProto !== 'ALL' && venueNameUpper(f) !== d.mkProto) return false;
      if (d.mkSize === '≥10K' && f.usd < 10000) return false;
      if (d.mkSize === '≥100K' && f.usd < 100000) return false;
      if (d.mkSize === '≥500K' && f.usd < 500000) return false;
      return true;
    };
    return d.fills.filter(flt).sort((a, b) => b.ts - a.ts).slice(0, 52);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.fills, d.mkSide, d.mkProto, d.mkSize, venuesById]);

  // freeze the displayed tape while paused: snapshot the rows when pause flips on.
  const frozenRef = useRef<Fill[] | null>(null);
  if (d.mkPaused) {
    if (frozenRef.current === null) frozenRef.current = tape;
  } else if (frozenRef.current !== null) {
    frozenRef.current = null;
  }
  const rows = d.mkPaused && frozenRef.current ? frozenRef.current : tape;

  // outlier feed — last 24h by |mk-0s P&L| desc, top 18. Only fills with a
  // realized markout (excludes pxApprox + not-yet-aged) — audit B1/C2.
  // Base = the SERVER's 24h aggregate (the full window; the in-memory buffer
  // only holds a recent slice), merged with the live-streamed fills so a fresh
  // outlier appears between polls. Live rows win on id (newer markouts).
  const outliers = useMemo(() => {
    const since = Date.now() - 86_400_000;
    const byId = new Map<string, Fill>();
    for (const f of d.lbDay?.outliers ?? []) byId.set(f.id, f);
    for (const f of d.fills) if (byId.has(f.id) || f.ts >= since) byId.set(f.id, f);
    return [...byId.values()]
      .filter((f) => f.ts >= since && !f.pxApprox && f.markoutsBps[0] != null)
      .map((f) => ({ f, pnl: ((f.markoutsBps[0] as number) / 1e4) * f.usd }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .slice(0, 18);
  }, [d.fills, d.lbDay]);

  return (
    <div>
      <div style={{ padding: '18px 18px 14px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>SWAP MARKOUTS</div>
        <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 880 }}>
          On-chain swaps joined to each pair's CEX reference BBO (<span style={{ color: C.text3 }}>{refNames}</span> — Bybit for MON, Binance for BTC/ETH) for markouts at 0 / 5 / 10 / 30 / 60 seconds.{' '}
          <span style={{ color: C.green }}>Positive bps</span> = the taker got a favorable fill vs the CEX reference; <span style={{ color: C.red }}>negative</span> = adverse. Later horizons fill in as each swap ages past them.
        </div>
      </div>

      {/* SWAP_TAPE */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', padding: '9px 12px', borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>&gt;</span>{' '}
            <span style={{ color: C.text, fontWeight: 600 }}>SWAP_TAPE</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Pills options={['ALL', ...displayVenues.map((v) => v.name.toUpperCase())]} value={d.mkProto} onChange={(v) => d.set('mkProto', v)} sm />
            <Pills options={['ALL', 'BUYS', 'SELLS']} value={d.mkSide} onChange={(v) => d.set('mkSide', v)} sm />
            <Pills options={['ANY', '≥10K', '≥100K', '≥500K']} value={d.mkSize} onChange={(v) => d.set('mkSize', v)} sm />
            <button
              type="button" aria-pressed={d.mkPaused}
              aria-label={d.mkPaused ? 'Resume the live tape' : 'Pause the live tape'}
              onClick={() => d.set('mkPaused', !d.mkPaused)}
              style={{
                padding: '3px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 10, userSelect: 'none', whiteSpace: 'nowrap',
                background: d.mkPaused ? 'var(--red-bg)' : 'transparent',
                border: `1px solid ${d.mkPaused ? 'var(--red-border)' : 'var(--pill-border)'}`,
                color: d.mkPaused ? C.red : C.dim2,
              }}
            >
              {d.mkPaused ? '▶ RESUME' : '⏸ PAUSE'}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: TAPE_GRID, gap: '0 6px', padding: '9px 14px', fontSize: 8.5, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}` }}>
          <div>TS UTC</div><div>BLOCK</div><div>TX</div><div>TO</div><div>CATEGORY</div><div>PROTOCOL</div><div>PAIR</div><div>POOL</div><div>SIDE</div>
          <div style={{ textAlign: 'right' }}>SIZE USD</div><div style={{ textAlign: 'right' }}>EXEC PX</div>
          <div style={{ textAlign: 'right' }}>MK-0S</div><div style={{ textAlign: 'right' }}>MK-5S</div><div style={{ textAlign: 'right' }}>MK-10S</div><div style={{ textAlign: 'right' }}>MK-30S</div><div style={{ textAlign: 'right' }}>MK-60S</div>
        </div>

        <div style={{ maxHeight: 454, overflowY: 'auto' }}>
          {rows.map((f) => {
            const dp = venueNameUpper(f);
            const age = (Date.now() - f.ts) / 1000;
            return (
              <a
                key={f.id}
                href={`https://monadscan.com/tx/${f.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                title={f.txHash}
                className="tx-row"
                style={{ display: 'grid', gridTemplateColumns: TAPE_GRID, gap: '0 6px', padding: '6px 14px', fontSize: 10.5, borderBottom: `1px solid ${C.hair}`, alignItems: 'center' }}
              >
                <div style={{ color: C.faint }}>{clockMs(f.ts)}</div>
                <div style={{ color: C.dim3 }}>{fmtInt(f.blockNumber)}</div>
                <div style={{ color: C.link }}>{shortHex(f.txHash)}</div>
                <div style={{ color: C.faint2 }}>{f.to}</div>
                <div style={{ color: catColor(f.category, f.router), fontSize: 9 }}>{catLabel(f.category, f.router)}</div>
                <div style={{ color: venueColor(venuesById[f.venueId], d.theme), fontWeight: 600 }}>{dp}</div>
                <div style={{ color: C.text2 }}>{f.market}</div>
                <div style={{ color: C.faint2 }}>{f.pool}</div>
                <div><SideTag side={f.side} /></div>
                <div style={{ textAlign: 'right', color: C.text }}>{fmtUsd(f.usd)}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{f.pxApprox ? '—' : f.execPx.toFixed(5)}</div>
                {H.map((h, i) => {
                  const v = f.markoutsBps[i];
                  if (age < h || v == null) return <div key={h} style={{ textAlign: 'right', color: C.ghost }}>{'·'}</div>;
                  return <div key={h} style={{ textAlign: 'right', color: v >= 0 ? C.green : C.red }}>{(v >= 0 ? '+' : '') + v.toFixed(2)}</div>;
                })}
              </a>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', borderTop: `1px solid ${C.line2}`, fontSize: 9, color: C.faint2 }}>
          <span>showing {rows.length} rows</span><span>last refresh {clockSec()}</span>
        </div>
      </div>

      {/* OUTLIER_FEED */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />

        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.red }}>!</span>{' '}
          <span style={{ color: C.text, fontWeight: 600 }}>OUTLIER_FEED</span>{' '}
          <span style={{ color: C.faint }}>sorted by |mk-0s P&amp;L| desc &middot; last 24h</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: OUT_GRID, gap: '0 8px', padding: '9px 14px', fontSize: 8.5, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}` }}>
          <div>WHEN</div><div>BLOCK</div><div>PROTOCOL</div><div>PAIR</div><div>POOL</div><div>SIDE</div>
          <div style={{ textAlign: 'right' }}>USD</div><div style={{ textAlign: 'right' }}>EXEC PX</div>
          <div style={{ textAlign: 'right' }}>MK-0S (BPS)</div><div style={{ textAlign: 'right' }}>MK-0S P&amp;L</div><div>TX</div><div>TO</div>
        </div>

        {outliers.map(({ f, pnl }) => {
          const mk0 = f.markoutsBps[0] ?? 0;
          return (
            <a
              key={f.id}
              href={`https://monadscan.com/tx/${f.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              title={f.txHash}
              className="tx-row"
              style={{ display: 'grid', gridTemplateColumns: OUT_GRID, gap: '0 8px', padding: '7px 14px', fontSize: 10.5, borderBottom: `1px solid ${C.hair}`, alignItems: 'center' }}
            >
              <div style={{ color: C.faint }}>{clockMs(f.ts).slice(0, 8)}</div>
              <div style={{ color: C.dim3 }}>{fmtInt(f.blockNumber)}</div>
              <div style={{ color: venueColor(venuesById[f.venueId], d.theme), fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{venueNameUpper(f)}</div>
              <div style={{ color: C.text2 }}>{f.market}</div>
              <div style={{ color: C.faint2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.pool}</div>
              <div><SideTag side={f.side} /></div>
              <div style={{ textAlign: 'right', color: C.text }}>{fmtUsd(f.usd)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{f.pxApprox ? '—' : f.execPx.toFixed(5)}</div>
              <div style={{ textAlign: 'right', color: mk0 >= 0 ? C.green : C.red }}>{(mk0 >= 0 ? '+' : '') + mk0.toFixed(2)}</div>
              <div style={{ textAlign: 'right', color: pnl >= 0 ? C.green : C.red, fontWeight: 600 }}>{(pnl >= 0 ? '+$' : '−$') + Math.abs(pnl).toFixed(2)}</div>
              <div style={{ color: C.link }}>{shortHex(f.txHash)}</div>
              <div style={{ color: C.faint2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.to}</div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
