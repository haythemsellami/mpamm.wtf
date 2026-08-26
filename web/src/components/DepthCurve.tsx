import { useMemo } from 'react';
import type { DepthSnapshot } from '@shared';
import { C, hexA } from '../theme';
import { useViewport } from '../lib/viewport';
import {
  DEPTH_AX_BPS, DEPTH_VIEW_H, DEPTH_VIEW_W, DEPTH_X_TICKS, DEPTH_Y_TICKS,
  depthLegPath, depthX, depthY,
} from '../lib/depth-curve';
import { sizeLabel } from '../lib/format';

/** Left gutter the y-axis labels live in (design: `margin-left:62px`). */
const GUTTER = 62;

/** An active venue, resolved to the exact label and colour the VENUES toggle
 *  row uses — so no venue is named or coloured two ways on one screen. */
export interface DepthVenue {
  id: string;
  label: string;
  color: string;
}

/** One rendered path: a venue's bid or ask leg. */
interface Leg {
  key: string;
  d: string;
  stroke: string;
}

/**
 * BID_ASK_DEPTH — executable spread (bps vs the pair's CEX mid) against trade
 * size, one line per venue per side.
 *
 * Both legs of a venue carry the SAME colour: which half of the plot a leg sits
 * in already says bid or ask, so spending hue on it would leave nothing to tell
 * venues apart. No fills either — filled areas between two venues' legs read as
 * a quantity, and the space between two spread curves is not one.
 */
export function DepthCurveChart({ snapshot, venues, refName }: {
  snapshot: DepthSnapshot | null;
  /** active venues, in the order the toggle row shows them. */
  venues: DepthVenue[];
  refName: string;
}) {
  const { mobile } = useViewport();
  // Legs and legend are derived from ONE pass over the active set, so a venue
  // can never own a chip without a line or a line without a chip.
  const { legs, legend } = useMemo(() => {
    const legs: Leg[] = [];
    const legend: DepthVenue[] = [];
    const curvesByVenue = new Map(snapshot?.venues.map((curve) => [curve.venueId, curve]) ?? []);
    for (const v of venues) {
      const curve = curvesByVenue.get(v.id);
      if (!curve) continue;
      const mine: Leg[] = [];
      for (const side of ['bid', 'ask'] as const) {
        const d = depthLegPath(curve, side);
        if (d) mine.push({ key: `${v.id}-${side}`, d, stroke: hexA(v.color, 0.92) });
      }
      if (!mine.length) continue; // nothing in frame — a chip for it would point at nothing
      legs.push(...mine);
      legend.push(v);
    }
    return { legs, legend };
  }, [snapshot, venues]);

  const pct = (n: number, span: number) => `${(n / span * 100).toFixed(3)}%`;
  const sideLabel = { fontSize: 9, color: C.faint2, letterSpacing: '.14em', flex: 'none' } as const;
  const chips = legend.map((v) => (
    <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text3 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: v.color, flex: 'none' }} />
      {v.label}
    </div>
  ));

  return (
    <div style={{ padding: mobile ? '14px 12px 10px' : '14px 20px 10px' }}>
      {/* One row on desktop, exactly as designed. On a phone the legend cannot
          share a row with BIDS/ASKS — eight chips wrap into eight lines and push
          the plot off-screen — so the labels drop onto their own row over the
          plot they annotate. */}
      {mobile ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px 14px', margin: '0 0 10px' }}>{chips}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', margin: `0 0 8px ${GUTTER}px` }}>
            <div style={sideLabel}>BIDS</div>
            <div style={sideLabel}>ASKS</div>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, margin: `0 0 12px ${GUTTER}px` }}>
          <div style={sideLabel}>BIDS</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flex: 1, flexWrap: 'wrap' }}>{chips}</div>
          <div style={sideLabel}>ASKS</div>
        </div>
      )}

      <div style={{ marginLeft: GUTTER }}>
        {/* Fixed user-space height: the plot never reflows as the panel resizes,
            it only stretches horizontally. */}
        <div style={{ position: 'relative', height: DEPTH_VIEW_H }}>
          {DEPTH_X_TICKS.filter((t) => t !== 0).map((t) => (
            <div key={t} style={{
              position: 'absolute', top: 0, bottom: 0, left: pct(depthX(t), DEPTH_VIEW_W), width: 1,
              background: `repeating-linear-gradient(to bottom, ${C.line} 0 2px, transparent 2px 6px)`,
            }} />
          ))}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(depthX(0), DEPTH_VIEW_W), width: 1, background: 'var(--green-line)' }} />
          {DEPTH_Y_TICKS.map((n) => (
            <div key={n} style={{
              position: 'absolute', right: 'calc(100% + 10px)', top: pct(depthY(n), DEPTH_VIEW_H),
              transform: 'translateY(-50%)', fontSize: 10, color: C.faint2, whiteSpace: 'nowrap',
            }}>{sizeLabel(n)}</div>
          ))}
          {/* Axis labels are HTML, never SVG <text>: preserveAspectRatio="none"
              shears anything drawn inside this viewBox. */}
          <svg
            viewBox={`0 0 ${DEPTH_VIEW_W} ${DEPTH_VIEW_H}`} preserveAspectRatio="none"
            role="img" aria-label={`Executable spread in bps versus ${refName} mid across trade size, per venue`}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
          >
            {legs.map((l) => (
              // non-scaling-stroke: the horizontal stretch would otherwise
              // thicken every line as the panel widens.
              <path key={l.key} d={l.d} fill="none" stroke={l.stroke} strokeWidth={1.6}
                strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {!legs.length && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: C.faint2, letterSpacing: '.04em',
            }}>
              {snapshot ? `no venue quotes ${snapshot.market} inside ±${DEPTH_AX_BPS} bps` : 'sampling depth…'}
            </div>
          )}
        </div>
        <div style={{ position: 'relative', height: 18, marginTop: 8 }}>
          {DEPTH_X_TICKS.map((t) => (
            <div key={t} style={{
              position: 'absolute', top: 0, left: pct(depthX(t), DEPTH_VIEW_W), transform: 'translateX(-50%)',
              fontSize: 9.5, color: t === 0 ? C.green : C.faint2,
            }}>{t === 0 ? '0' : (t > 0 ? '+' : '') + t}</div>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 9, color: C.faint3, margin: `2px 0 4px ${mobile ? 0 : GUTTER}px`, lineHeight: 1.5 }}>
        each leg = executable spread at that notional · a leg ends where the venue stops quoting size · x = bps vs {refName} mid, y = log notional
        {snapshot ? ` · sampled block ${snapshot.asOfBlock.toLocaleString()}` : ''}
      </div>
    </div>
  );
}
