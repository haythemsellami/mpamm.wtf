import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { BottomNav } from './components/BottomNav';
import { Tour } from './components/Tour';
import { useViewport } from './lib/viewport';
import { useDashboard, type Tab } from './store';

/** the tab labels advertise [1]-[4] — honor them (and give keyboard users at
 *  least tab switching until the controls become real buttons). */
const TAB_KEYS: Record<string, Tab> = { '1': 'exec', '2': 'volume', '3': 'markouts', '4': 'leaderboard' };
import { ExecutionTab } from './tabs/Execution';
import { VolumeTab } from './tabs/Volume';
import { MarkoutsTab } from './tabs/Markouts';
import { LeaderboardTab } from './tabs/Leaderboard';

export function App() {
  const { tab, set } = useDashboard();
  const { mobile } = useViewport();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TAB_KEYS[e.key];
      if (t) set('tab', t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    // bottom padding keeps the last panel clear of the fixed mobile nav.
    <div style={mobile ? { paddingBottom: 'calc(64px + env(safe-area-inset-bottom))' } : undefined}>
      <Tour />
      <TopBar />
      {tab === 'exec' && <ExecutionTab />}
      {tab === 'volume' && <VolumeTab />}
      {tab === 'markouts' && <MarkoutsTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
      {mobile && <BottomNav />}
    </div>
  );
}
