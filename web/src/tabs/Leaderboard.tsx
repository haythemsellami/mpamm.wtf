import { useMemo } from 'react';
import type { LeaderboardGrouping } from '@shared';
import { useDashboard, LB_WIN_DAYS } from '../store';
import { C, SEM, venueColor } from '../theme';
import { Pills, SideTag } from '../components/ui';
import { fmtUsd, fmtAmt, fmtInt, pnlFmt, sparkPath, humanAge, shortHex } from '../lib/format';

const HZ_IDX: Record<string, number> = { 'T+0S': 0, 'T+10S': 2, 'T+30S': 3, 'T+60S': 4 };
const GROUP_ID: Record<string, LeaderboardGrouping> = {
  PROTOCOL: 'protocol', POOL: 'pool', 'TO ADDRESS': 'to', CATEGORY: 'category',
};

// CATEGORY colour (DCLogic.catCol) from stable semantic/theme tokens (never a
// venue color). UNKNOWN is highlighted because attribution was unavailable.
function catCol(c: string, router?: string): string {
  if (c === 'MEV') return C.accent2;
  if (router) return C.accent;
  return c === 'UNKNOWN' || c === 'ROUTER' ? C.amber : c === 'CEX/DEX' ? C.link : c === 'AGG' ? C.accent : C.faint2;
}
// display label for a fill category — DIRECT renders as the em-dash; attributed
// flow carries the intermediary's brand ("Router - Relay", "MEV - FastLane").
function catLabel(c: string, router?: string): string {
  if (router) return `${c === 'MEV' ? 'MEV' : 'Router'} - ${router}`;
  return c === 'DIRECT' ? '—' : c;
}

// grid templates lifted verbatim from the design (source of truth for pixels).
const LB_GRID = '34px 1.7fr 96px 64px 58px 58px 58px 58px 58px 1.5fr';
const TOP_GRID = '30px 76px 64px 82px 1.3fr 64px 88px 46px 1fr 1fr 76px 56px 80px';

