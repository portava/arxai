/** Coalesce identical reads and publish only the most recently requested read.
 * Each caller still receives the result for its own immutable request. */
export class ScannerRunCoordinator<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private revision = 0;

  get activeCount(): number {
    return this.inFlight.size;
  }

  async run(key: string, build: () => Promise<T>, publish: (value: T) => void): Promise<T> {
    const revision = ++this.revision;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve().then(build);
      this.inFlight.set(key, pending);
      // Use both handlers instead of an ignored finally() promise: a rejected
      // provider read must not create an unhandled rejection during cleanup.
      void pending.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      );
    }
    const value = await pending;
    if (revision === this.revision) publish(value);
    return value;
  }
}

/** Completion-based polling. A slow scan never accumulates timer work. */
export class ScannerPollLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private running = false;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly interval: () => number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // A stop/start during an active scan waits for that scan's completion.
    if (!this.active) this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.timer = null;
    this.active = Promise.resolve().then(this.run).then(() => {}, () => {});
    void this.active.then(() => {
      this.active = null;
      if (!this.running) return;
      this.timer = setTimeout(() => this.tick(), this.interval());
      this.timer.unref?.();
    });
  }
}
