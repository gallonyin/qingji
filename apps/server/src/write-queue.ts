/** One commit at a time, including revision checks and idempotency results. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async drain() { await this.tail; }
}
