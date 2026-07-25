export interface ModelCallLease {
  readonly slotId: number;
  release(): void;
}

export class ModelCallGate {
  readonly #availableSlotIds: number[];
  readonly #waiters: Array<(lease: ModelCallLease) => void> = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("maxConcurrentModelCalls must be a positive integer");
    }
    this.#availableSlotIds = Array.from({ length: limit }, (_value, index) => index);
  }

  acquire(): Promise<ModelCallLease> {
    const slotId = this.#availableSlotIds.shift();
    if (slotId !== undefined) {
      return Promise.resolve(this.#lease(slotId));
    }
    return new Promise<ModelCallLease>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #lease(slotId: number): ModelCallLease {
    let released = false;
    return {
      slotId,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const next = this.#waiters.shift();
        if (next === undefined) {
          this.#availableSlotIds.push(slotId);
        } else {
          // Transfer the same occupied slot directly to the oldest waiter.
          // This binds a credential to one concurrent slot and prevents a new
          // acquirer from racing into the release-to-wake-up gap.
          next(this.#lease(slotId));
        }
      },
    };
  }
}
