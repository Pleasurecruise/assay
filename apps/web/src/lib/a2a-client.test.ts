import { TaskState, type AgentCard } from "@a2a-js/sdk";
import { createEarlyExitAuditArtifact } from "@assay/contracts/audit-artifact";
import { describe, expect, test } from "vitest";
import {
  a2aUrlForHostname,
  createAssayA2AClient,
  extractAuditArtifact,
  resolveA2AUrl,
  sameOriginA2AUrl,
} from "./a2a-client";

const BASE_URL = "http://127.0.0.1:3001/a2a";

const AGENT_CARD = {
  name: "Assay Strategy Audit",
  description: "Test card",
  supportedInterfaces: [
    {
      url: BASE_URL,
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
      tenant: "",
    },
  ],
  provider: undefined,
  version: "0.1.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
    extensions: [],
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["application/json", "text/markdown"],
  skills: [],
  signatures: [],
} satisfies AgentCard;

const AUDIT_ARTIFACT = createEarlyExitAuditArtifact({
  auditId: "audit_task_1",
  subjectId: "strategy_task_1",
  generatedAt: "2026-07-24T00:00:00Z",
  summary: "A required strategy field is missing.",
  reasonCode: "insufficient_information",
  missingInformation: [
    {
      requirement: "$.window",
      reason: "start and end are required",
      sourceRefs: ["test:client"],
    },
  ],
  provenance: {
    inputHash: `sha256:${"a".repeat(64)}`,
    dataAsOf: "2026-07-24",
    dataSources: [],
    codeRevision: "test-revision",
  },
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

describe("AssayA2AClient", () => {
  test("builds the A2A URL from LAN, Tailscale, and IPv6 hostnames", () => {
    expect(a2aUrlForHostname("localhost")).toBe("http://localhost:3001/a2a");
    expect(a2aUrlForHostname("100.102.132.89")).toBe("http://100.102.132.89:3001/a2a");
    expect(a2aUrlForHostname("[::1]")).toBe("http://[::1]:3001/a2a");
  });

  test("builds a same-origin A2A URL for the Vite development proxy", () => {
    expect(sameOriginA2AUrl("http://localhost:5173")).toBe("http://localhost:5173/a2a");
    expect(sameOriginA2AUrl("http://100.102.132.89:5173/")).toBe("http://100.102.132.89:5173/a2a");
  });

  test("defaults browser traffic to the same-origin Vite proxy without an env file", () => {
    expect(
      resolveA2AUrl(undefined, {
        origin: "http://localhost:5173",
        hostname: "localhost",
      }),
    ).toBe("http://localhost:5173/a2a");
    expect(
      resolveA2AUrl("auto", {
        origin: "http://100.102.132.89:5173",
        hostname: "100.102.132.89",
      }),
    ).toBe("http://100.102.132.89:3001/a2a");
    expect(
      resolveA2AUrl("https://assay-api.example.com/a2a", {
        origin: "https://assay.example.com",
        hostname: "assay.example.com",
      }),
    ).toBe("https://assay-api.example.com/a2a");
  });

  test("validates the backend tool capabilities response", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/.well-known/agent-card.json")) {
        return jsonResponse(AGENT_CARD);
      }
      return jsonResponse({
        skill: "audit_strategy",
        dataProvider: "PandaData",
        dataTools: ["panda_market_data", "assay_strategy_backtest"],
        backtester: "assay-backtester@1",
        dataCredentialsConfigured: true,
      });
    };
    const client = await createAssayA2AClient({
      baseUrl: BASE_URL,
      fetchImpl,
    });

    await expect(client.getCapabilities()).resolves.toEqual({
      skill: "audit_strategy",
      dataProvider: "PandaData",
      dataTools: ["panda_market_data", "assay_strategy_backtest"],
      backtester: "assay-backtester@1",
      dataCredentialsConfigured: true,
    });
  });

  test("sends an A2A cancellation request for a running task", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      if (url.endsWith("/.well-known/agent-card.json")) {
        return jsonResponse(AGENT_CARD);
      }
      return jsonResponse({
        id: "task_1",
        contextId: "context_1",
        status: {
          state: "TASK_STATE_CANCELED",
          timestamp: "2026-07-24T00:00:01Z",
        },
        artifacts: [],
        history: [],
        metadata: {},
      });
    };
    const client = await createAssayA2AClient({
      baseUrl: BASE_URL,
      fetchImpl,
    });

    const task = await client.cancelTask("task_1");

    expect(task.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3001/.well-known/agent-card.json",
      "http://127.0.0.1:3001/a2a/tasks/task_1:cancel",
    ]);
  });

  test("sends one text Part with returnImmediately explicitly enabled", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      if (url.endsWith("/.well-known/agent-card.json")) {
        return jsonResponse(AGENT_CARD);
      }
      return jsonResponse({
        task: {
          id: "task_1",
          contextId: "context_1",
          status: {
            state: "TASK_STATE_WORKING",
            timestamp: "2026-07-24T00:00:00Z",
          },
          artifacts: [],
          history: [],
          metadata: {},
        },
      });
    };
    const client = await createAssayA2AClient({
      baseUrl: `${BASE_URL}/`,
      fetchImpl,
    });

    const task = await client.sendTextMessage("  Audit the complete strategy.  ", {
      messageId: "message_1",
    });

    expect(task.id).toBe("task_1");
    expect(task.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3001/.well-known/agent-card.json",
      "http://127.0.0.1:3001/a2a/message:send",
    ]);

    const requestBody = calls[1]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("The send request must contain a JSON body");
    }
    const sendBody = JSON.parse(requestBody) as {
      configuration?: { returnImmediately?: boolean };
      message?: {
        messageId?: string;
        role?: string;
        parts?: Array<{ text?: string; mediaType?: string }>;
      };
    };
    expect(sendBody.configuration?.returnImmediately).toBe(true);
    expect(sendBody.message).toEqual(
      expect.objectContaining({
        messageId: "message_1",
        role: "ROLE_USER",
      }),
    );
    expect(sendBody.message?.parts).toHaveLength(1);
    expect(sendBody.message?.parts?.[0]).toEqual(
      expect.objectContaining({
        text: "Audit the complete strategy.",
        mediaType: "text/plain",
      }),
    );
  });

  test("polls tasks/get to a stopped state and validates the contract Artifact", async () => {
    const calls: FetchCall[] = [];
    let taskReadCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      if (url.endsWith("/.well-known/agent-card.json")) {
        return jsonResponse(AGENT_CARD);
      }

      taskReadCount += 1;
      if (taskReadCount === 1) {
        return jsonResponse({
          id: "task_1",
          contextId: "context_1",
          status: {
            state: "TASK_STATE_WORKING",
            timestamp: "2026-07-24T00:00:00Z",
          },
          artifacts: [],
          history: [],
          metadata: {},
        });
      }
      return jsonResponse({
        id: "task_1",
        contextId: "context_1",
        status: {
          state: "TASK_STATE_COMPLETED",
          timestamp: "2026-07-24T00:00:01Z",
        },
        artifacts: [
          {
            artifactId: "artifact_audit_task_1",
            name: "Assay strategy audit",
            description: "Structured Assay verdict.",
            parts: [
              {
                data: AUDIT_ARTIFACT,
                mediaType: "application/json",
                filename: "audit-artifact.json",
                metadata: {},
              },
            ],
            metadata: {},
            extensions: [],
          },
        ],
        history: [],
        metadata: {},
      });
    };
    const client = await createAssayA2AClient({
      baseUrl: BASE_URL,
      fetchImpl,
    });

    const task = await client.pollTask("task_1", {
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(extractAuditArtifact(task)).toEqual(AUDIT_ARTIFACT);
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      "http://127.0.0.1:3001/a2a/tasks/task_1?historyLength=10",
      "http://127.0.0.1:3001/a2a/tasks/task_1?historyLength=10",
    ]);
  });
});
