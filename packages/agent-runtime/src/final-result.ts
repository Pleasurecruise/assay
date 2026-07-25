import {
  isAuditCheckId,
  parseAuditCheckResult,
  type AuditCheckId,
  type AuditCheckResult,
} from "@assay/contracts";

export const AUDIT_CHECK_SUBMISSION_TOOL_NAME = "submit_check_result";
export const MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS = 2;

const RESULT_KEYS = ["conclusion", "confidence", "evidence", "missingEvidence"] as const;
const EVIDENCE_KEYS = ["metric", "value", "unit", "sourceRefs"] as const;
const MISSING_EVIDENCE_KEYS = ["requirement", "reason", "sourceRefs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function cloneResult(result: AuditCheckResult): AuditCheckResult {
  return {
    id: result.id,
    conclusion: result.conclusion,
    confidence: result.confidence,
    evidence: result.evidence.map((item) => ({
      metric: item.metric,
      value: item.value,
      unit: item.unit,
      sourceRefs: [...item.sourceRefs],
    })),
    missingEvidence: result.missingEvidence.map((item) => ({
      requirement: item.requirement,
      reason: item.reason,
      sourceRefs: [...item.sourceRefs],
    })),
  };
}

/**
 * Validate the model's pre-coercion finalizer arguments.
 *
 * The agent framework may repair tool arguments before execution. Assay must
 * reject rather than silently normalize an audit conclusion, so this parser is
 * intentionally exact at every object boundary and runs on toolCall.arguments.
 */
export function parseAuditCheckSubmission(value: unknown, expectedId: string): AuditCheckResult {
  if (!isAuditCheckId(expectedId)) {
    throw new Error("Final audit submission is not available for this agent.");
  }
  if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) {
    throw new Error(`Final audit submission must contain exactly ${RESULT_KEYS.join(", ")}.`);
  }
  if (!Array.isArray(value.evidence)) {
    throw new Error("Final audit submission evidence must be an array.");
  }
  for (const [index, item] of value.evidence.entries()) {
    if (!isRecord(item) || !hasExactKeys(item, EVIDENCE_KEYS)) {
      throw new Error(
        `Final audit submission evidence[${String(index)}] must contain exactly ${EVIDENCE_KEYS.join(", ")}.`,
      );
    }
  }
  if (!Array.isArray(value.missingEvidence)) {
    throw new Error("Final audit submission missingEvidence must be an array.");
  }
  for (const [index, item] of value.missingEvidence.entries()) {
    if (!isRecord(item) || !hasExactKeys(item, MISSING_EVIDENCE_KEYS)) {
      throw new Error(
        `Final audit submission missingEvidence[${String(index)}] must contain exactly ${MISSING_EVIDENCE_KEYS.join(", ")}.`,
      );
    }
  }

  return cloneResult(
    parseAuditCheckResult(
      {
        id: expectedId,
        ...value,
      },
      expectedId as AuditCheckId,
    ),
  );
}

export function assertAuditCheckSubmissionCompleted(
  successfulCalls: number,
  submission: AuditCheckResult | undefined,
): asserts submission is AuditCheckResult {
  if (successfulCalls !== 1 || submission === undefined) {
    throw new Error("Final audit result must be submitted successfully exactly once.");
  }
}
