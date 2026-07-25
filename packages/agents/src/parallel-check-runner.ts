import type {
  AuditCheckAgentRequest,
  AuditCheckId,
  AuditCheckResult,
  ParallelAuditChecksRequest,
  ParallelAuditChecksResult,
  RuntimeTaskRequest,
  RuntimeTaskResult,
} from "@assay/contracts";
import {
  AUDIT_CHECK_HARD_DEADLINE_MS,
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  parseAuditCheckResult,
} from "@assay/contracts";
import { assertHostDataRef } from "./data-ref";
import {
  planDiscriminativeMoireExperiments,
  planReviewMoireExperiments,
  synthesizeDiscriminativeMoire,
  type DiscriminativeMoireExperiment,
  type DiscriminativeMoireOutcome,
  type DiscriminativeMoirePlanningContext,
  type MoireExperiment,
} from "./moire";

export const HARD_CHECK_DEADLINE_MS = AUDIT_CHECK_HARD_DEADLINE_MS;
const DEFAULT_CHECK_TIMEOUT_MS = HARD_CHECK_DEADLINE_MS;
const CHECK_EXECUTION_FAILURE_REASON = "Check execution failed before a valid result was produced.";
const CHECK_SUBMISSION_FAILURE_REASON =
  "Check agent did not complete one valid submit_check_result call within two attempts.";
const CHECK_OUTPUT_INVALID_SCHEMA_REASON =
  "Check agent completed but its JSON did not satisfy the frozen check-result schema.";
const CHECK_OUTPUT_HOST_FIELD_REASON =
  "Check agent completed but attempted to write a host-only result field.";

export interface AuditCheckTaskRunner {
  run(request: RuntimeTaskRequest, options?: { signal?: AbortSignal }): Promise<RuntimeTaskResult>;
}

export interface ParallelCheckRunOptions {
  signal?: AbortSignal;
}

export interface ParallelAuditCheckRunnerOptions {
  defaultTimeoutMs?: number;
  /** @deprecated Retained as an alias for enableReviewMoire. */
  enableMoire?: boolean;
  enableReviewMoire?: boolean;
  enableDiscriminativeMoire?: boolean;
  moireExecutor?: MoireExperimentExecutor;
  moirePlanningContext?: DiscriminativeMoirePlanningContext;
}

export interface MoireExperimentExecutionContext {
  readonly auditId: string;
  readonly traceId: string;
  readonly subjectId: string;
  readonly dataRef: string;
  readonly frozenStrategySpec?: string;
  readonly specHash?: string;
}

export interface MoireExperimentExecutor {
  execute(
    experiment: DiscriminativeMoireExperiment,
    context: MoireExperimentExecutionContext,
  ): Promise<DiscriminativeMoireOutcome>;
}

type DataBoundParallelAuditChecksRequest = ParallelAuditChecksRequest & {
  readonly metadata: Readonly<Record<string, string>> & {
    readonly dataRef: string;
  };
};

function validateRequest(
  request: ParallelAuditChecksRequest,
): asserts request is DataBoundParallelAuditChecksRequest {
  if (request.schemaVersion !== AUDIT_CHECK_SCHEMA_VERSION) {
    throw new Error("Unsupported check schema version");
  }
  if (!request.auditId.trim()) {
    throw new Error("auditId cannot be empty");
  }
  if (!request.subject.id.trim()) {
    throw new Error("subject.id cannot be empty");
  }
  if (!request.subject.input.trim()) {
    throw new Error("subject.input cannot be empty");
  }
  assertHostDataRef(request.metadata?.dataRef, "Parallel audit");
  if (request.skill === "audit_strategy" && request.subject.kind !== "strategy") {
    throw new Error("audit_strategy requires a strategy subject");
  }
  if (request.skill === "audit_factor" && request.subject.kind !== "factor") {
    throw new Error("audit_factor requires a factor subject");
  }
}

function isApplicable(request: ParallelAuditChecksRequest, checkId: AuditCheckId): boolean {
  if (request.skill === "audit_strategy") {
    return true;
  }
  if (checkId !== "cost-stress") {
    return true;
  }
  return request.subject.hasPortfolioConstruction === true;
}

function notApplicable(checkId: AuditCheckId): AuditCheckResult {
  return {
    id: checkId,
    conclusion: "not_applicable",
    confidence: null,
    evidence: [],
    missingEvidence: [],
  };
}

