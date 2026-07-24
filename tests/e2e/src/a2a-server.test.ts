import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TaskState } from "@a2a-js/sdk";
import { type ParallelAuditRunner } from "../../../apps/a2a-server/src/audit-orchestrator";
import { InMemoryAuditArtifactStore } from "../../../apps/a2a-server/src/artifact-store";
import { AssayAgentExecutor, type StrategyIntakePort } from "../../../apps/a2a-server/src/executor";
import { createAssayA2AApp } from "../../../apps/a2a-server/src/server";
import { createAssayA2AClient, extractAuditArtifact } from "../../../apps/web/src/lib/a2a-client";
import {
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  canonicalizeStrategySpec,
  hashStrategySpec,
  parseAuditArtifact,
  type AuditCheckResult,
  type ParallelAuditChecksRequest,
  type ParallelAuditChecksResult,
} from "@assay/contracts";
import { StrategyIntake, type NaturalLanguageStrategyParser } from "@assay/intake";
import { describe, expect, test } from "vitest";

const GENERATED_AT = "2026-07-24T04:00:00.000Z";
const DATA_AS_OF = "2026-07-24";
const CORS_ORIGIN = "http://localhost:5173";

const COMPLETE_SPEC = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 50, weighting: "equal" },
  rebalance: { frequency: "monthly", at: "close" },
  window: { start: "20210101", end: "20251231" },
  costs: { model: "standard" },
} as const;

interface WireTask {
  id: string;
  status?: {
    state?: string;
  };
  artifacts?: Array<{
    parts?: Array<{
      data?: unknown;
      text?: string;
      mediaType?: string;
    }>;
  }>;
}

interface WireSendMessageResponse {
  task?: WireTask;
}

type TestRunnerFactory = (requests: ParallelAuditChecksRequest[]) => ParallelAuditRunner;

interface TestHarness {
  baseUrl: string;
  store: InMemoryAuditArtifactStore;
  requests: ParallelAuditChecksRequest[];
}

function incompleteSpecWithoutWindow(): unknown {
  const { window: _window, ...withoutWindow } = COMPLETE_SPEC;
  return withoutWindow;
}

function fakeParser(candidate: unknown, calls: string[]): NaturalLanguageStrategyParser {
  return {
    async parse(input) {
      calls.push(input);
      return structuredClone(candidate);
    },
  };
}

function insufficientEvidence(id: (typeof AUDIT_CHECK_IDS)[number]): AuditCheckResult {
  return {
    id,
    conclusion: "insufficient_evidence",
    confidence: 0,
    evidence: [],
    missingEvidence: [
      {
        requirement: `${id} data tools`,
        reason: "The deterministic E2E runner has no live data tools.",
        sourceRefs: [`fixture:e2e/${id}`],
      },
    ],
  };
}

