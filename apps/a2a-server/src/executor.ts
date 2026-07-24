import { createHash } from "node:crypto";
import { Role, TaskState, type Artifact, type Message, type Part, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  AUDIT_ARTIFACT_SCHEMA_VERSION,
  DEFAULT_RISK_DISCLOSURE,
  createEarlyExitAuditArtifact,
  parseAuditArtifact,
  type AuditArtifact,
  type MissingEvidence,
} from "@assay/contracts";
import { type StrategyIntakeResult } from "@assay/intake";
import {
  buildExecutedAuditArtifact,
  projectFrozenAuditInput,
  type AuditExecutionIdentity,
  type ParallelAuditRunner,
} from "./audit-orchestrator";
import type { AuditArtifactStore } from "./artifact-store";

export interface StrategyIntakePort {
  intakeText(input: string, signal?: AbortSignal): Promise<StrategyIntakeResult>;
}

export interface AssayAgentExecutorOptions {
  intake: StrategyIntakePort;
  runner: ParallelAuditRunner;
  artifactStore: AuditArtifactStore;
  dataAsOf: string;
  codeRevision: string;
  now?: () => Date;
  executionErrorLogger?: ExecutionErrorLogger;
}

export interface ExecutionErrorLogEntry {
  correlationId: string;
  taskId: string;
  contextId: string;
  error: unknown;
}

export type ExecutionErrorLogger = (entry: ExecutionErrorLogEntry) => void;

type SkeletonInput =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "early_exit";
      reasonCode: "insufficient_information" | "unsupported_input";
      summary: string;
      inputFingerprint: string;
      missingInformation: readonly MissingEvidence[];
    };

function createTextPart(value: string, mediaType = "text/plain"): Part {
  return {
    content: { $case: "text", value },
    mediaType,
    filename: "",
    metadata: {},
  };
}

