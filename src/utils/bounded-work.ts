/** One native inference at a time, with a fixed-size waiting room. */
export class BoundedWork {
  private active = false;
  private waiting: Array<() => void> = [];
  constructor(private readonly maxPending = 2) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active && this.waiting.length >= this.maxPending) {
      return Promise.reject(new Error("Local speech recognition is busy; try again shortly."));
    }
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active = true;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          const next = this.waiting.shift();
          if (next) next(); else this.active = false;
        });
      };
      if (this.active) this.waiting.push(start); else start();
    });
  }
}
