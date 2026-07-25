import {
  Role,
  TaskState,
  type SendMessageRequest,
  type SendMessageResult,
  type Task,
} from "@a2a-js/sdk";
import {
  Client,
  DefaultAgentCardResolver,
  RestTransportFactory,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts/audit-artifact";

export const DEFAULT_A2A_URL = "http://127.0.0.1:3001/a2a";

const ACCEPTED_OUTPUT_MODES = ["application/json", "text/markdown"] as const;
const DEFAULT_HISTORY_LENGTH = 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 20 * 60 * 1_000;

const STOP_POLLING_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

export interface CreateAssayA2AClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SendTextMessageOptions {
  messageId?: string;
  signal?: AbortSignal;
}

export interface GetTaskOptions {
  historyLength?: number;
  signal?: AbortSignal;
}

export interface CancelTaskOptions {
  signal?: AbortSignal;
}

export interface PollTaskOptions extends GetTaskOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface AssayServiceCapabilities {
  skill: "audit_strategy";
  dataProvider: "PandaData";
  dataTools: readonly string[];
  backtester: "assay-backtester@1";
  dataCredentialsConfigured: boolean;
}

export function a2aUrlForHostname(hostname: string): string {
  const normalized = hostname.trim().replace(/^\[(.*)\]$/, "$1");
  if (normalized.length === 0) {
    throw new Error("The page hostname must not be empty");
  }
  const host = normalized.includes(":") ? `[${normalized}]` : normalized;
  return `http://${host}:3001/a2a`;
}

export function sameOriginA2AUrl(origin: string): string {
  return new URL("/a2a", origin).toString().replace(/\/+$/, "");
}

export interface A2APageLocation {
  readonly origin: string;
  readonly hostname: string;
}

export function resolveA2AUrl(
  configured: string | undefined,
  pageLocation?: A2APageLocation,
): string | undefined {
  const value = configured?.trim();
  const mode = value?.toLowerCase() || "same-origin";
  if (mode === "same-origin") {
    return pageLocation === undefined ? undefined : sameOriginA2AUrl(pageLocation.origin);
  }
  if (mode === "auto") {
    return pageLocation === undefined ? undefined : a2aUrlForHostname(pageLocation.hostname);
  }
  return value;
}

function parseServiceCapabilities(value: unknown): AssayServiceCapabilities {
  if (typeof value !== "object" || value === null) {
    throw new Error("The Assay capabilities response must be an object");
  }
  const capabilities = value as Record<string, unknown>;
  if (
    capabilities.skill !== "audit_strategy" ||
    capabilities.dataProvider !== "PandaData" ||
    capabilities.backtester !== "assay-backtester@1" ||
    typeof capabilities.dataCredentialsConfigured !== "boolean" ||
    !Array.isArray(capabilities.dataTools) ||
    !capabilities.dataTools.every((tool) => typeof tool === "string" && tool.length > 0)
  ) {
    throw new Error("The Assay capabilities response is invalid");
  }
  return {
    skill: capabilities.skill,
    dataProvider: capabilities.dataProvider,
    dataTools: capabilities.dataTools,
    backtester: capabilities.backtester,
    dataCredentialsConfigured: capabilities.dataCredentialsConfigured,
  };
}

function configuredA2AUrl(): string | undefined {
  const environment = (
    import.meta as ImportMeta & {
      readonly env?: Readonly<Record<string, string | undefined>>;
    }
  ).env;
  return resolveA2AUrl(environment?.VITE_A2A_URL, globalThis.location);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("The A2A base URL must not be empty");
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The A2A base URL must use HTTP or HTTPS");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("The A2A base URL must not include a query string or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function taskFromSendResult(result: SendMessageResult): Task {
  if ("id" in result) {
    return result;
  }
  throw new Error("The A2A server did not return a Task for the non-blocking request");
}

function waitForPollInterval(durationMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, durationMs);
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export function extractAuditArtifact(task: Task): AuditArtifact | undefined {
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.mediaType === "application/json" && part.content?.$case === "data") {
        return parseAuditArtifact(part.content.value);
      }
    }
  }
  return undefined;
}

export class AssayA2AClient {
  readonly #client: Client;
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  private constructor(client: Client, origin: string, fetchImpl: typeof fetch) {
    this.#client = client;
    this.#origin = origin;
    this.#fetch = fetchImpl;
  }

