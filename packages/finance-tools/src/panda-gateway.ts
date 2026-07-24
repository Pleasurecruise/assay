export const PANDA_DATA_OPERATIONS = [
  "market_data",
  "adj_factor",
  "index_weights",
  "trade_list",
  "stock_status_change",
  "factor",
  "trade_calendar",
  "financial_forecast",
  "financial_performance",
  "financial_reports",
  "strategy_backtest",
] as const;

export type PandaDataOperation = (typeof PANDA_DATA_OPERATIONS)[number];

export interface PandaDataResult {
  operation: PandaDataOperation;
  sourceRef: string;
  rowCount: number;
  truncated: boolean;
  rows: readonly Record<string, unknown>[];
}

export interface PandaDataError {
  code: string;
  message: string;
  retryable: boolean;
}

type PandaDataWireResponse =
  | {
      id: string;
      ok: true;
      data: PandaDataResult;
    }
  | {
      id: string;
      ok: false;
      error: PandaDataError;
    };

export interface PandaDataGateway {
  query(
    operation: PandaDataOperation,
    params: Readonly<Record<string, unknown>>,
    options?: { maxRows?: number; requestId?: string; signal?: AbortSignal },
  ): Promise<PandaDataResult>;
}

interface PendingRequest {
  resolve(response: PandaDataWireResponse): void;
  reject(error: Error): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWireResponse(value: unknown): value is PandaDataWireResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.ok === "boolean";
}

/**
 * A single long-lived JSON-lines worker keeps PandaData authentication process-local.
 * Credentials are inherited through the environment and never cross this protocol.
 */
export class PandaDataProcessGateway implements PandaDataGateway {
  readonly #pending = new Map<string, PendingRequest>();
  #process?: ReturnType<typeof Bun.spawn>;
  #starting?: Promise<void>;
  #buffer = "";

  async query(
    operation: PandaDataOperation,
    params: Readonly<Record<string, unknown>>,
    options: { maxRows?: number; requestId?: string; signal?: AbortSignal } = {},
  ): Promise<PandaDataResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("PandaData query aborted before start");
    }
    await this.#start();

    const id = options.requestId ?? crypto.randomUUID();
    const response = new Promise<PandaDataWireResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const abort = (): void => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.reject(new Error("PandaData query aborted"));
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      const stdin = this.#process?.stdin;
      if (!stdin || typeof stdin === "number") {
        throw new Error("PandaData worker stdin is unavailable");
      }
      await stdin.write(
        `${JSON.stringify({
          id,
          operation,
          params,
          maxRows: options.maxRows ?? 1_000,
        })}\n`,
      );
      await stdin.flush();

      const result = await response;
      if (!result.ok) {
        const error = new Error(`${result.error.code}: ${result.error.message}`);
        error.name = "PandaDataGatewayError";
        throw error;
      }
      return result.data;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.#pending.delete(id);
    }
  }

  async #start(): Promise<void> {
    if (this.#process) {
      return;
    }
    if (this.#starting) {
      return this.#starting;
    }

    this.#starting = (async () => {
      const adapterProject = `${import.meta.dir}/../../../services/panda-adapter`;
      const subprocess = Bun.spawn({
        cmd: ["uv", "run", "--project", adapterProject, "python", "-m", "panda_adapter", "serve"],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.#process = subprocess;
      void this.#readResponses(subprocess.stdout);
      void this.#drain(subprocess.stderr);
      void subprocess.exited.then((exitCode) => {
        if (this.#process !== subprocess) {
          return;
        }
        this.#process = undefined;
        const error = new Error(`PandaData worker exited with code ${exitCode}`);
        for (const pending of this.#pending.values()) {
          pending.reject(error);
        }
        this.#pending.clear();
      });
    })();

    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #readResponses(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        this.#buffer += decoder.decode(value, { stream: true });
        let newline = this.#buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line) {
            this.#dispatch(line);
          }
          newline = this.#buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async #drain(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // Provider stderr can contain sensitive diagnostics, so it is discarded.
      }
    } finally {
      reader.releaseLock();
    }
  }

  #dispatch(line: string): void {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isWireResponse(parsed)) {
        throw new Error("PandaData worker returned an invalid response");
      }
      this.#pending.get(parsed.id)?.resolve(parsed);
    } catch (error) {
      const failure = new Error(`Invalid PandaData worker output: ${errorMessage(error)}`);
      for (const pending of this.#pending.values()) {
        pending.reject(failure);
      }
      this.#pending.clear();
    }
  }
}