function createStatusMessage(
  taskId: string,
  contextId: string,
  text: string,
  metadata: Record<string, string> = {},
): Message {
  return {
    messageId: crypto.randomUUID(),
    taskId,
    contextId,
    role: Role.ROLE_AGENT,
    parts: [createTextPart(text)],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function logExecutionErrorToStderr(entry: ExecutionErrorLogEntry): void {
  const errorType =
    entry.error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(entry.error.name)
      ? entry.error.name
      : "UnknownError";
  process.stderr.write(
    `[assay-a2a] task execution failed correlationId=${entry.correlationId} taskId=${entry.taskId} contextId=${entry.contextId} errorType=${errorType} details=[redacted]\n`,
  );
}

function extractSkeletonInput(message: Message): SkeletonInput {
  const textParts: string[] = [];
  let hasUnsupportedPart = false;
  for (const part of message.parts) {
    if (part.content?.$case === "text") {
      textParts.push(part.content.value);
    } else {
      hasUnsupportedPart = true;
    }
  }

  const text = textParts.join("\n").trim();
  if (hasUnsupportedPart) {
    return {
      kind: "early_exit",
      reasonCode: "unsupported_input",
      summary: "The Skeleton server accepts natural-language text Parts only.",
      inputFingerprint: text,
      missingInformation: [
        {
          requirement: "natural-language text Part",
          reason: "Structured data and file Parts are not supported in the Skeleton phase",
          sourceRefs: ["a2a:message-parts"],
        },
      ],
    };
  }
  if (text.length === 0) {
    return {
      kind: "early_exit",
      reasonCode: "insufficient_information",
      summary: "The audit could not start because no strategy description was provided.",
      inputFingerprint: "",
      missingInformation: [
        {
          requirement: "strategy description",
          reason: "A non-empty natural-language strategy description is required",
          sourceRefs: ["a2a:message-parts"],
        },
      ],
    };
  }
  return { kind: "text", text };
}

function appendList(
  lines: string[],
  heading: string,
  entries: readonly string[] | undefined,
): void {
  if (entries === undefined || entries.length === 0) {
    return;
  }
  lines.push("", `## ${heading}`, "", ...entries.map((entry) => `- ${entry}`));
}

function renderAuditArtifactMarkdown(auditArtifact: AuditArtifact): string {
  const result = auditArtifact.results[0];
  if (result === undefined) {
    throw new Error("A strategy audit Artifact must contain one result");
  }

  const lines = [
    "# Assay Strategy Audit",
    "",
    `- Audit ID: \`${auditArtifact.auditId}\``,
    `- Subject ID: \`${result.subjectId}\``,
    `- Verdict: **${result.verdict}**`,
    `- Confidence: ${result.confidence === null ? "not available" : result.confidence.toFixed(2)}`,
    ...(result.reasonCode === undefined ? [] : [`- Early-exit reason: \`${result.reasonCode}\``]),
    "",
    "## Summary",
    "",
    result.summary,
  ];

  if (result.strategySpec !== undefined) {
    lines.push(
      "",
      "## Frozen StrategySpec",
      "",
      "```json",
      JSON.stringify(result.strategySpec, null, 2),
      "```",
    );
  }
  appendList(lines, "Defaults Applied", result.defaultsApplied);
  appendList(lines, "Parsing Assumptions", result.parsingAssumptions);

  lines.push("", "## Checks");
  for (const check of result.checks) {
    lines.push(
      "",
      `### ${check.id}`,
      "",
      `- Conclusion: \`${check.conclusion}\``,
      `- Confidence: ${check.confidence === null ? "not available" : check.confidence.toFixed(2)}`,
    );
    for (const evidence of check.evidence) {
      lines.push(
        `- Evidence: ${evidence.metric} = ${String(evidence.value)} ${evidence.unit} (${evidence.sourceRefs.join(", ")})`,
      );
    }
    for (const missing of check.missingEvidence) {
      lines.push(
        `- Missing evidence: ${missing.requirement} — ${missing.reason} (${missing.sourceRefs.join(", ")})`,
      );
    }
  }

  appendList(
    lines,
    "Missing Information",
    result.missingInformation?.map(
      (item) => `${item.requirement} — ${item.reason} (${item.sourceRefs.join(", ")})`,
    ),
  );
  appendList(
    lines,
    "Recovery Conditions",
    result.recoveryConditions.map((item) => `${item.scope}: ${item.condition}`),
  );
  appendList(lines, "Review Triggers", result.reviewTriggers);
  appendList(lines, "Assumptions and Limits", result.assumptionsAndLimits);
  lines.push(
    "",
    "## Provenance",
    "",
    `- Input hash: \`${auditArtifact.provenance.inputHash}\``,
    `- Data as of: \`${auditArtifact.provenance.dataAsOf}\``,
    `- Code revision: \`${auditArtifact.provenance.codeRevision}\``,
  );
  appendList(lines, "Risk Disclosure", auditArtifact.riskDisclosure);
  return lines.join("\n");
}

function createA2AArtifact(auditArtifact: AuditArtifact): Artifact {
  const markdown = renderAuditArtifactMarkdown(auditArtifact);

  return {
    artifactId: `artifact_${auditArtifact.auditId}`,
    name: "Assay strategy audit",
    description: "Structured Assay verdict and equivalent Markdown summary.",
    parts: [
      {
        content: {
          $case: "data",
          value: auditArtifact,
        },
        mediaType: "application/json",
        filename: "audit-artifact.json",
        metadata: {
          schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
        },
      },
      createTextPart(markdown, "text/markdown"),
    ],
    metadata: {
      schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
      auditId: auditArtifact.auditId,
    },
    extensions: [],
  };
}

function initialTask(
  taskId: string,
  contextId: string,
  identity: AuditExecutionIdentity,
  timestamp: string,
): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp,
    },
    artifacts: [],
    history: [],
    metadata: {
      auditId: identity.auditId,
      traceId: identity.traceId,
    },
  };
}

export class AssayAgentExecutor implements AgentExecutor {
  readonly #intake: StrategyIntakePort;
  readonly #runner: ParallelAuditRunner;
  readonly #artifactStore: AuditArtifactStore;
  readonly #dataAsOf: string;
  readonly #codeRevision: string;
  readonly #now: () => Date;
  readonly #executionErrorLogger: ExecutionErrorLogger;

