import { useEffect, useState } from 'react';
import { C, SANS, LOGO_PURPLE } from '../theme';
import { useDashboard, type Tab } from '../store';
import { clockSec, fmtInt } from '../lib/format';

const TABS: { id: Tab; label: string }[] = [
  { id: 'exec', label: 'EXECUTION' },
  { id: 'volume', label: 'VOLUME' },
  { id: 'markouts', label: 'MARKOUTS' },
  { id: 'leaderboard', label: 'LEADERBOARD' },
];

export function TopBar() {
  const d = useDashboard();
  const [clock, setClock] = useState(clockSec());
  useEffect(() => {
    const t = setInterval(() => setClock(clockSec()), 1000);
    return () => clearInterval(t);
  }, []);

  const monPx = d.state ? d.state.monUsd.toFixed(5) : '—';
  const block = d.state ? fmtInt(d.state.block) : '—';
  const liveColor = d.conn === 'live' ? C.green : d.conn === 'reconnecting' ? C.amber : C.faint;

  // RPC failover health (live source only — sim has no RPC, chip hidden).
  // CVD-safe: the LABEL changes with the state, never color alone.
  const rpc = d.state?.rpc;
  const rpcLabel = rpc ? (rpc.down ? 'DOWN' : rpc.degraded ? rpc.active.toUpperCase() : 'OK') : '';
  const rpcColor = rpc ? (rpc.down ? C.red : rpc.degraded ? C.amber : C.green) : C.faint;
  const rpcTitle = rpc
    ? rpc.down
      ? 'No RPC endpoint is serving — chain data frozen until one recovers'
      : rpc.degraded
        ? `Primary RPC unhealthy — serving from ${rpc.active}${rpc.degradedSinceTs ? ` since ${new Date(rpc.degradedSinceTs).toISOString().slice(11, 16)} UTC` : ''}`
        : 'RPC healthy — serving from the primary endpoint'
    : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, height: 42, padding: '0 16px',
      borderBottom: `1px solid ${C.line}`, position: 'sticky', top: 0, zIndex: 50, background: C.panel,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        {/* Monad product logomark — stays purple in both themes (brand mark, not the theme accent). */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10.5" stroke={LOGO_PURPLE} strokeWidth="1.3" />
          <polygon points="12,6 18,12 12,18 6,12" stroke={LOGO_PURPLE} strokeWidth="1.3" fill="none" />
          <circle cx="12" cy="12" r="1.7" fill={LOGO_PURPLE} />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.01em', fontFamily: SANS, color: C.text }}>propAMM</span>
        <span style={{ fontSize: 8.5, color: C.accent2, border: `1px solid var(--accent-border)`, borderRadius: 3, padding: '2px 6px', letterSpacing: '.08em' }}>
          {d.state?.source === 'live' ? 'MONAD MAINNET' : 'MONAD · SIM'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 1, marginLeft: 8 }}>
        {/* the labels advertise [1]-[4] — wired globally in App (keydown) */}
        {TABS.map((t, i) => (
          <button key={t.id} type="button" aria-current={d.tab === t.id ? 'page' : undefined}
            onClick={() => d.set('tab', t.id)} style={{
              fontSize: 11, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
              borderBottom: `2px solid ${d.tab === t.id ? C.accent : 'transparent'}`,
              color: d.tab === t.id ? C.textStrong : C.dim2,
            }}>[{i + 1}] {t.label}</button>
        ))}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 15, fontSize: 10, color: C.dim2 }}>
        <button type="button" onClick={d.toggleTheme} title="Toggle theme"
          aria-label={`Switch to ${d.theme === 'dark' ? 'bright' : 'dark'} theme`} style={{
            display: 'flex', alignItems: 'center', gap: 5, border: `1px solid var(--pill-border)`,
            borderRadius: 4, padding: '3px 8px', cursor: 'pointer', letterSpacing: '.06em', userSelect: 'none',
            whiteSpace: 'nowrap',
          }}>◐ {d.theme === 'dark' ? 'BRIGHT' : 'DARK'}</button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: liveColor }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: liveColor, animation: 'blink 1.6s infinite' }} />
          {d.conn === 'live' ? 'live' : d.conn === 'reconnecting' ? 'reconnecting' : 'connecting'}
        </span>
        {rpc && (
          <span role="status" title={rpcTitle} aria-label={rpcTitle}
            style={{ display: 'flex', alignItems: 'center', gap: 5, color: rpcColor, whiteSpace: 'nowrap' }}>
            {/* static dot — the blinking one above is socket liveness, this is chain-source health */}
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: rpcColor }} />
            RPC {rpcLabel}
          </span>
        )}
        <span>MON <span style={{ color: C.text }}>${monPx}</span></span>
        <span>BLOCK <span style={{ color: C.text }}>{block}</span></span>
        <span>UTC <span style={{ color: C.text }}>{clock}</span></span>
      </div>
    </div>
  );
}
