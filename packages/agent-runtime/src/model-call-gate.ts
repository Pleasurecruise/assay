type ReleaseModelCall = () => void;

export class ModelCallGate {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<(release: ReleaseModelCall) => void> = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("maxConcurrentModelCalls must be a positive integer");
    }
    this.#limit = limit;
  }

  acquire(): Promise<ReleaseModelCall> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#releaseHandle());
    }
    return new Promise<ReleaseModelCall>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #releaseHandle(): ReleaseModelCall {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#active -= 1;
      } else {
        // Transfer the occupied slot directly to the next waiter so a new
        // acquirer cannot race into the gap between wake-up and continuation.
        next(this.#releaseHandle());
      }
    };
  }
}
