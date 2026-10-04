/** Own background polling and prevent slow polls from piling up. */
export class RuntimeTimers {
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private closed = false;

  every(intervalMs: number, work: () => unknown | Promise<unknown>, report: (error: unknown) => void = console.error): void {
    if (this.closed) return;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Polling interval must be positive');
    let running = false;
    const timer = setInterval(() => {
      if (this.closed || running) return;
      running = true;
      void Promise.resolve().then(() => {if (!this.closed) return work();})
        .catch(error => {try {report(error);} catch { /* Keep the next poll usable. */ }})
        .finally(() => {running = false;});
    }, intervalMs);
    timer.unref();
    this.timers.add(timer);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}
