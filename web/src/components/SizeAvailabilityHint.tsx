import { useEffect, useState } from 'react';
import type { DepthSnapshot, QuoteSnapshot, VenueMeta } from '@shared';
import { SIZES_USD } from '@shared';
import { connectLiveDepth } from '../lib/api';
import { sizeLabel } from '../lib/format';
import { C } from '../theme';

/** Reuse the already subscribed depth topic for alternate-size evidence. The
 * selected quote stream intentionally contains no other sizes to infer from. */
export function SizeAvailabilityHint({ market, size, venues, quotes }: {
  market: string; size: number; venues: VenueMeta[]; quotes: QuoteSnapshot | null;
}) {
  const [depth, setDepth] = useState<DepthSnapshot | null>(null);
  useEffect(() => { setDepth(null); return connectLiveDepth(market, setDepth); }, [market]);
  useEffect(() => {
    if (!depth) return;
    const remaining = Math.max(0, 5_001 - Math.max(0, Date.now() - depth.ts));
    const timer = setTimeout(() => setDepth((current) => current === depth ? null : current), remaining);
    return () => clearTimeout(timer);
  }, [depth]);
  if (!depth || depth.market !== market || Date.now() - depth.ts > 5_000 || !quotes?.rows.some((r) => r.market === market)) return null;
  const notes = venues.filter((v) => v.role === 'venue').flatMap((venue) => {
    if (quotes.rows.some((r) => r.venueId === venue.id && r.market === market && r.sizeUsd === size)) return [];
    const points = depth.venues.find((v) => v.venueId === venue.id)?.points ?? [];
    const sizes = SIZES_USD.filter((s) => s !== size && points.some((p) => Math.abs(p.notional - s) < s * 1e-8 && (p.bidBps !== undefined || p.askBps !== undefined)));
    return sizes.length ? [`${venue.name} has no ${sizeLabel(size)} quote; its latest depth sample supports ${sizes.map(sizeLabel).join(' / ')}`] : [];
  });
  return notes.length ? <div style={{ padding: '0 14px 10px', fontSize: 9.5, color: C.faint2, lineHeight: 1.5 }}>ⓘ {notes.join(' · ')}</div> : null;
}