function fakeRunner(requests: ParallelAuditChecksRequest[]): ParallelAuditRunner {
  return {
    async run(request): Promise<ParallelAuditChecksResult> {
      requests.push(structuredClone(request));
      return {
        schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
        auditId: request.auditId,
        subjectId: request.subject.id,
        traceId: request.traceId ?? "missing-trace",
        checks: AUDIT_CHECK_IDS.map(insufficientEvidence),
        startedAt: GENERATED_AT,
        completedAt: GENERATED_AT,
      };
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function withTestServer(
  intake: StrategyIntakePort,
  run: (harness: TestHarness) => Promise<void>,
  runnerFactory: TestRunnerFactory = fakeRunner,
): Promise<void> {
  const store = new InMemoryAuditArtifactStore();
  const requests: ParallelAuditChecksRequest[] = [];
  const executor = new AssayAgentExecutor({
    intake,
    runner: runnerFactory(requests),
    artifactStore: store,
    dataAsOf: DATA_AS_OF,
    codeRevision: "e2e-fixture",
    now: () => new Date(GENERATED_AT),
  });
  const { app } = createAssayA2AApp({
    executor,
    publicUrl: "http://127.0.0.1",
    corsOrigins: [CORS_ORIGIN],
    capabilities: {
      skill: "audit_strategy",
      dataProvider: "PandaData",
      dataTools: ["panda_market_data", "assay_strategy_backtest"],
      backtester: "assay-backtester@1",
      dataCredentialsConfigured: true,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      requests,
    });
  } finally {
    await closeServer(server);
  }
}

async function sendStrategy(
  baseUrl: string,
  messageId: string,
  text: string,
  returnImmediately = false,
): Promise<WireTask> {
  const response = await fetch(`${baseUrl}/a2a/v1/message:send`, {
    method: "POST",
    headers: {
      "A2A-Version": "1.0",
      Origin: CORS_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        messageId,
        role: "ROLE_USER",
        parts: [{ text, mediaType: "text/plain" }],
      },
      configuration: {
        acceptedOutputModes: ["application/json", "text/markdown"],
        historyLength: 10,
        returnImmediately,
      },
    }),
  });
  expect(response.headers.get("access-control-allow-origin")).toBe(CORS_ORIGIN);
  const body = (await response.json()) as WireSendMessageResponse;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  expect(body.task).toBeDefined();
  return body.task as WireTask;
}

function artifactFrom(task: WireTask) {
  expect(task.status?.state).toBe("TASK_STATE_COMPLETED");
  expect(task.artifacts).toHaveLength(1);
  const data = task.artifacts?.[0]?.parts?.find(
    (part) => part.mediaType === "application/json",
  )?.data;
  expect(data).toBeDefined();
  return parseAuditArtifact(data);
}

describe("Assay A2A Skeleton over HTTP+JSON", () => {
  test("drives the browser client from CORS preflight through a parsed Artifact", async () => {
    const input =
      "Audit a CSI 300 strategy from 20210101 through 20251231: rank by trailing " +
      "20-day momentum, hold the top 50 equal-weighted names, rebalance monthly " +
      "at close, and use standard costs.";
    const parserCalls: string[] = [];
    const intake = new StrategyIntake({
      parser: fakeParser(COMPLETE_SPEC, parserCalls),
      dataAsOf: DATA_AS_OF,
      capabilitySnapshotId: "e2e:static",
      codeRevision: "e2e-fixture",
    });

    await withTestServer(intake, async ({ baseUrl, requests, store }) => {
      const capabilitiesResponse = await fetch(`${baseUrl}/capabilities`, {
        headers: { Origin: CORS_ORIGIN },
      });
      expect(capabilitiesResponse.ok).toBe(true);
      expect(await capabilitiesResponse.json()).toEqual({
        skill: "audit_strategy",
        dataProvider: "PandaData",
        dataTools: ["panda_market_data", "assay_strategy_backtest"],
        backtester: "assay-backtester@1",
        dataCredentialsConfigured: true,
      });
      const readinessResponse = await fetch(`${baseUrl}/readyz`);
      expect(readinessResponse.status).toBe(200);
      expect(await readinessResponse.json()).toEqual({
        status: "ready",
        checks: {
          a2a: true,
          model: true,
          pandaDataCredentials: true,
        },
      });

      const response = await fetch(`${baseUrl}/a2a/message:send`, {
        method: "OPTIONS",
        headers: {
          Origin: CORS_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,a2a-version,a2a-extensions",
          "Access-Control-Request-Private-Network": "true",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(CORS_ORIGIN);
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.get("access-control-allow-methods")?.split(/,\s*/)).toEqual([
        "GET",
        "POST",
        "OPTIONS",
      ]);
      expect(
        response.headers.get("access-control-allow-headers")?.toLowerCase().split(/,\s*/),
      ).toEqual(["content-type", "a2a-version", "a2a-extensions"]);
      expect(response.headers.get("access-control-allow-private-network")).toBe("true");
      expect(await response.text()).toBe("");
      expect(parserCalls).toHaveLength(0);
      expect(requests).toHaveLength(0);

      const deniedResponse = await fetch(`${baseUrl}/a2a/message:send`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://not-the-workbench.example",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(deniedResponse.status).toBe(204);
      expect(deniedResponse.headers.get("access-control-allow-origin")).toBeNull();
      expect(parserCalls).toHaveLength(0);
      expect(requests).toHaveLength(0);

      const client = await createAssayA2AClient({
        baseUrl: `${baseUrl}/a2a`,
      });
      const submittedTask = await client.sendTextMessage(input, {
        messageId: "msg_browser_client",
      });
      expect([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]).toContain(
        submittedTask.status?.state,
      );

      const completedTask = await client.pollTask(submittedTask.id, {
        intervalMs: 5,
        timeoutMs: 3_000,
      });
      const artifact = extractAuditArtifact(completedTask);

      expect(completedTask.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(artifact).toBeDefined();
      expect(artifact?.results[0]?.checks).toHaveLength(AUDIT_CHECK_IDS.length);
      expect(parserCalls).toEqual([input]);
      expect(requests).toHaveLength(1);
      expect(await store.load(submittedTask.id)).toEqual(artifact);
    });
  });

  test("honors returnImmediately with a working Task and background completion", async () => {
    const runnerDelayMs = 500;
    let runnerCompleted = false;
    const input =
      "Audit a CSI 300 strategy from 20210101 through 20251231: rank by trailing " +
      "20-day momentum, hold the top 50 equal-weighted names, rebalance monthly " +
      "at close, and use standard costs.";
    const intake = new StrategyIntake({
      parser: fakeParser(COMPLETE_SPEC, []),
      dataAsOf: DATA_AS_OF,
      capabilitySnapshotId: "e2e:static",
      codeRevision: "e2e-fixture",
    });

    await withTestServer(
      intake,
      async ({ baseUrl, store, requests }) => {
        const client = await createAssayA2AClient({
          baseUrl: `${baseUrl}/a2a`,
        });
        const submittedTask = await client.sendTextMessage(input, {
          messageId: "msg_non_blocking",
        });

        expect([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]).toContain(
          submittedTask.status?.state,
        );
        expect(runnerCompleted).toBe(false);

        const completedTask = await client.pollTask(submittedTask.id, {
          intervalMs: 5,
          timeoutMs: 3_000,
        });
        const artifact = extractAuditArtifact(completedTask);

        expect(completedTask.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
        expect(artifact).toBeDefined();
        expect(runnerCompleted).toBe(true);
        expect(requests).toHaveLength(1);
        expect(await store.load(submittedTask.id)).toEqual(artifact);
      },
      (requests) => ({
        async run(request): Promise<ParallelAuditChecksResult> {
          requests.push(structuredClone(request));
          await new Promise<void>((resolve) => {
            setTimeout(resolve, runnerDelayMs);
          });
          runnerCompleted = true;
          return {
            schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
            auditId: request.auditId,
            subjectId: request.subject.id,
            traceId: request.traceId ?? "missing-trace",
            checks: AUDIT_CHECK_IDS.map(insufficientEvidence),
            startedAt: GENERATED_AT,
            completedAt: GENERATED_AT,
          };
        },
      }),
    );
  });

  test("completes a natural-language strategy with a full audit Artifact", async () => {
    const input =
      "Audit a CSI 300 strategy from 20210101 through 20251231: rank by trailing " +
      "20-day momentum, hold the top 50 equal-weighted names, rebalance monthly " +
      "at close, and use standard costs.";
    const parserCalls: string[] = [];
    const intake = new StrategyIntake({
      parser: fakeParser(COMPLETE_SPEC, parserCalls),
      dataAsOf: DATA_AS_OF,
      capabilitySnapshotId: "e2e:static",
      codeRevision: "e2e-fixture",
    });

    await withTestServer(intake, async ({ baseUrl, store, requests }) => {
      const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`, {
        headers: {
          "A2A-Version": "1.0",
          Origin: CORS_ORIGIN,
        },
      });
      const card = (await cardResponse.json()) as {
        skills?: Array<{ id?: string }>;
      };
      expect(cardResponse.ok, JSON.stringify(card)).toBe(true);
      expect(cardResponse.headers.get("access-control-allow-origin")).toBe(CORS_ORIGIN);
      expect(card.skills?.map((skill) => skill.id)).toEqual(["audit_strategy"]);

      const task = await sendStrategy(baseUrl, "msg_complete", input);
      const artifact = artifactFrom(task);

      expect(parserCalls).toEqual([input]);
      expect(requests).toHaveLength(1);
      const strategySpec = artifact.results[0]?.strategySpec;
      expect(strategySpec).toBeDefined();
      if (strategySpec === undefined) {
        throw new Error("Executed Artifact must include its canonical StrategySpec");
      }
      expect(requests[0]?.subject.input).toBe(canonicalizeStrategySpec(strategySpec));
      expect(requests[0]?.metadata?.specHash).toBe(
        hashStrategySpec(requests[0]?.subject.input ?? ""),
      );
      expect(artifact.results[0]?.verdict).toBe("UNVERIFIABLE");
      expect(artifact.results[0]?.reasonCode).toBeUndefined();
      expect(artifact.results[0]?.checks.map((check) => check.conclusion)).toEqual(
        AUDIT_CHECK_IDS.map(() => "insufficient_evidence"),
      );
      expect(await store.load(task.id)).toEqual(artifact);
    });
  });

  test("missing window uses the sprint trailing-three-year default", async () => {
    const input =
      "Audit a CSI 300 monthly 20-day momentum strategy holding the top 50 " +
      "equal-weighted names with standard costs.";
    const parserCalls: string[] = [];
    const intake = new StrategyIntake({
      parser: fakeParser(incompleteSpecWithoutWindow(), parserCalls),
      dataAsOf: DATA_AS_OF,
      capabilitySnapshotId: "e2e:static",
      codeRevision: "e2e-fixture",
    });

    await withTestServer(intake, async ({ baseUrl, store, requests }) => {
      const task = await sendStrategy(baseUrl, "msg_missing_window", input);
      const artifact = artifactFrom(task);
      const result = artifact.results[0];

      expect(parserCalls).toEqual([input]);
      expect(requests).toHaveLength(1);
      expect(result?.verdict).toBe("UNVERIFIABLE");
      expect(result?.reasonCode).toBeUndefined();
      expect(result?.strategySpec?.window).toEqual({
        start: "20230724",
        end: "20260724",
      });
      expect(result?.defaultsApplied).toContain(
        "window=20230724..20260724 (sprint trailing-3y default)",
      );
      expect(result?.checks.every((check) => check.conclusion === "insufficient_evidence")).toBe(
        true,
      );
      expect(await store.load(task.id)).toEqual(artifact);
    });
  });

  test("custom Python factor completes with an unsupported-input early exit", async () => {
    const input = [
      "Audit this CSI 300 factor from 20210101 through 20251231:",
      "```python",
      "def factor(frame):",
      "    return frame.close.pct_change(20)",
      "```",
    ].join("\n");
    const parserCalls: string[] = [];
    const intake = new StrategyIntake({
      parser: fakeParser(COMPLETE_SPEC, parserCalls),
      dataAsOf: DATA_AS_OF,
      capabilitySnapshotId: "e2e:static",
      codeRevision: "e2e-fixture",
    });

    await withTestServer(intake, async ({ baseUrl, store, requests }) => {
      const task = await sendStrategy(baseUrl, "msg_python_factor", input);
      const artifact = artifactFrom(task);
      const result = artifact.results[0];

      expect(parserCalls).toHaveLength(0);
      expect(requests).toHaveLength(0);
      expect(result?.verdict).toBe("UNVERIFIABLE");
      expect(result?.reasonCode).toBe("unsupported_input");
      expect(result?.missingInformation?.some((item) => item.requirement === "/signal")).toBe(true);
      expect(result?.checks.every((check) => check.conclusion === "not_applicable")).toBe(true);
      expect(await store.load(task.id)).toEqual(artifact);
    });
  });
});
