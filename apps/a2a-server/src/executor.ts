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
  type AuditCheckId,
  type AuditVerdict,
  type CheckConclusion,
  type MissingEvidence,
} from "@assay/contracts";
import { DeterministicStrategyDataPlanner, type StrategyDataPlanner } from "@assay/finance-tools";
import { type StrategyIntakeResult } from "@assay/intake";
import {
  buildExecutedAuditArtifact,
  projectFrozenAuditInput,
  type AuditExecutionIdentity,
  type ParallelAuditRunner,
} from "./audit-orchestrator";
import type { AuditArtifactStore } from "./artifact-store";
import type { ClaimReproducer } from "./claim-reproducer";
import {
  classifyExecutionTimelineFailure,
  type ExecutionTimelineEvent,
  type ExecutionTimelineLogger,
  type ExecutionTimelineStage,
} from "./execution-timeline";

export interface StrategyIntakePort {
  intakeText(input: string, signal?: AbortSignal): Promise<StrategyIntakeResult>;
}

export interface LocalDataResolverPort {
  resolve(
    plan: ReturnType<StrategyDataPlanner["plan"]>,
    auditId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly dataRef: string;
    readonly sources: readonly string[];
    readonly packageId?: string;
  }>;
}

export interface AssayAgentExecutorOptions {
  intake: StrategyIntakePort;
  runner: ParallelAuditRunner;
  dataResolver: LocalDataResolverPort;
  dataPlanner?: StrategyDataPlanner;
  claimReproducer?: ClaimReproducer;
  artifactStore: AuditArtifactStore;
  dataAsOf: string;
  codeRevision: string;
  now?: () => Date;
  executionErrorLogger?: ExecutionErrorLogger;
  executionTimelineLogger?: ExecutionTimelineLogger;
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

const VERDICT_LABELS_ZH: Record<AuditVerdict, string> = {
  KEEP: "保留",
  WATCH: "观察",
  QUARANTINE: "隔离",
  RETIRE: "退役",
  UNVERIFIABLE: "不可验证",
};

const CHECK_LABELS_ZH: Record<AuditCheckId, string> = {
  "param-robustness": "参数稳健性",
  "data-availability": "数据可得性",
  "cost-stress": "成本压力",
  "regime-dependency": "行情依赖",
  "homogeneity-decay": "同质化衰减",
};

const CONCLUSION_LABELS_ZH: Record<CheckConclusion, string> = {
  pass: "通过",
  pass_with_reservations: "有保留通过",
  fail: "不通过",
  insufficient_evidence: "证据不足",
  not_applicable: "不适用",
};

const CLAIM_METRIC_ROWS = [
  ["annualReturn", "年化收益 Annual return"],
  ["sharpe", "夏普 Sharpe"],
  ["maxDrawdown", "最大回撤 Max drawdown"],
] as const;

const NOT_AVAILABLE = "暂缺 not available";

function formatConfidence(confidence: number | null): string {
  return confidence === null ? NOT_AVAILABLE : confidence.toFixed(2);
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

/**
 * Deterministic bilingual (zh/en) rendering of the audit Artifact. Every
 * number is quoted verbatim from the validated Artifact JSON — no model is
 * involved and no value is restated in prose, so the Markdown can never
 * disagree with the DataPart.
 */
function renderAuditArtifactMarkdown(auditArtifact: AuditArtifact): string {
  const result = auditArtifact.results[0];
  if (result === undefined) {
    throw new Error("A strategy audit Artifact must contain one result");
  }

  const lines = [
    "# Assay 策略审计报告 | Strategy Audit Report",
    "",
    `- 审计编号 Audit ID: \`${auditArtifact.auditId}\``,
    `- 审计对象 Subject ID: \`${result.subjectId}\``,
    `- **判定 Verdict: ${result.verdict}（${VERDICT_LABELS_ZH[result.verdict]}）**`,
    `- 置信度 Confidence: ${formatConfidence(result.confidence)}`,
    ...(result.reasonCode === undefined
      ? []
      : [`- 提前退出原因 Early-exit reason: \`${result.reasonCode}\``]),
    "",
    "## 结论摘要 Summary",
    "",
    result.summary,
  ];

  if (result.strategySpec !== undefined) {
    lines.push(
      "",
      "## 冻结策略 Frozen StrategySpec",
      "",
      "```json",
      JSON.stringify(result.strategySpec, null, 2),
      "```",
    );
  }
  appendList(lines, "应用默认值 Defaults Applied", result.defaultsApplied);
  appendList(lines, "解析假设 Parsing Assumptions", result.parsingAssumptions);

  if (auditArtifact.claimComparison !== null) {
    const { claimed, reproduced, gaps } = auditArtifact.claimComparison;
    lines.push(
      "",
      "## 申报复算 Claim Comparison",
      "",
      "| 指标 Metric | 申报 Claimed | 复算 Reproduced | 偏差 Gap (claimed − reproduced) |",
      "| --- | --- | --- | --- |",
    );
    for (const [key, label] of CLAIM_METRIC_ROWS) {
      if (claimed[key] === undefined) {
        continue;
      }
      lines.push(
        `| ${label} | ${String(claimed[key])} | ${String(reproduced[key])} | ${String(gaps[key])} |`,
      );
    }
    appendList(
      lines,
      "已知口径差异 Known Convention Differences",
      auditArtifact.claimComparison.knownConventionDiffs,
    );
  }

  lines.push("", "## 五项检查 Checks");
  for (const check of result.checks) {
    lines.push(
      "",
      `### ${CHECK_LABELS_ZH[check.id]} ${check.id}`,
      "",
      `- 结论 Conclusion: \`${check.conclusion}\`（${CONCLUSION_LABELS_ZH[check.conclusion]}）`,
      `- 置信度 Confidence: ${formatConfidence(check.confidence)}`,
    );
    for (const evidence of check.evidence) {
      lines.push(
        `- 证据 Evidence: ${evidence.metric} = ${String(evidence.value)} ${evidence.unit} (${evidence.sourceRefs.join(", ")})`,
      );
    }
    for (const missing of check.missingEvidence) {
      lines.push(
        `- 缺失证据 Missing evidence: ${missing.requirement} — ${missing.reason} (${missing.sourceRefs.join(", ")})`,
      );
    }
  }

  appendList(
    lines,
    "缺失信息 Missing Information",
    result.missingInformation?.map(
      (item) => `${item.requirement} — ${item.reason} (${item.sourceRefs.join(", ")})`,
    ),
  );
  appendList(
    lines,
    "恢复条件 Recovery Conditions",
    result.recoveryConditions.map((item) => `${item.scope}: ${item.condition}`),
  );
  appendList(lines, "复审触发 Review Triggers", result.reviewTriggers);
  appendList(lines, "假设与边界 Assumptions and Limits", result.assumptionsAndLimits);
  lines.push(
    "",
    "## 溯源 Provenance",
    "",
    `- 输入哈希 Input hash: \`${auditArtifact.provenance.inputHash}\``,
    `- 数据截至 Data as of: \`${auditArtifact.provenance.dataAsOf}\``,
    `- 代码版本 Code revision: \`${auditArtifact.provenance.codeRevision}\``,
  );
  appendList(
    lines,
    "数据来源 Data Sources",
    auditArtifact.provenance.dataSources.map((source) => `\`${source.id}\` @ ${source.version}`),
  );
  appendList(lines, "风险披露 Risk Disclosure", auditArtifact.riskDisclosure);
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
  readonly #dataResolver: LocalDataResolverPort;
  readonly #dataPlanner: StrategyDataPlanner;
  readonly #claimReproducer: ClaimReproducer | undefined;
  readonly #artifactStore: AuditArtifactStore;
  readonly #dataAsOf: string;
  readonly #codeRevision: string;
  readonly #now: () => Date;
  readonly #executionErrorLogger: ExecutionErrorLogger;
  readonly #executionTimelineLogger: ExecutionTimelineLogger | undefined;
  readonly #activeExecutions = new Map<
    string,
    {
      contextId: string;
      controller: AbortController;
    }
  >();

  constructor(options: AssayAgentExecutorOptions) {
    this.#intake = options.intake;
    this.#runner = options.runner;
    this.#dataResolver = options.dataResolver;
    this.#dataPlanner = options.dataPlanner ?? new DeterministicStrategyDataPlanner();
    this.#claimReproducer = options.claimReproducer;
    this.#artifactStore = options.artifactStore;
    this.#dataAsOf = options.dataAsOf;
    this.#codeRevision = options.codeRevision;
    this.#now = options.now ?? (() => new Date());
    this.#executionErrorLogger = options.executionErrorLogger ?? logExecutionErrorToStderr;
    this.#executionTimelineLogger = options.executionTimelineLogger;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const controller = new AbortController();
    const identity: AuditExecutionIdentity = {
      auditId: `audit_${taskId}`,
      subjectId: `strategy_${taskId}`,
      traceId: crypto.randomUUID(),
    };
    const startedAt = this.#now().toISOString();
    let currentStage: ExecutionTimelineStage = "a2a_acceptance";
    const emitTimeline = (event: ExecutionTimelineEvent): void => {
      try {
        this.#executionTimelineLogger?.(event);
      } catch {
        // Timing diagnostics must never change the Task lifecycle.
      }
    };
    const runStage = async <Result>(
      stage: ExecutionTimelineStage,
      operation: () => Result | Promise<Result>,
    ): Promise<Result> => {
      currentStage = stage;
      const base = {
        traceId: identity.traceId,
        taskId,
        stage,
      };
      emitTimeline({ ...base, type: "stage.started" });
      try {
        const result = await operation();
        emitTimeline({ ...base, type: "stage.completed" });
        return result;
      } catch (error) {
        emitTimeline({
          ...base,
          type: "stage.failed",
          failure: classifyExecutionTimelineFailure(error),
        });
        throw error;
      }
    };

    if (this.#activeExecutions.has(taskId)) {
      const error = new Error(`Task "${taskId}" is already executing`);
      const base = {
        traceId: identity.traceId,
        taskId,
        stage: currentStage,
      };
      emitTimeline({ ...base, type: "stage.started" });
      emitTimeline({
        ...base,
        type: "stage.failed",
        failure: classifyExecutionTimelineFailure(error),
      });
      throw error;
    }

    try {
      await runStage("a2a_acceptance", () => {
        this.#activeExecutions.set(taskId, { contextId, controller });
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
      });
    } catch (error) {
      const active = this.#activeExecutions.get(taskId);
      if (active?.controller === controller) {
        this.#activeExecutions.delete(taskId);
      }
      throw error;
    }

    try {
      const decoded = await runStage("skeleton_decode", () =>
        extractSkeletonInput(requestContext.userMessage),
      );
      let validatedArtifact: AuditArtifact;
      if (decoded.kind === "early_exit") {
        validatedArtifact = await runStage("artifact_finalize", () =>
          parseAuditArtifact(
            createEarlyExitAuditArtifact({
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
            }),
          ),
        );
      } else {
        const intakeResult = await runStage("strategy_intake", () =>
          this.#intake.intakeText(decoded.text, controller.signal),
        );
        if (intakeResult.kind === "early_exit") {
          validatedArtifact = await runStage("artifact_finalize", () =>
            parseAuditArtifact(
              createEarlyExitAuditArtifact({
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
                    condition:
                      "Resubmit a supported strategy with every required StrategySpec field.",
                  },
                ],
                provenance: {
                  inputHash: sha256Text(decoded.text),
                  dataAsOf: this.#dataAsOf,
                  dataSources: [],
                  codeRevision: this.#codeRevision,
                },
              }),
            ),
          );
        } else {
          const dataPlan = await runStage("data_plan", () =>
            this.#dataPlanner.plan(intakeResult.frozen.strategy),
          );
          const preparedData = await runStage("local_data_resolve", () =>
            this.#dataResolver.resolve(dataPlan, identity.auditId, controller.signal),
          );
          const claimComparison = await runStage("claim_reproduction", async () => {
            const comparison =
              this.#claimReproducer === undefined
                ? null
                : await this.#claimReproducer.reproduce(
                    intakeResult.frozen.spec,
                    preparedData.dataRef,
                  );
            controller.signal.throwIfAborted();
            if (intakeResult.frozen.spec.claims !== undefined && comparison === null) {
              throw new Error("Claim reproduction is required when the StrategySpec has claims");
            }
            return comparison;
          });
          const result = await runStage("parallel_audit_handoff", async () => {
            eventBus.publish(
              AgentEvent.statusUpdate({
                taskId,
                contextId,
                status: {
                  state: TaskState.TASK_STATE_WORKING,
                  message: createStatusMessage(
                    taskId,
                    contextId,
                    "Running five independent audit checks with guarded data tools.",
                  ),
                  timestamp: this.#now().toISOString(),
                },
                metadata: {
                  stage: "parallel-audit-checks",
                },
              }),
            );
            const request = projectFrozenAuditInput(
              intakeResult.frozen,
              identity,
              preparedData.dataRef,
            );
            return await this.#runner.run(request, {
              signal: controller.signal,
            });
          });
          validatedArtifact = await runStage("artifact_finalize", () =>
            parseAuditArtifact(
              buildExecutedAuditArtifact({
                frozen: intakeResult.frozen,
                identity,
                result,
                generatedAt: this.#now().toISOString(),
                claimComparison,
                acquisitionSources: preparedData.sources,
              }),
            ),
          );
        }
      }

      await runStage("artifact_persist", async () => {
        controller.signal.throwIfAborted();
        await this.#artifactStore.save(taskId, validatedArtifact);
      });
      await runStage("a2a_publish", () => {
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
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
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
      const failedStatus = {
        state: TaskState.TASK_STATE_FAILED,
        message: createStatusMessage(
          taskId,
          contextId,
          "The audit could not be completed due to an internal error.",
          { correlationId, stage: currentStage },
        ),
        timestamp: startedAt,
      };
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: failedStatus,
          metadata: {
            correlationId,
            stage: currentStage,
          },
        }),
      );
    } finally {
      const active = this.#activeExecutions.get(taskId);
      if (active?.controller === controller) {
        this.#activeExecutions.delete(taskId);
      }
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.#activeExecutions.get(taskId);
    if (!active) {
      throw new Error(`Task "${taskId}" is not running`);
    }
    const reason = new Error("Task canceled by the requester");
    reason.name = "AbortError";
    active.controller.abort(reason);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: active.contextId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: createStatusMessage(
            taskId,
            active.contextId,
            "The audit was canceled by the requester.",
          ),
          timestamp: this.#now().toISOString(),
        },
        metadata: {},
      }),
    );
  }
}
