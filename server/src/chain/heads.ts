import WebSocket from 'ws';
import type { PublicClient } from 'viem';
import { MONAD_CHAIN_ID } from '@shared';

export type HeadSource = 'http' | 'ws';

export interface HotHeadCallbacks {
  onBlock: (blockNumber: bigint, source: HeadSource) => void;
  /** A configured subscription failed; HTTP polling is still serving heads. */
  onWsFallback?: () => void;
  /** A subscription delivered heads again after falling back. */
  onWsRecovered?: () => void;
}

interface HeadWatcherOptions {
  wsUrl?: string;
  pollMs: number;
  /** Test seam: production uses the ws package directly. */
  openSocket?: (url: string) => WebSocket;
}

/**
 * One monotonic hot-head feed backed by two transports:
 *
 * - WebSocket `newHeads` is the low-latency trigger when RPC_WS_URL serves it.
 * - A fast HTTP `eth_blockNumber` poll always remains active. It is both the
 *   no-WebSocket implementation and a watchdog for a half-open subscription.
 *
 * Both paths enter `publish`, so duplicate/out-of-order observations never run
 * a quote twice. URL/error text is deliberately not surfaced: provider URLs
 * embed credentials and the public note only needs to say which path is active.
 */
export class HotHeadWatcher {
  private stopped = true;
  private last = -1n;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private wsReadyTimer?: ReturnType<typeof setTimeout>;
  private socket?: WebSocket;
  private reconnectMs = 1_000;
  private wsUnavailable = false;
  private callbacks?: HotHeadCallbacks;

  constructor(
    private readonly client: Pick<PublicClient, 'getBlockNumber'>,
    private readonly options: HeadWatcherOptions,
  ) {}

  start(callbacks: HotHeadCallbacks): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.callbacks = callbacks;
    void this.poll();
    if (this.options.wsUrl) this.connectWs();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    this.wsReadyTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
  }

  private publish(blockNumber: bigint, source: HeadSource): void {
    if (this.stopped || blockNumber <= this.last) return;
    this.last = blockNumber;
    this.callbacks?.onBlock(blockNumber, source);
  }

  private async poll(): Promise<void> {
    const started = Date.now();
    try { this.publish(await this.client.getBlockNumber(), 'http'); }
    catch { /* the hot-pool breaker reports transport health; retry next poll */ }
    if (this.stopped) return;
    const floor = Math.max(25, this.options.pollMs);
    this.pollTimer = setTimeout(() => { void this.poll(); }, Math.max(0, floor - (Date.now() - started)));
  }

  private connectWs(): void {
    if (this.stopped || !this.options.wsUrl) return;
    let socket: WebSocket;
    try {
      socket = (this.options.openSocket ?? ((url) => new WebSocket(url, { handshakeTimeout: 10_000 })))(this.options.wsUrl);
    } catch {
      this.scheduleWsReconnect();
      return;
    }
    this.socket = socket;
    let subscribed = false;
    let settled = false;

    socket.once('open', () => {
      // A trigger from another chain can jump `last` far ahead and suppress the
      // correct HTTP heads indefinitely. Verify identity before subscribing.
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
      this.wsReadyTimer = setTimeout(() => unavailable(), 10_000);
    });
    socket.on('message', (raw) => {
      if (this.stopped || settled || this.socket !== socket) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.id === 1) {
        let chainId: bigint;
        try { chainId = BigInt(msg.result); } catch { try { socket.close(); } catch { /* already closed */ } return; }
        if (chainId !== BigInt(MONAD_CHAIN_ID)) { try { socket.close(); } catch { /* already closed */ } return; }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
        return;
      }
      if (msg?.id === 2) {
        if (typeof msg.result !== 'string') { try { socket.close(); } catch { /* already closed */ } return; }
        subscribed = true;
        if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
        this.wsReadyTimer = undefined;
        this.reconnectMs = 1_000;
        return;
      }
      const rawNumber = msg?.method === 'eth_subscription' ? msg?.params?.result?.number : undefined;
      if (!subscribed || typeof rawNumber !== 'string') return;
      try {
        if (this.wsUnavailable) {
          this.wsUnavailable = false;
          this.callbacks?.onWsRecovered?.();
        }
        this.publish(BigInt(rawNumber), 'ws');
      } catch { /* malformed provider frame */ }
    });

    const unavailable = () => {
      if (settled || this.stopped || this.socket !== socket) return;
      settled = true;
      if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
      this.wsReadyTimer = undefined;
      this.socket = undefined;
      // `error` normally precedes `close` on a failed upgrade, but not every
      // implementation guarantees the close. Terminate after detaching this
      // socket so it cannot leak or schedule a second reconnect.
      try { socket.terminate(); } catch { /* already closed */ }
      this.scheduleWsReconnect();
    };
    socket.once('close', unavailable);
    // ws emits `error` before `close` for handshake failures. Consume it so the
    // process never gets an unhandled error; `unavailable` is idempotent.
    socket.once('error', unavailable);
  }

  private scheduleWsReconnect(): void {
    if (this.stopped) return;
    if (!this.wsUnavailable) {
      this.wsUnavailable = true;
      this.callbacks?.onWsFallback?.();
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWs();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
  }
}
