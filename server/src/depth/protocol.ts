import type { DepthPublication } from '../datasource/index.js';

export type DepthWorkerRequest =
  | { type: 'subscribe'; market: string }
  | { type: 'unsubscribe'; market: string }
  | { type: 'stop' };

export type DepthWorkerResponse =
  | { type: 'ready' }
  | { type: 'publication'; publication: DepthPublication }
  | { type: 'status'; level: 'info' | 'warn'; message: string };
