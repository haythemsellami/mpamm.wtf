/** Deadlines bound frame latency while a still-settling adapter retains its
 * slot. A provider that ignores cancellation cannot accumulate background work. */
export class QuoteRunner {
  private running = new Map<string, AbortController>();

  async run<T>(key: string, deadlineMs: number, task: (signal: AbortSignal) => Promise<T>, missing: T): Promise<T> {
    if (this.running.has(key)) return missing;
    const controller = new AbortController();
    this.running.set(key, controller);
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(missing); }, deadlineMs);
    });
    const work = Promise.resolve().then(() => task(controller.signal)).finally(() => {
      clearTimeout(timer);
      if (this.running.get(key) === controller) this.running.delete(key);
    });
    return Promise.race([work, expired]);
  }

  stop(): void { for (const controller of this.running.values()) controller.abort(); }
}