function insufficientEvidence(
  checkId: AuditCheckId,
  reason = CHECK_EXECUTION_FAILURE_REASON,
): AuditCheckResult {
  return {
    id: checkId,
    conclusion: "insufficient_evidence",
    confidence: 0,
    evidence: [],
    missingEvidence: [
      {
        requirement: `${checkId} check execution`,
        reason,
        sourceRefs: [`runtime-error:${checkId}`],
      },
    ],
  };
}

function isTimeoutFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || /\b(?:deadline|timed?\s*out|timeout)\b/i.test(error.message))
  );
}

function buildAgentInput(
  request: AuditCheckAgentRequest,
  followUp?: {
    experiment: MoireExperiment;
    originalResult: AuditCheckResult;
  },
): string {
  const lines = [
    "执行下面 JSON 中分配的单项审计。只使用你自己的工具和该请求内容；",
    "不得引用或推测其他检查结果。严格按 system prompt 的 submit_check_result 契约交卷。",
    JSON.stringify(request),
  ];
  if (followUp) {
    lines.push(
      "这是 Moiré 判别性跟进。你只能复核自己的原始结果，不会看到其他检查证据。",
      JSON.stringify({
        experimentId: followUp.experiment.id,
        instruction: followUp.experiment.instruction,
        originalResult: followUp.originalResult,
      }),
    );
  }
  return lines.join("\n");
}

/**
 * Main-agent boundary for the five independent checks.
 *
 * All applicable calls are started together with Promise.all. Each receives
 * only AuditCheckAgentRequest, never sibling output. Failures are converted
 * into insufficient_evidence so one branch cannot cancel successful siblings.
 */
export class ParallelAuditCheckRunner {
  readonly #taskRunner: AuditCheckTaskRunner;
  readonly #defaultTimeoutMs: number;
  readonly #enableReviewMoire: boolean;
  readonly #enableDiscriminativeMoire: boolean;
  readonly #moireExecutor?: MoireExperimentExecutor;
  readonly #moirePlanningContext: DiscriminativeMoirePlanningContext;

