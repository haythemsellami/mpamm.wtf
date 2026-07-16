import { useEffect, useState } from 'react';
import { C, SANS, LOGO_PURPLE } from '../theme';
import { useDashboard, type Tab } from '../store';
import { useViewport } from '../lib/viewport';
import { clockSec, fmtInt } from '../lib/format';

const TABS: { id: Tab; label: string }[] = [
  { id: 'exec', label: 'EXECUTION' },
  { id: 'volume', label: 'VOLUME' },
  { id: 'markouts', label: 'MARKOUTS' },
  { id: 'leaderboard', label: 'LEADERBOARD' },
];

export function TopBar() {
  const d = useDashboard();
  const { mobile, tablet } = useViewport();
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
        {/* OFFICIAL Monad logomark (brand kit path, verbatim) — stays brand purple in both themes. */}
        <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Monad">
          <path fill={LOGO_PURPLE} d="M11.782 0C8.37963 0 0 8.53443 0 11.9999C0 15.4654 8.37963 24 11.782 24C15.1844 24 23.5642 15.4653 23.5642 11.9999C23.5642 8.53458 15.1845 0 11.782 0ZM9.94598 18.8619C8.51124 18.4637 4.65378 11.5912 5.04481 10.1299C5.43584 8.66856 12.1834 4.73984 13.6181 5.1381C15.0529 5.5363 18.9104 12.4087 18.5194 13.87C18.1283 15.3314 11.3807 19.2602 9.94598 18.8619Z" />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.01em', fontFamily: SANS, color: C.text }}>propAMM</span>
        {!mobile && <span style={{ fontSize: 8.5, color: C.accent2, border: `1px solid var(--accent-border)`, borderRadius: 3, padding: '2px 6px', letterSpacing: '.08em' }}>
          {d.state?.source === 'live' ? 'MONAD MAINNET' : 'MONAD · SIM'}
        </span>}
      </div>

      {!mobile && <div style={{ display: 'flex', gap: 1, marginLeft: 8 }}>
        {/* the labels advertise [1]-[4] — wired globally in App (keydown) */}
        {TABS.map((t, i) => (
          <button key={t.id} type="button" aria-current={d.tab === t.id ? 'page' : undefined}
            onClick={() => d.set('tab', t.id)} style={{
              fontSize: 11, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
              borderBottom: `2px solid ${d.tab === t.id ? C.accent : 'transparent'}`,
              color: d.tab === t.id ? C.textStrong : C.dim2,
            }}>[{i + 1}] {t.label}</button>
        ))}
      </div>}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: mobile ? 10 : 15, fontSize: 10, color: C.dim2 }}>
        <button type="button" onClick={d.toggleTheme} title="Toggle theme"
          aria-label={`Switch to ${d.theme === 'dark' ? 'bright' : 'dark'} theme`} style={{
            display: 'flex', alignItems: 'center', gap: 5, border: `1px solid var(--pill-border)`,
            borderRadius: 4, padding: mobile ? '3px 6px' : '3px 8px', cursor: 'pointer', letterSpacing: '.06em', userSelect: 'none',
            whiteSpace: 'nowrap',
          }}>◐{mobile ? '' : ` ${d.theme === 'dark' ? 'BRIGHT' : 'DARK'}`}</button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: liveColor }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: liveColor, animation: 'blink 1.6s infinite' }} />
          {d.conn === 'live' ? 'live' : d.conn === 'reconnecting' ? 'reconnecting' : 'connecting'}
        </span>
        {rpc && (!mobile || rpc.degraded || rpc.down) && (
          <span role="status" title={rpcTitle} aria-label={rpcTitle}
            style={{ display: 'flex', alignItems: 'center', gap: 5, color: rpcColor, whiteSpace: 'nowrap' }}>
            {/* static dot — the blinking one above is socket liveness, this is chain-source health */}
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: rpcColor }} />
            RPC {rpcLabel}
          </span>
        )}
        {!mobile && !tablet && <span>MON <span style={{ color: C.text }}>${monPx}</span></span>}
        {/* on mobile the label words go — the block number and clock read as themselves */}
        <span style={{ whiteSpace: 'nowrap' }}>{!mobile && 'BLOCK '}<span style={{ color: C.text }}>{block}</span></span>
        {(mobile || !tablet) && <span style={{ whiteSpace: 'nowrap' }}>{!mobile && 'UTC '}<span style={{ color: C.text }}>{clock}</span></span>}
      </div>
    </div>
  );
}
