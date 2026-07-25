/**
 * Host-bound reference to one prepared evidence bundle. Agent code treats the
 * value as opaque and preserves it byte-for-byte for every subprocess branch.
 */
export interface HostDataRefRequest {
  readonly dataRef: string;
}

export function assertHostDataRef(value: unknown, operation: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${operation} dataRef must be a non-empty string`);
  }
}
