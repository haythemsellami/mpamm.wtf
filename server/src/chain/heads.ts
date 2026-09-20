import WebSocket from 'ws';
import type { PublicClient } from 'viem';
import { MONAD_CHAIN_ID, type QuoteHeadSource } from '@shared';

export type HeadSource = Exclude<QuoteHeadSource, 'sim'>;
export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';
export interface HeadIdentity {
  hash?: `0x${string}`;
  blockId?: string;
  commitState?: CommitState;
  generation?: number;
  revision?: number;
}
export interface HeadEndpoint { generation: number; wsUrl?: string }
export interface HotHeadCallbacks {
  onBlock: (blockNumber: bigint, source: HeadSource, observedAt: number, identity?: HeadIdentity) => void;
  onReplaced?: (fromBlock: bigint) => void;
  onWsConnected?: () => void;
  onWsFallback?: () => void;
  onWsRecovered?: () => void;
}
interface HeadWatcherOptions {
  wsUrl?: string;
  endpoint?: () => HeadEndpoint;
  pollMs: number;
  openSocket?: (url: string) => WebSocket;
}
const ranks: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };
const hashPattern = /^0x[\da-f]{64}$/i;

/** HTTP remains a watchdog. The socket follows the HTTP pool's generation,
 * and proposal identity, rather than height alone, controls replacements. */
export class HotHeadWatcher {
  private stopped = true;
  private session = 0;
  private last = -1n;
  private lastGeneration = -1;
  private revision = 0;
  private identities = new Map<bigint, HeadIdentity>();
  private abandoned = new Set<string>();
  private endpoint: HeadEndpoint = { generation: 0 };
  private pollTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private wsReadyTimer?: ReturnType<typeof setTimeout>;
  private socket?: WebSocket;
  private reconnectMs = 1_000;
  private wsUnavailable = false;
  private lastWsAt = 0;
  private callbacks?: HotHeadCallbacks;

  constructor(private readonly client: Pick<PublicClient, 'getBlockNumber'>, private readonly options: HeadWatcherOptions) {}

