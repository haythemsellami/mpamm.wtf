import { useEffect, useState } from 'react';

/** A stopped stream must age without needing another data frame to render. */
export function useSnapshotStale(ts: number | undefined, timeoutMs = 1_500): boolean {
  const [expiredTs, setExpiredTs] = useState<number>();
  useEffect(() => {
    if (!ts) return;
    const timer = setTimeout(() => setExpiredTs(ts), Math.max(0, ts + timeoutMs - Date.now()));
    return () => clearTimeout(timer);
  }, [ts, timeoutMs]);
  return !!ts && (expiredTs === ts || Date.now() - ts >= timeoutMs);
}
