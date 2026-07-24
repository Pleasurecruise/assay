import { TaskState, type AgentCard } from "@a2a-js/sdk";
import { createEarlyExitAuditArtifact } from "@assay/contracts/audit-artifact";
import { describe, expect, test } from "vitest";
import { createAssayA2AClient, extractAuditArtifact } from "./a2a-client";

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