  static async create(options: CreateAssayA2AClientOptions = {}): Promise<AssayA2AClient> {
    const baseUrl = normalizeBaseUrl(options.baseUrl ?? configuredA2AUrl() ?? DEFAULT_A2A_URL);
    const baseFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = (input, init) =>
      baseFetch(input, {
        ...init,
        credentials: init?.credentials ?? "include",
      });
    const agentCard = await new DefaultAgentCardResolver({ fetchImpl }).resolve(
      new URL(baseUrl).origin,
    );
    const transport = await new RestTransportFactory({ fetchImpl }).create(baseUrl, agentCard);
    return new AssayA2AClient(
      new Client(transport, agentCard, {
        polling: true,
        acceptedOutputModes: [...ACCEPTED_OUTPUT_MODES],
      }),
      new URL(baseUrl).origin,
      fetchImpl,
    );
  }

  async getCapabilities(options: { signal?: AbortSignal } = {}): Promise<AssayServiceCapabilities> {
    const response = await this.#fetch(`${this.#origin}/capabilities`, {
      headers: {
        Accept: "application/json",
      },
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Assay capabilities request failed with status ${response.status}`);
    }
    return parseServiceCapabilities(await response.json());
  }

  async sendTextMessage(input: string, options: SendTextMessageOptions = {}): Promise<Task> {
    const text = input.trim();
    if (text.length === 0) {
      throw new Error("A strategy description is required");
    }

    const request = {
      tenant: "",
      message: {
        messageId: options.messageId ?? crypto.randomUUID(),
        contextId: "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [
          {
            content: {
              $case: "text",
              value: text,
            },
            metadata: {},
            filename: "",
            mediaType: "text/plain",
          },
        ],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [...ACCEPTED_OUTPUT_MODES],
        taskPushNotificationConfig: undefined,
        historyLength: DEFAULT_HISTORY_LENGTH,
        returnImmediately: true,
      },
      metadata: {},
    } satisfies SendMessageRequest;

    return taskFromSendResult(
      await this.#client.sendMessage(request, {
        signal: options.signal,
      }),
    );
  }

  getTask(taskId: string, options: GetTaskOptions = {}): Promise<Task> {
    const id = taskId.trim();
    if (id.length === 0) {
      throw new Error("A task id is required");
    }
    const historyLength =
      options.historyLength === undefined
        ? DEFAULT_HISTORY_LENGTH
        : requireNonNegativeInteger(options.historyLength, "historyLength");

    return this.#client.getTask(
      {
        tenant: "",
        id,
        historyLength,
      },
      {
        signal: options.signal,
      },
    );
  }

  cancelTask(taskId: string, options: CancelTaskOptions = {}): Promise<Task> {
    const id = taskId.trim();
    if (id.length === 0) {
      throw new Error("A task id is required");
    }
    return this.#client.cancelTask(
      {
        tenant: "",
        id,
        metadata: {},
      },
      {
        signal: options.signal,
      },
    );
  }

  async pollTask(taskId: string, options: PollTaskOptions = {}): Promise<Task> {
    const intervalMs =
      options.intervalMs === undefined
        ? DEFAULT_POLL_INTERVAL_MS
        : requireNonNegativeInteger(options.intervalMs, "intervalMs");
    const timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_POLL_TIMEOUT_MS
        : requirePositiveInteger(options.timeoutMs, "timeoutMs");
    const startedAt = Date.now();
    const requestOptions: RequestOptions = {
      signal: options.signal,
    };
    let task = await this.getTask(taskId, options);

    while (!STOP_POLLING_STATES.has(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new Error(`Timed out waiting for A2A task ${task.id}`);
      }
      await waitForPollInterval(Math.min(intervalMs, timeoutMs - elapsedMs), options.signal);
      task = await this.#client.getTask(
        {
          tenant: "",
          id: task.id,
          historyLength: options.historyLength ?? DEFAULT_HISTORY_LENGTH,
        },
        requestOptions,
      );
    }

    return task;
  }
}

export function createAssayA2AClient(
  options: CreateAssayA2AClientOptions = {},
): Promise<AssayA2AClient> {
  return AssayA2AClient.create(options);
}
