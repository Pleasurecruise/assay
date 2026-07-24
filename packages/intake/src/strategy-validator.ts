import {
  type EarlyExitReasonCode,
  type MissingEvidence,
  type StrategySpec,
  validateStrategySpec,
} from "@assay/contracts";

export interface IntakeValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type IntakeValidationResult =
  | {
      success: true;
      spec: StrategySpec;
    }
  | {
      success: false;
      reasonCode: Extract<EarlyExitReasonCode, "insufficient_information" | "unsupported_input">;
      issues: readonly IntakeValidationIssue[];
      missingInformation: readonly MissingEvidence[];
    };

export interface StrategyValidationOptions {
  dataCutoff: string;
}

function readIssueField(issue: unknown, field: string): unknown {
  if (typeof issue !== "object" || issue === null) {
    return undefined;
  }
  return (issue as Record<string, unknown>)[field];
}

function normalizeIssue(issue: unknown): IntakeValidationIssue {
  const rawPath = readIssueField(issue, "path");
  const rawCode = readIssueField(issue, "code");
  const rawMessage = readIssueField(issue, "message");
  return {
    path: typeof rawPath === "string" && rawPath.length > 0 ? rawPath : "/",
    code: typeof rawCode === "string" && rawCode.length > 0 ? rawCode : "invalid_strategy_spec",
    message:
      typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : "The strategy input does not satisfy StrategySpec",
  };
}

function toMissingEvidence(issue: IntakeValidationIssue): MissingEvidence {
  return {
    requirement: issue.path,
    reason: issue.message,
    sourceRefs: ["intake:strategy-spec"],
  };
}

export function validateStrategyCandidate(
  candidate: unknown,
  options: StrategyValidationOptions,
): IntakeValidationResult {
  const validation = validateStrategySpec(candidate, {
    dataAsOf: options.dataCutoff,
  });
  if (validation.success) {
    return {
      success: true,
      spec: validation.spec,
    };
  }

  const issues = validation.issues.map(normalizeIssue);
  return {
    success: false,
    reasonCode: validation.reasonCode,
    issues,
    missingInformation: issues.map(toMissingEvidence),
  };
}
