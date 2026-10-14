// Retry storage operations, never provider requests. Disk exhaustion and
// programming errors deliberately remain outside this recovery policy.
export function recoverableStorageError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  return /^(SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN)(_|$)|EIO$|EBUSY$|EAGAIN$|EMFILE$|ENFILE$)/.test(
    code,
  );
}

type Operation = { write: () => void; committed: () => void };

export class Persistence {
  private pending: Operation[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private flushing = false;
  constructor(private recovered: () => void = () => {}) {}
  status() {
    return {
      healthy: this.pending.length === 0,
      pendingOperations: this.pending.length,
    };
  }
  get blocked() {
    return this.pending.length > 0;
  }
  submit(write: () => void, committed: () => void = () => {}) {
    this.pending.push({ write, committed });
    if (!this.timer) this.flush();
  }
  // Failed synchronous admission must be retried explicitly by its caller.
  // A read probe suspends unrelated dispatch until storage becomes available.
  failed(error: unknown, probe: () => void) {
    if (!recoverableStorageError(error)) throw error;
    this.pending.push({ write: probe, committed: () => {} });
    this.retry();
  }
  private retry() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delay);
    this.delay = Math.min(30000, this.delay * 2);
  }
  private flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const operation = this.pending[0];
        try {
          operation.write();
        } catch (error) {
          if (!recoverableStorageError(error)) throw error;
          this.retry();
          return;
        }
        this.pending.shift();
        operation.committed();
      }
      this.delay = 1000;
      this.recovered();
    } finally {
      this.flushing = false;
    }
  }
}
