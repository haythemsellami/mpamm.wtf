import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { DepthPublication } from '../datasource/index.js';
import type { DepthWorkerRequest, DepthWorkerResponse } from './protocol.js';

const IDLE_EXIT_MS = 30_000;
const RESTART_MS = 1_000;
const DEPTH_HEAP_MB = 96;

/** The service runs under a 320MB heap cap on small production instances. A
 *  child inheriting that same allowance could let the two processes exceed the
 *  container limit, even though depth needs only a small bounded heap. */
function depthNodeOptions(value = process.env.NODE_OPTIONS ?? ''): string {
  const withoutHeapCap = value.replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '').trim();
  return `${withoutHeapCap}${withoutHeapCap ? ' ' : ''}--max-old-space-size=${DEPTH_HEAP_MB}`;
}

/**
 * Main-process boundary for high-resolution depth work.
 *
 * The child owns adapter discovery, RPC calls, ABI encoding/decoding and JSON
 * serialization. This object only maintains market demand and forwards the
 * completed string, so opening Execution cannot add work to the quote loop's
 * event loop. A dedicated RPC_DEPTH_URL completes the isolation at the provider
 * capacity/rate-limit layer as well.
 */
export class DepthWorkerClient {
  private child?: ChildProcess;
  private demanded = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private warnedSharedRpc = false;
  private generation = 0;

  constructor(
    private readonly onPublication: (publication: DepthPublication) => void,
    private readonly onStatus: (level: 'info' | 'warn', message: string) => void = () => {},
  ) {}

  setDemand(market: string, active: boolean): void {
    if (this.stopping || !config.depthEnabled) return;
    if (active) {
      this.demanded.add(market);
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
      this.ensureChild();
      this.send({ type: 'subscribe', market });
      return;
    }
    this.demanded.delete(market);
    this.send({ type: 'unsubscribe', market });
    if (!this.demanded.size && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        if (!this.demanded.size) this.stopChild();
      }, IDLE_EXIT_MS);
      this.idleTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.demanded.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      this.send({ type: 'stop' });
      const force = setTimeout(() => { if (child.exitCode == null) child.kill('SIGTERM'); }, 2_000);
      force.unref();
      child.once('exit', () => clearTimeout(force));
    });
  }

  private ensureChild(): void {
    if (this.child || this.stopping) return;
    const generation = ++this.generation;
    const entry = fileURLToPath(new URL('./worker-entry.ts', import.meta.url));
    const depthRpc = config.rpcDepth || config.rpcHttp;
    if (!config.rpcDepth && !this.warnedSharedRpc) {
      this.warnedSharedRpc = true;
      this.onStatus('warn', 'depth worker is process-isolated but RPC_DEPTH_URL is unset, so provider capacity is still shared with realtime quotes');
    }
    const child = fork(entry, [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        NODE_OPTIONS: depthNodeOptions(),
        RPC_HTTP_URL: depthRpc,
        RPC_WS_URL: config.rpcDepthWs,
        RPC_HTTP_BACKUP_URLS: config.rpcDepthBackups.join(','),
        RPC_ARCHIVE_URL: '',
        RPC_ARCHIVE_BACKUP_URLS: '',
        BACKFILL: 'off',
        MARKOUT_BACKFILL: 'off',
        GAS_METRIC: 'off',
      },
    });
    this.child = child;
    child.on('message', (raw) => {
      if (generation !== this.generation) return;
      const message = raw as DepthWorkerResponse;
      if (message.type === 'publication') this.onPublication(message.publication);
      else if (message.type === 'status') this.onStatus(message.level, message.message);
      else if (message.type === 'ready') {
        for (const market of this.demanded) this.send({ type: 'subscribe', market });
      }
    });
    child.once('exit', (code, signal) => {
      if (generation !== this.generation) return;
      this.child = undefined;
      if (this.stopping || !this.demanded.size) return;
      this.onStatus('warn', `depth worker exited (${signal ?? code ?? 'unknown'}); restarting`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.ensureChild();
      }, RESTART_MS);
      this.restartTimer.unref();
    });
    child.once('error', (error) => {
      if (this.stopping || generation !== this.generation) return;
      this.onStatus('warn', `depth worker failed to start: ${error.message}`);
    });
  }

  private send(message: DepthWorkerRequest): void {
    if (this.child?.connected) this.child.send(message);
  }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    this.generation += 1;
    this.child = undefined;
    if (child.connected) child.send({ type: 'stop' } satisfies DepthWorkerRequest);
    else child.kill('SIGTERM');
    const force = setTimeout(() => { if (child.exitCode == null) child.kill('SIGTERM'); }, 2_000);
    force.unref();
    child.once('exit', () => clearTimeout(force));
  }
}