  start(callbacks: HotHeadCallbacks): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.session++;
    this.callbacks = callbacks;
    this.endpoint = this.options.endpoint?.() ?? { generation: 0, wsUrl: this.options.wsUrl };
    void this.poll(this.session);
    this.connectWs();
  }
  stop(): void {
    this.stopped = true;
    this.session++;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.detachWs();
  }
  identity(block: bigint): HeadIdentity {
    return { ...this.identities.get(block), generation: this.endpoint.generation, revision: this.revision };
  }
  isCurrent(block: bigint, identity: HeadIdentity): boolean {
    return (!identity.hash || !this.abandoned.has(identity.hash))
      && (identity.revision ?? 0) === this.revision
      && (identity.generation === undefined || identity.generation === (this.options.endpoint?.().generation ?? this.endpoint.generation))
      && (!identity.hash || !this.identities.get(block)?.hash || identity.hash === this.identities.get(block)?.hash);
  }
  rememberResolved(block: bigint, identity: HeadIdentity): boolean {
    if (!this.isCurrent(block, identity)) return false;
    // HTTP can win the head race. Retain its resolved hash so a later WS
    // proposal at this height can invalidate an already-published frame.
    if (identity.hash && !this.identities.get(block)?.hash) this.identities.set(block, { ...identity });
    for (const height of this.identities.keys()) if (height < this.last - 64n) this.identities.delete(height);
    return true;
  }
  private detachWs(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
    this.reconnectTimer = this.wsReadyTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.lastWsAt = 0;
    try { socket?.terminate(); } catch { /* already closed */ }
  }
  private refreshEndpoint(): void {
    const next = this.options.endpoint?.();
    if (!next || (next.generation === this.endpoint.generation && next.wsUrl === this.endpoint.wsUrl)) return;
    this.detachWs();
    this.endpoint = next;
    this.identities.clear();
    this.wsUnavailable = true;
    this.callbacks?.onWsFallback?.();
    this.connectWs();
  }
  private publish(block: bigint, source: HeadSource, incoming?: HeadIdentity): void {
    if (this.stopped || block < 0n) return;
    if (incoming?.hash && this.abandoned.has(incoming.hash)) {
      if (!incoming.commitState || ranks[incoming.commitState] < 2) return;
      this.abandoned.delete(incoming.hash);
    }
    const prior = this.identities.get(block);
    // Commitment upgrades never cause another quote; a losing, delayed
    // proposal cannot supersede one already finalized at this height.
    if (prior?.commitState && ranks[prior.commitState] >= 2 && incoming?.hash !== prior.hash) return;
    const replaced = !!(prior?.hash && incoming?.hash && prior.hash !== incoming.hash);
    if (incoming?.hash) {
      if (replaced) {
        this.revision++;
        for (const [height, identity] of this.identities) if (height >= block) {
          if (identity.hash) this.abandoned.add(identity.hash);
          this.identities.delete(height);
        }
        while (this.abandoned.size > 256) this.abandoned.delete(this.abandoned.values().next().value!);
        this.callbacks?.onReplaced?.(block);
      }
      if (!prior || replaced || !prior.commitState || !incoming.commitState || ranks[incoming.commitState] >= ranks[prior.commitState]) {
        this.identities.set(block, incoming);
      }
      for (const height of this.identities.keys()) if (height < this.last - 64n) this.identities.delete(height);
    }
    if (!replaced && block <= this.last && this.lastGeneration === this.endpoint.generation) return;
    if (block < this.last && !replaced) return;
    this.last = replaced || block > this.last ? block : this.last;
    this.lastGeneration = this.endpoint.generation;
    this.callbacks?.onBlock(this.last, source, Date.now(), this.identity(this.last));
  }
  private async poll(session: number): Promise<void> {
    if (this.stopped || session !== this.session) return;
    this.refreshEndpoint();
    const started = Date.now();
    const generation = this.endpoint.generation;
    try {
      const block = await this.client.getBlockNumber();
      if (this.stopped || session !== this.session) return;
      this.refreshEndpoint();
      if (generation === this.endpoint.generation) this.publish(block, 'http');
    } catch { /* the pool reports transport health; retry next poll */ }
    if (this.stopped || session !== this.session) return;
    if (this.socket && this.lastWsAt && Date.now() - this.lastWsAt > 3_000) {
      this.detachWs(); this.scheduleWsReconnect();
    }
    this.pollTimer = setTimeout(() => { void this.poll(session); }, Math.max(0, Math.max(25, this.options.pollMs) - (Date.now() - started)));
  }
  private connectWs(): void {
    const url = this.endpoint.wsUrl;
    if (this.stopped || !url) return;
    let socket: WebSocket;
    try { socket = (this.options.openSocket ?? ((u) => new WebSocket(u, { handshakeTimeout: 5_000 })))(url); }
    catch { this.scheduleWsReconnect(); return; }
    this.socket = socket;
    const generation = this.endpoint.generation;
    let subscription: string | undefined;
    let native = true;
    const current = () => !this.stopped && this.socket === socket
      && generation === (this.options.endpoint?.().generation ?? this.endpoint.generation);
    const unavailable = () => {
      if (this.socket !== socket || this.stopped) return;
      this.detachWs(); this.scheduleWsReconnect();
    };
    this.wsReadyTimer = setTimeout(unavailable, 5_000);
    socket.once('open', () => {
      if (current()) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
    });
    socket.on('message', (raw) => {
      if (!current()) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.id === 1) {
        try { if (BigInt(msg.result) !== BigInt(MONAD_CHAIN_ID)) { unavailable(); return; } }
        catch { unavailable(); return; }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['monadNewHeads'] }));
        return;
      }
      if (msg?.id === 2 || msg?.id === 3) {
        if (msg.id === 2 && native && msg.error) {
          native = false;
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_subscribe', params: ['newHeads'] }));
          return;
        }
        if (typeof msg.result !== 'string') { unavailable(); return; }
        subscription = msg.result;
        if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
        this.wsReadyTimer = undefined;
        this.reconnectMs = 1_000;
        this.lastWsAt = Date.now();
        if (!this.wsUnavailable) this.callbacks?.onWsConnected?.();
        return;
      }
      const head = msg?.method === 'eth_subscription' ? msg?.params?.result : undefined;
      if (!subscription || msg?.params?.subscription !== subscription || typeof head?.number !== 'string') return;
      let block: bigint;
      try { block = BigInt(head.number); } catch { return; }
      this.lastWsAt = Date.now();
      if (this.wsUnavailable) { this.wsUnavailable = false; this.callbacks?.onWsRecovered?.(); }
      const identity: HeadIdentity = {};
      if (typeof head.hash === 'string' && hashPattern.test(head.hash)) identity.hash = head.hash.toLowerCase();
      if (native && typeof head.blockId === 'string' && hashPattern.test(head.blockId)) identity.blockId = head.blockId;
      if (native && typeof head.commitState === 'string' && Object.hasOwn(ranks, head.commitState)) identity.commitState = head.commitState;
      this.publish(block, 'ws', identity);
    });
    socket.once('close', unavailable);
    socket.on('error', unavailable);
  }
  private scheduleWsReconnect(): void {
    if (this.stopped) return;
    if (!this.wsUnavailable) { this.wsUnavailable = true; this.callbacks?.onWsFallback?.(); }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.refreshEndpoint(); if (!this.socket) this.connectWs(); }, this.reconnectMs);
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
  }
}
