export type Tab = 'exec' | 'volume' | 'markouts' | 'leaderboard';

const TAB_PATHS: Record<Tab, string> = {
  exec: '/',
  volume: '/volume',
  markouts: '/markouts',
  leaderboard: '/leaderboard',
};

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function pathForTab(tab: Tab): string {
  return TAB_PATHS[tab];
}

export function tabFromPath(pathname: string): Tab | null {
  const path = normalizedPath(pathname);
  return (Object.keys(TAB_PATHS) as Tab[]).find((tab) => TAB_PATHS[tab] === path) ?? null;
}

export function urlForTab(tab: Tab, search = '', hash = ''): string {
  return `${pathForTab(tab)}${search}${hash}`;
}