  constructor(options: AssayAgentExecutorOptions) {
    this.#intake = options.intake;
    this.#runner = options.runner;
    this.#artifactStore = options.artifactStore;
    this.#dataAsOf = options.dataAsOf;
    this.#codeRevision = options.codeRevision;
    this.#now = options.now ?? (() => new Date());
    this.#executionErrorLogger = options.executionErrorLogger ?? logExecutionErrorToStderr;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const identity: AuditExecutionIdentity = {
      auditId: `audit_${taskId}`,
      subjectId: `strategy_${taskId}`,
      traceId: crypto.randomUUID(),
    };
    const startedAt = this.#now().toISOString();
    eventBus.publish(AgentEvent.task(initialTask(taskId, contextId, identity, startedAt)));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: createStatusMessage(
            taskId,
            contextId,
            "Parsing and validating the strategy input.",
          ),
          timestamp: startedAt,
        },
        metadata: {},
      }),
    );

    try {
      const decoded = extractSkeletonInput(requestContext.userMessage);
      let artifact: AuditArtifact;
      if (decoded.kind === "early_exit") {
        artifact = createEarlyExitAuditArtifact({
          auditId: identity.auditId,
          subjectId: identity.subjectId,
          generatedAt: this.#now().toISOString(),
          summary: decoded.summary,
          reasonCode: decoded.reasonCode,
          missingInformation: decoded.missingInformation,
          riskDisclosure: [DEFAULT_RISK_DISCLOSURE],
          recoveryConditions: [
            {
              scope: "intake",
              condition: "Resubmit a supported, complete natural-language StrategySpec.",
            },
          ],
          provenance: {
            inputHash: sha256Text(decoded.inputFingerprint),
            dataAsOf: this.#dataAsOf,
            dataSources: [],
            codeRevision: this.#codeRevision,
          },
        });
      } else {
        const intakeResult = await this.#intake.intakeText(decoded.text);
        if (intakeResult.kind === "early_exit") {
          artifact = createEarlyExitAuditArtifact({
            auditId: identity.auditId,
            subjectId: identity.subjectId,
            generatedAt: this.#now().toISOString(),
            summary: intakeResult.summary,
            reasonCode: intakeResult.reasonCode,
            missingInformation: intakeResult.missingInformation,
            riskDisclosure: [DEFAULT_RISK_DISCLOSURE],
            recoveryConditions: [
              {
                scope: "intake",
                condition: "Resubmit a supported strategy with every required StrategySpec field.",
              },
            ],
            provenance: {
              inputHash: sha256Text(decoded.text),
              dataAsOf: this.#dataAsOf,
              dataSources: [],
              codeRevision: this.#codeRevision,
            },
          });
        } else {
          const request = projectFrozenAuditInput(intakeResult.frozen, identity);
          const result = await this.#runner.run(request);
          artifact = buildExecutedAuditArtifact({
            frozen: intakeResult.frozen,
            identity,
            result,
            generatedAt: this.#now().toISOString(),
          });
        }
      }

      const validatedArtifact = parseAuditArtifact(artifact);
      await this.#artifactStore.save(taskId, validatedArtifact);
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: createA2AArtifact(validatedArtifact),
          append: false,
          lastChunk: true,
          metadata: {},
        }),
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: createStatusMessage(taskId, contextId, "The audit Artifact is ready."),
            timestamp: this.#now().toISOString(),
          },
          metadata: {},
        }),
      );
    } catch (error) {
      const correlationId = identity.traceId;
      try {
        this.#executionErrorLogger({
          correlationId,
          taskId,
          contextId,
          error,
        });
      } catch {
        // Error reporting must not prevent the Task from reaching a terminal state.
      }
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            message: createStatusMessage(
              taskId,
              contextId,
              "The audit could not be completed due to an internal error.",
              { correlationId },
            ),
            timestamp: startedAt,
          },
          metadata: {
            correlationId,
          },
        }),
      );
    }
  }

  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    throw new Error("Task cancellation is not implemented in the Skeleton phase");
  }
}