export function LeaderboardTab() {
  const d = useDashboard();
  const { lb, lbWin, lbGroup, lbHz, lbMk, lbWinners, lbTop, venuesById } = d;

  const hzIdx = HZ_IDX[lbHz] ?? 0;
  const sign = lbMk === 'MAKER' ? -1 : 1;

  // Aggregates come from /api/leaderboard, computed server-side over the FULL
  // window (the old in-browser aggregation silently truncated 7D/30D at the
  // fills fetch cap). The response is TAKER-signed; MAKER is a pure sign flip:
  // pX' = −p(100−X), pnl' = −pnl, spark' = −spark. Only render a response that
  // matches the selected window (a stale one would mislabel the table).
  const current = lb && lb.days === (LB_WIN_DAYS[lbWin] ?? 1) ? lb : null;

  // PROTOCOL_LEADERBOARD rows — top groups by volume at the selected horizon.
  // PROTOCOL groups by the stable Fill.venueId; the row label + color resolve
  // from the registry (venuesById), so nothing about a venue is hardcoded.
  const lbRows = useMemo(() => {
    const rows = current?.groups[GROUP_ID[lbGroup] ?? 'protocol']?.[String(hzIdx)] ?? [];
    const labelFor = (k: string): string =>
      lbGroup === 'PROTOCOL' ? (venuesById[k]?.name ?? k)
        : lbGroup === 'CATEGORY' && k === 'direct' ? '—' : k;
    const colorFor = (k: string): string =>
      lbGroup === 'PROTOCOL' ? venueColor(venuesById[k], d.theme)
        : lbGroup === 'CATEGORY' ? catCol(k === 'direct' ? '—' : k)
          : C.accent;
    return rows.map((r) => ({
      name: labelFor(r.key), color: colorFor(r.key), vol: r.vol, swaps: r.swaps,
      ...(sign === 1
        ? { p5: r.p5, p25: r.p25, p50: r.p50, p75: r.p75, p95: r.p95, pnl: r.pnl, sp: r.spark }
        : { p5: -r.p95, p25: -r.p75, p50: -r.p50, p75: -r.p25, p95: -r.p5, pnl: -r.pnl, sp: r.spark.map((v) => -v) }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, lbGroup, hzIdx, sign, d.theme, venuesById]);

  // TOP_SWAPS rows — biggest single-swap winners/losers. Under the MAKER sign
  // flip the server's loser list IS the maker-winner list (and vice versa), in
  // the right order already.
  const topRows = useMemo(() => {
    const lists = current?.topSwaps[String(hzIdx)];
    const list = (lbWinners === (sign === 1) ? lists?.winners : lists?.losers) ?? [];
    return list
      .filter((f) => f.markoutsBps[hzIdx] != null)
      .map((f) => {
        const mk = sign * (f.markoutsBps[hzIdx] as number);
        return { f, mk, pnl: mk / 1e4 * f.usd };
      })
      .slice(0, lbTop);
  }, [current, hzIdx, sign, lbWinners, lbTop]);

  // percentile cell — '+'/'' + toFixed(2), green > 0.02 / red < -0.02 / dim.
  const pcell = (v: number) => ({
    txt: (v >= 0 ? '+' : '') + v.toFixed(2),
    color: v > 0.02 ? C.green : v < -0.02 ? C.red : C.dim,
  });

  const groupLbl = lbGroup.toLowerCase();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '18px 18px 12px' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>MARKOUT LEADERBOARD</div>
          <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 760 }}>
            Percentile distribution of markouts and the biggest single-swap winners / losers, per group, over the selected window. Markouts vs each pair's CEX BBO mid (Bybit for MON, Binance for BTC/ETH); pool PnL = Σ(markout_bps × size_usd / 10000).
          </div>
        </div>
        <Pills options={['24H', '7D', '30D']} value={lbWin} onChange={(v) => d.set('lbWin', v)} sm />
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '2px 18px 16px', fontSize: 9, color: C.faint2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>GROUP BY</span>
          <Pills options={['PROTOCOL', 'POOL', 'TO ADDRESS', 'CATEGORY']} value={lbGroup} onChange={(v) => d.set('lbGroup', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>HORIZON</span>
          <Pills options={['T+0S', 'T+10S', 'T+30S', 'T+60S']} value={lbHz} onChange={(v) => d.set('lbHz', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>MARKOUTS</span>
          <Pills options={['TAKER', 'MAKER']} value={lbMk} onChange={(v) => d.set('lbMk', v)} sm />
        </div>
        <button type="button" onClick={() => d.resetLb()} style={{
          marginLeft: 'auto', padding: '3px 9px', border: '1px solid var(--pill-border)', borderRadius: 4,
          cursor: 'pointer', fontSize: 10, color: C.dim2,
        }}>RESET FILTERS</button>
      </div>

      {/* PROTOCOL_LEADERBOARD */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>$</span>{' '}
          <span style={{ color: C.text, fontWeight: 600 }}>LEADERBOARD_{lbWin}</span>{' '}
          <span style={{ color: C.faint }}>grouped by {groupLbl} · markout {lbHz}</span>
        </div>
        <div style={{ padding: '4px 14px 12px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: LB_GRID, gap: '0 8px', padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}`, minWidth: 980 }}>
            <div>#</div><div>{lbGroup}</div>
            <div style={{ textAlign: 'right' }}>VOLUME</div><div style={{ textAlign: 'right' }}>SWAPS</div>
            <div style={{ textAlign: 'right' }}>P5</div><div style={{ textAlign: 'right' }}>P25</div><div style={{ textAlign: 'right' }}>P50</div>
            <div style={{ textAlign: 'right' }}>P75</div><div style={{ textAlign: 'right' }}>P95</div><div style={{ textAlign: 'right' }}>POOL PNL</div>
          </div>
          {lbRows.map((g, i) => {
            const cells = [g.p5, g.p25, g.p50, g.p75, g.p95].map(pcell);
            return (
              <div key={g.name + i} style={{ display: 'grid', gridTemplateColumns: LB_GRID, gap: '0 8px', padding: '11px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center', minWidth: 980 }}>
                <div style={{ color: C.faint2 }}>{String(i + 1).padStart(2, '0')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: g.color, flex: 'none' }} />
                  <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                </div>
                <div style={{ textAlign: 'right', color: C.text }}>{fmtUsd(g.vol)}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{fmtInt(g.swaps)}</div>
                {cells.map((c, k) => (
                  <div key={k} style={{ textAlign: 'right', color: c.color }}>{c.txt}</div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                  <span style={{ color: g.pnl >= 0 ? C.green : C.red, fontWeight: 600 }}>{pnlFmt(g.pnl)}</span>
                  <svg width="130" height="26" viewBox="0 0 130 26" preserveAspectRatio="none" style={{ flex: 'none' }}>
                    {/* resolved rgb (not var()) so it's valid as an SVG stroke attribute */}
                    <path d={sparkPath(g.sp, 130, 26)} fill="none" stroke={g.pnl >= 0 ? SEM[d.theme].green.css : SEM[d.theme].red.css} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                  </svg>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* TOP_SWAPS */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '9px 12px', borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>−</span>{' '}
            <span style={{ color: C.text, fontWeight: 600 }}>TOP_SWAPS_BY_MARKOUT_USD</span>{' '}
            <span style={{ color: C.faint }}>{lbHz} markout · {lbWin} window</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ display: 'flex', gap: 3 }}>
              <button type="button" aria-pressed={lbWinners} onClick={() => d.set('lbWinners', true)} style={wlBtn(lbWinners, SEM[d.theme].green)}>WINNERS</button>
              <button type="button" aria-pressed={!lbWinners} onClick={() => d.set('lbWinners', false)} style={wlBtn(!lbWinners, SEM[d.theme].red)}>LOSERS</button>
            </div>
            <Pills
              options={[{ label: 'TOP 10', value: 10 }, { label: 'TOP 25', value: 25 }, { label: 'TOP 50', value: 50 }]}
              value={lbTop} onChange={(v) => d.set('lbTop', v)} sm
            />
          </div>
        </div>
        <div style={{ padding: '0 14px 12px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: TOP_GRID, gap: '0 8px', padding: '9px 6px', fontSize: 8.5, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}`, minWidth: 1140 }}>
            <div>#</div><div>BLOCK</div><div>AGE</div><div>TX</div><div>TO</div><div>CATEGORY</div><div>POOL</div><div>SIDE</div>
            <div style={{ textAlign: 'right' }}>IN</div><div style={{ textAlign: 'right' }}>OUT</div><div style={{ textAlign: 'right' }}>EXEC PX</div>
            <div style={{ textAlign: 'right' }}>MK BPS</div><div style={{ textAlign: 'right' }}>MK $</div>
          </div>
          {topRows.map((x, i) => {
            const f = x.f;
            const base = f.usd / f.execPx;
            const [baseSym, stable] = f.market.split('/');
            const buy = f.side.toLowerCase() === 'buy';
            const inAmt = buy ? fmtAmt(f.usd) + ' ' + stable : fmtAmt(base) + ' ' + baseSym;
            const outAmt = buy ? fmtAmt(base) + ' ' + baseSym : fmtAmt(f.usd) + ' ' + stable;
            return (
              <a
                key={f.id}
                href={`https://monadscan.com/tx/${f.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                title={f.txHash}
                className="tx-row"
                style={{ display: 'grid', gridTemplateColumns: TOP_GRID, gap: '0 8px', padding: '8px 6px', fontSize: 10.5, borderBottom: `1px solid ${C.hair}`, alignItems: 'center', minWidth: 1140 }}
              >
                <div style={{ color: C.faint2 }}>{String(i + 1).padStart(2, '0')}</div>
                <div style={{ color: C.dim3 }}>{fmtInt(f.blockNumber)}</div>
                <div style={{ color: C.faint2 }}>{humanAge((Date.now() - f.ts) / 1000)}</div>
                <div style={{ color: C.link }}>{shortHex(f.txHash)}</div>
                <div style={{ color: C.dim3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.to}</div>
                <div style={{ color: catCol(f.category, f.router), fontSize: 9 }}>{catLabel(f.category, f.router)}</div>
                <div style={{ color: C.faint2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.pool}</div>
                <div><SideTag side={f.side} /></div>
                <div style={{ textAlign: 'right', color: C.dim }}>{inAmt}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{outAmt}</div>
                <div style={{ textAlign: 'right', color: C.text2 }}>{f.execPx.toFixed(5)}</div>
                <div style={{ textAlign: 'right', color: x.mk >= 0 ? C.green : C.red }}>{(x.mk >= 0 ? '+' : '') + x.mk.toFixed(2)}</div>
                <div style={{ textAlign: 'right', color: x.pnl >= 0 ? C.green : C.red, fontWeight: 600 }}>{pnlFmt(x.pnl)}</div>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// WINNERS/LOSERS toggle button (DCLogic.wlBtn) — themed via SEM (rgb for the
// translucent border/bg, css for the text).
function wlBtn(active: boolean, sem: { css: string; rgb: string }): React.CSSProperties {
  return {
    padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 10,
    border: `1px solid ${active ? `rgba(${sem.rgb},.53)` : 'var(--pill-border)'}`,
    background: active ? `rgba(${sem.rgb},.13)` : 'transparent',
    color: active ? sem.css : C.dim2,
  };
}
