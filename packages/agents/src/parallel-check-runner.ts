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
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  parseAuditCheckResult,
} from "@assay/contracts";
import { planMoireExperiments, type MoireExperiment } from "./moire";

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1_000;
const CHECK_EXECUTION_FAILURE_REASON = "Check execution failed before a valid result was produced.";

export interface AuditCheckTaskRunner {
  run(request: RuntimeTaskRequest, options?: { signal?: AbortSignal }): Promise<RuntimeTaskResult>;
}

export interface ParallelCheckRunOptions {
  signal?: AbortSignal;
}

export interface ParallelAuditCheckRunnerOptions {
  defaultTimeoutMs?: number;
  enableMoire?: boolean;
}

function parseAgentJson(output: string): unknown {
  const unfenced = output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const candidates = [unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep the result contract strict; only strip common presentation wrappers.
    }
  }
  throw new Error("Check agent returned invalid JSON");
}

function validateRequest(request: ParallelAuditChecksRequest): void {
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

function insufficientEvidence(checkId: AuditCheckId): AuditCheckResult {
  return {
    id: checkId,
    conclusion: "insufficient_evidence",
    confidence: 0,
    evidence: [],
    missingEvidence: [
      {
        requirement: `${checkId} check execution`,
        reason: CHECK_EXECUTION_FAILURE_REASON,
        sourceRefs: [`runtime-error:${checkId}`],
      },
    ],
  };
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
    "不得引用或推测其他检查结果。严格按 system prompt 的 JSON 契约输出。",
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
  readonly #enableMoire: boolean;

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
    this.#enableMoire = normalizedOptions.enableMoire === true;
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
    const experiments = this.#enableMoire ? planMoireExperiments(independentChecks) : [];
    const refinements = await Promise.all(
      experiments.map(async (experiment) => {
        const originalResult = independentChecks.find((check) => check.id === experiment.checkId);
        if (!originalResult) {
          throw new Error(`Moiré selected unknown check "${experiment.checkId}"`);
        }
        const result = await this.#runOne(request, experiment.checkId, traceId, options.signal, {
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
    const checks = independentChecks.map((check) => refinementsById.get(check.id) ?? check);

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

  async #runOne(
    request: ParallelAuditChecksRequest,
    checkId: AuditCheckId,
    traceId: string,
    signal?: AbortSignal,
    followUp?: {
      experiment: MoireExperiment;
      originalResult: AuditCheckResult;
    },
  ): Promise<AuditCheckResult> {
    const budget = request.budgets?.[checkId];
    const agentRequest: AuditCheckAgentRequest = {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: request.auditId,
      checkId,
      skill: request.skill,
      subject: request.subject,
      ...(request.dataAsOf === undefined ? {} : { dataAsOf: request.dataAsOf }),
      ...(budget === undefined ? {} : { budget }),
    };

    try {
      const result = await this.#taskRunner.run(
        {
          id: `${request.auditId}:${checkId}`,
          traceId,
          agentId: checkId,
          input: buildAgentInput(agentRequest, followUp),
          timeoutMs: budget?.timeoutMs ?? this.#defaultTimeoutMs,
          metadata: {
            ...request.metadata,
            auditId: request.auditId,
            subjectId: request.subject.id,
            checkId,
            ...(request.skill === "audit_strategy" &&
            (checkId === "param-robustness" ||
              checkId === "data-availability" ||
              checkId === "cost-stress")
              ? { frozenStrategySpec: request.subject.input }
              : {}),
          },
        },
        { signal },
      );
      return parseAuditCheckResult(parseAgentJson(result.output), checkId);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      return insufficientEvidence(checkId);
    }
  }
}