  constructor(
    taskRunner: AuditCheckTaskRunner,
    options: number | ParallelAuditCheckRunnerOptions = {},
  ) {
    const normalizedOptions = typeof options === "number" ? { defaultTimeoutMs: options } : options;
    const defaultTimeoutMs = normalizedOptions.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new Error("defaultTimeoutMs must be greater than zero");
    }
    this.#taskRunner = taskRunner;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#enableReviewMoire =
      normalizedOptions.enableReviewMoire === true || normalizedOptions.enableMoire === true;
    this.#enableDiscriminativeMoire = normalizedOptions.enableDiscriminativeMoire === true;
    this.#moireExecutor = normalizedOptions.moireExecutor;
    this.#moirePlanningContext = normalizedOptions.moirePlanningContext ?? {};
    if (this.#enableReviewMoire && this.#enableDiscriminativeMoire) {
      throw new Error("Review-style and discriminative Moiré cannot be enabled together");
    }
    if (this.#enableDiscriminativeMoire && this.#moireExecutor === undefined) {
      throw new Error("Discriminative Moiré requires a host experiment executor");
    }
  }

  async run(
    request: ParallelAuditChecksRequest,
    options: ParallelCheckRunOptions = {},
  ): Promise<ParallelAuditChecksResult> {
    validateRequest(request);
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Parallel checks aborted before start");
    }

    const startedAt = new Date().toISOString();
    const traceId = request.traceId ?? crypto.randomUUID();
    const independentChecks = await Promise.all(
      AUDIT_CHECK_IDS.map((checkId) => {
        if (!isApplicable(request, checkId)) {
          return Promise.resolve(notApplicable(checkId));
        }
        return this.#runOne(request, checkId, traceId, options.signal);
      }),
    );
    const checks = this.#enableDiscriminativeMoire
      ? await this.#runDiscriminativeMoire(request, traceId, independentChecks)
      : this.#enableReviewMoire
        ? await this.#runReviewMoire(request, traceId, independentChecks, options.signal)
        : independentChecks;

    return {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: request.auditId,
      subjectId: request.subject.id,
      traceId,
      checks,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  async #runReviewMoire(
    request: DataBoundParallelAuditChecksRequest,
    traceId: string,
    independentChecks: readonly AuditCheckResult[],
    signal?: AbortSignal,
  ): Promise<readonly AuditCheckResult[]> {
    const experiments = planReviewMoireExperiments(independentChecks);
    const refinements = await Promise.all(
      experiments.map(async (experiment) => {
        const originalResult = independentChecks.find((check) => check.id === experiment.checkId);
        if (!originalResult) {
          throw new Error(`Moiré selected unknown check "${experiment.checkId}"`);
        }
        const result = await this.#runOne(request, experiment.checkId, traceId, signal, {
          experiment,
          originalResult,
        });
        return {
          ...result,
          refinedByMoire: experiment.id,
        };
      }),
    );
    const refinementsById = new Map(refinements.map((check) => [check.id, check]));
    return independentChecks.map((check) => refinementsById.get(check.id) ?? check);
  }

  async #runDiscriminativeMoire(
    request: DataBoundParallelAuditChecksRequest,
    traceId: string,
    independentChecks: readonly AuditCheckResult[],
  ): Promise<readonly AuditCheckResult[]> {
    const executor = this.#moireExecutor;
    if (executor === undefined) {
      throw new Error("Discriminative Moiré executor is unavailable");
    }
    const experiments = planDiscriminativeMoireExperiments(
      independentChecks,
      this.#moirePlanningContext,
    );
    const context: MoireExperimentExecutionContext = {
      auditId: request.auditId,
      traceId,
      subjectId: request.subject.id,
      dataRef: request.metadata.dataRef,
      ...(request.skill === "audit_strategy" ? { frozenStrategySpec: request.subject.input } : {}),
      ...(request.metadata?.specHash === undefined ? {} : { specHash: request.metadata.specHash }),
    };
    const refinements = await Promise.all(
      experiments.map(async (experiment) => {
        try {
          const outcome = await executor.execute(experiment, context);
          const synthesis = synthesizeDiscriminativeMoire(experiment, outcome);
          return {
            checkId: experiment.checkId,
            refinedByMoire: synthesis.refinedByMoire,
          };
        } catch {
          return {
            checkId: experiment.checkId,
            refinedByMoire:
              `[${experiment.id}][unresolved] 判别实验未完成，` + "该矛盾仍可能改变最终判决。",
          };
        }
      }),
    );
    const refinementsById = new Map<AuditCheckId, string>(
      refinements.map((refinement) => [refinement.checkId, refinement.refinedByMoire]),
    );
    return independentChecks.map((check) => {
      const refinedByMoire = refinementsById.get(check.id);
      return refinedByMoire === undefined ? check : { ...check, refinedByMoire };
    });
  }

  async #runOne(
    request: DataBoundParallelAuditChecksRequest,
    checkId: AuditCheckId,
    traceId: string,
    signal?: AbortSignal,
    followUp?: {
      experiment: MoireExperiment;
      originalResult: AuditCheckResult;
    },
  ): Promise<AuditCheckResult> {
    const budget = request.budgets?.[checkId];
    const timeoutMs = Math.min(budget?.timeoutMs ?? this.#defaultTimeoutMs, HARD_CHECK_DEADLINE_MS);
    const agentRequest: AuditCheckAgentRequest = {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: request.auditId,
      checkId,
      skill: request.skill,
      subject: request.subject,
      ...(request.dataAsOf === undefined ? {} : { dataAsOf: request.dataAsOf }),
      ...(budget === undefined ? {} : { budget }),
    };

    let result: RuntimeTaskResult;
    try {
      result = await this.#taskRunner.run(
        {
          id: `${request.auditId}:${checkId}`,
          traceId,
          agentId: checkId,
          input: buildAgentInput(agentRequest, followUp),
          timeoutMs,
          metadata: {
            ...request.metadata,
            dataRef: request.metadata.dataRef,
            auditId: request.auditId,
            subjectId: request.subject.id,
            checkId,
            ...(request.skill === "audit_strategy"
              ? { frozenStrategySpec: request.subject.input }
              : {}),
          },
        },
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      return insufficientEvidence(
        checkId,
        isTimeoutFailure(error)
          ? `Check exceeded its ${String(timeoutMs)}ms deadline before producing a valid result.`
          : CHECK_EXECUTION_FAILURE_REASON,
      );
    }

    if (result.auditCheckResult === undefined) {
      return insufficientEvidence(checkId, CHECK_SUBMISSION_FAILURE_REASON);
    }
    let parsed: AuditCheckResult;
    try {
      parsed = parseAuditCheckResult(result.auditCheckResult, checkId);
    } catch {
      return insufficientEvidence(checkId, CHECK_OUTPUT_INVALID_SCHEMA_REASON);
    }
    if (parsed.refinedByMoire !== undefined) {
      return insufficientEvidence(checkId, CHECK_OUTPUT_HOST_FIELD_REASON);
    }
    return parsed;
  }
}
