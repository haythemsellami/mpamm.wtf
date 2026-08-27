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

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sendTo(child: ChildProcess, message: DepthWorkerRequest): boolean {
  if (!child.connected || hasExited(child)) return false;
  try {
    // Supplying a callback contains an IPC-close race that Node would otherwise
    // surface as an unhandled child-process error.
    child.send(message, () => {});
    return true;
  } catch {
    return false;
  }
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (hasExited(child)) return;
  try { child.kill(signal); } catch { /* an already-reaped process needs no cleanup */ }
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
    if (!this.demanded.size && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (!this.demanded.size && this.child && !this.idleTimer) {
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
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.generation += 1;
    await this.terminate(child);
  }

  private ensureChild(): void {
    if (this.child || this.stopping || !this.demanded.size) return;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const generation = ++this.generation;
    const entry = fileURLToPath(new URL('./worker-entry.ts', import.meta.url));
    const depthRpc = config.rpcDepth || config.rpcHttp;
    if (!config.rpcDepth && !this.warnedSharedRpc) {
      this.warnedSharedRpc = true;
      this.onStatus('warn', 'depth worker is process-isolated but RPC_DEPTH_URL is unset, so provider capacity is still shared with realtime quotes');
    }
    let child: ChildProcess;
    try {
      child = fork(entry, [], {
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
    } catch (error) {
      this.onStatus('warn', `depth worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleRestart();
      return;
    }
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
      if (generation !== this.generation || this.child !== child) return;
      this.child = undefined;
      if (this.stopping || !this.demanded.size) return;
      this.onStatus('warn', `depth worker exited (${signal ?? code ?? 'unknown'}); restarting`);
      this.scheduleRestart();
    });
    child.on('error', (error) => {
      if (this.stopping || generation !== this.generation || this.child !== child) return;
      this.child = undefined;
      this.generation += 1;
      this.onStatus('warn', `depth worker failed to start: ${error.message}`);
      void this.terminate(child).then(() => this.scheduleRestart());
    });
  }

  private send(message: DepthWorkerRequest): void {
    if (this.child) sendTo(this.child, message);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || !this.demanded.size) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.ensureChild();
    }, RESTART_MS);
    this.restartTimer.unref();
  }

  /** Give the normal IPC shutdown a grace period, then bound the wait even if
   *  the process was already reaped or never emits another lifecycle event. */
  private terminate(child: ChildProcess): Promise<void> {
    if (hasExited(child)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let finished = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (force) clearTimeout(force);
        child.off('exit', finish);
        resolve();
      };
      child.once('exit', finish);
      if (!sendTo(child, { type: 'stop' })) kill(child, 'SIGTERM');
      if (finished || hasExited(child)) { finish(); return; }
      force = setTimeout(() => {
        kill(child, 'SIGKILL');
        finish();
      }, 2_000);
      force.unref();
    });
  }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    this.generation += 1;
    this.child = undefined;
    void this.terminate(child);
  }
}
