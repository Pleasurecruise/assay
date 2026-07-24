import type { EarlyExitReasonCode, MissingEvidence } from "@assay/contracts";
import type { NaturalLanguageStrategyParser } from "./natural-language-parser";
import {
  freezeStrategySpec,
  type FreezeStrategyOptions,
  type FrozenAuditInput,
} from "./strategy-freezer";
import { type IntakeValidationIssue, validateStrategyCandidate } from "./strategy-validator";

export type SkeletonEarlyExitReasonCode = Extract<
  EarlyExitReasonCode,
  "insufficient_information" | "unsupported_input"
>;

export type StrategyIntakeResult =
  | {
      kind: "ready";
      frozen: FrozenAuditInput;
    }
  | {
      kind: "early_exit";
      reasonCode: SkeletonEarlyExitReasonCode;
      summary: string;
      issues: readonly IntakeValidationIssue[];
      missingInformation: readonly MissingEvidence[];
    };

export interface StrategyIntakeOptions extends FreezeStrategyOptions {
  parser: NaturalLanguageStrategyParser;
}

const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/;

const EXECUTABLE_CODE_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*(?:from|import)\s+[a-zA-Z_][\w.]*/m,
  /(?:^|\n)\s*(?:async\s+)?def\s+[a-zA-Z_]\w*\s*\(/m,
  /(?:^|\n)\s*class\s+[a-zA-Z_]\w*\s*[:(]/m,
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
];

function unsupportedCodeIssue(): IntakeValidationIssue {
  return {
    path: "/signal",
    code: "unsupported_executable_code",
    message:
      "Arbitrary Python or executable strategy code is outside the supported StrategySpec family",
  };
}

function toMissingInformation(issue: IntakeValidationIssue): MissingEvidence {
  return {
    requirement: issue.path,
    reason: issue.message,
    sourceRefs: ["intake:strategy-input"],
  };
}

function detectsExecutableCode(input: string): boolean {
  if (FENCED_CODE_BLOCK_PATTERN.test(input)) {
    return true;
  }

  let matchedPatterns = 0;
  for (const pattern of EXECUTABLE_CODE_PATTERNS) {
    if (pattern.test(input)) {
      matchedPatterns += 1;
      if (matchedPatterns >= 2) {
        return true;
      }
    }
  }

  return false;
}

export class StrategyIntake {
  readonly #parser: NaturalLanguageStrategyParser;
  readonly #freezeOptions: FreezeStrategyOptions;

  constructor(options: StrategyIntakeOptions) {
    this.#parser = options.parser;
    this.#freezeOptions = {
      dataAsOf: options.dataAsOf,
      capabilitySnapshotId: options.capabilitySnapshotId,
      codeRevision: options.codeRevision,
      ...(options.checkPlan === undefined ? {} : { checkPlan: options.checkPlan }),
    };
  }

  async intakeText(input: string, signal?: AbortSignal): Promise<StrategyIntakeResult> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      const issue: IntakeValidationIssue = {
        path: "/",
        code: "missing_strategy_input",
        message: "A natural-language strategy description is required",
      };
      return {
        kind: "early_exit",
        reasonCode: "insufficient_information",
        summary: "The audit could not start because no strategy description was provided.",
        issues: [issue],
        missingInformation: [toMissingInformation(issue)],
      };
    }

    if (detectsExecutableCode(trimmed)) {
      const issue = unsupportedCodeIssue();
      return {
        kind: "early_exit",
        reasonCode: "unsupported_input",
        summary: "The supplied strategy uses executable code, which Assay does not run.",
        issues: [issue],
        missingInformation: [toMissingInformation(issue)],
      };
    }

    const candidate = await this.#parser.parse(trimmed, { signal });
    const validation = validateStrategyCandidate(candidate, {
      dataCutoff: this.#freezeOptions.dataAsOf.replaceAll("-", ""),
    });
    if (!validation.success) {
      return {
        kind: "early_exit",
        reasonCode: validation.reasonCode,
        summary:
          validation.reasonCode === "unsupported_input"
            ? "The supplied strategy is outside Assay's supported strategy family."
            : "The audit could not start because required StrategySpec information is missing or invalid.",
        issues: validation.issues,
        missingInformation: validation.missingInformation,
      };
    }

    return {
      kind: "ready",
      frozen: freezeStrategySpec(validation.spec, this.#freezeOptions),
    };
  }
}
