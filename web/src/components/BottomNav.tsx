import { C, SANS } from '../theme';
import { useDashboard, type Tab } from '../store';

/** Mobile-only bottom tab bar (pamm.wtf pattern): the top bar collapses to
 *  status-only on phones and navigation moves here — fixed, thumb-reachable,
 *  with a safe-area inset for notched devices. Desktop keeps the top tabs. */

const ICONS: Record<Tab, JSX.Element> = {
  exec: ( // two candlesticks
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M6 2v3M6 13v3M3.5 5h5v8h-5zM12 3v2M12 14v2M9.5 5h5v9h-5z" />
    </svg>
  ),
  volume: ( // bars
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 15V9M7.5 15V4M12 15V7M16 15V11" strokeLinecap="round" />
    </svg>
  ),
  markouts: ( // pulse
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M1.5 10h3l2-5 3.5 8 2.5-6 1.5 3h2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  leaderboard: ( // podium columns
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 15V11h3v4M7.5 15V5h3v10M12.5 15V8h3v7M2 15.5h14" strokeLinecap="round" />
    </svg>
  ),
};

const ITEMS: { id: Tab; label: string }[] = [
  { id: 'exec', label: 'EXECUTION' },
  { id: 'volume', label: 'VOLUME' },
  { id: 'markouts', label: 'MARKOUTS' },
  { id: 'leaderboard', label: 'LEADERBOARD' },
];

export function BottomNav() {
  const d = useDashboard();
  return (
    <nav aria-label="Sections" style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60,
      display: 'flex', background: C.panel, borderTop: `1px solid ${C.line}`,
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {ITEMS.map((t) => {
        const on = d.tab === t.id;
        return (
          <button key={t.id} type="button" aria-current={on ? 'page' : undefined}
            onClick={() => d.set('tab', t.id)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '9px 0 7px', cursor: 'pointer', fontFamily: SANS,
              fontSize: 8.5, letterSpacing: '.08em',
              color: on ? C.accent : C.dim2,
              borderTop: `2px solid ${on ? C.accent : 'transparent'}`,
            }}>
            {ICONS[t.id]}
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
