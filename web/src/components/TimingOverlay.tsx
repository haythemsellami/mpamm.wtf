import { useEffect, useState } from 'react';
import { C } from '../theme';
import { timingEnabled, timingSamples, timingSummary } from '../lib/frame-timing';

/** `?timing=1` only (a developer mode; nothing is collected from viewers):
 *  p50 / p90 of each hop from the block's proposal to the paint, over the
 *  last 600 frames this tab painted. */
export function TimingOverlay() {
  const [, tick] = useState(0);
  const on = timingEnabled();
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [on]);
  if (!on) return null;
  const summary = timingSummary(timingSamples());
  return (
    <div data-timing-overlay style={{
      position: 'fixed', right: 12, bottom: 12, zIndex: 60, padding: '8px 10px', fontSize: 10,
      lineHeight: 1.6, background: C.overlay, border: `1px solid ${C.line}`, color: C.text2, minWidth: 210,
    }}>
      <div style={{ color: C.faint2, letterSpacing: '.06em', marginBottom: 2 }}>TIMING · p50 / p90 ms</div>
      {Object.entries(summary).map(([hop, v]) => (
        <div key={hop} data-hop={hop} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>{hop}{hop.startsWith('proposal') ? ' *' : ''}</span>
          <span style={{ color: C.text }}>{v ? `${Math.round(v.p50)} / ${Math.round(v.p90)} (${v.n})` : '—'}</span>
        </div>
      ))}
      <div style={{ color: C.faint2, marginTop: 2 }}>* server proposal clock vs this browser (NTP accuracy)</div>
    </div>
  );
}
