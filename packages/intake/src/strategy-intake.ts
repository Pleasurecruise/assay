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

function trailingThreeYearWindow(dataCutoff: string): {
  start: string;
  end: string;
} {
  const compact = dataCutoff.replaceAll("-", "");
  const endYear = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const startYear = endYear - 3;
  const lastStartMonthDay = new Date(Date.UTC(startYear, month, 0)).getUTCDate();
  return {
    start: [
      String(startYear).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(Math.min(day, lastStartMonthDay)).padStart(2, "0"),
    ].join(""),
    end: compact,
  };
}

function applySprintWindowDefault(
  candidate: unknown,
  dataCutoff: string,
): {
  candidate: unknown;
  defaultApplied?: string;
} {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.prototype.hasOwnProperty.call(candidate, "window")
  ) {
    return { candidate };
  }
  const window = trailingThreeYearWindow(dataCutoff);
  return {
    candidate: {
      ...(candidate as Record<string, unknown>),
      window,
    },
    defaultApplied: `window=${window.start}..${window.end} (sprint trailing-3y default)`,
  };
}

function annualReturnPercent(input: string): number | undefined {
  const match = input.match(/年化(?:收益率?|回报率?)?[^0-9-]{0,12}(-?\d+(?:\.\d+)?)\s*[%％]/);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent / 100 : undefined;
}

function claimedSharpe(input: string): number | undefined {
  const match = input.match(/夏普(?:比率)?[^0-9-]{0,12}(-?\d+(?:\.\d+)?)/);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const sharpe = Number(match[1]);
  return Number.isFinite(sharpe) ? sharpe : undefined;
}

function normalizeSprintParserOutput(candidate: unknown, input: string): unknown {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return candidate;
  }
  const normalized = structuredClone(candidate) as Record<string, unknown>;
  const universe = normalized.universe;
  if (typeof universe === "object" && universe !== null && !Array.isArray(universe)) {
    const index = (universe as Record<string, unknown>).index;
    if (
      typeof index === "string" &&
      (index.replaceAll(" ", "").toUpperCase().includes("000300") ||
        index.replaceAll(" ", "").toUpperCase().includes("CSI300") ||
        index.replaceAll(" ", "").includes("沪深300"))
    ) {
      (universe as Record<string, unknown>).index = "000300.SH";
    }
  }
  const signal = normalized.signal;
  if (typeof signal === "object" && signal !== null && !Array.isArray(signal)) {
    const signalRecord = signal as Record<string, unknown>;
    const parameters = signalRecord.params;
    if (
      signalRecord.kind === "template" &&
      (signalRecord.template === "momentum" || signalRecord.template === "reversal") &&
      typeof parameters === "object" &&
      parameters !== null &&
      !Array.isArray(parameters)
    ) {
      delete (parameters as Record<string, unknown>).direction;
    }
  }
  const normalizedAnnualReturn = annualReturnPercent(input);
  const normalizedSharpe = claimedSharpe(input);
  if (normalizedAnnualReturn !== undefined || normalizedSharpe !== undefined) {
    const existingClaims = normalized.claims;
    const claims =
      typeof existingClaims === "object" &&
      existingClaims !== null &&
      !Array.isArray(existingClaims)
        ? (existingClaims as Record<string, unknown>)
        : {};
    if (normalizedAnnualReturn !== undefined) {
      claims.annualReturn = normalizedAnnualReturn;
    }
    if (normalizedSharpe !== undefined) {
      claims.sharpe = normalizedSharpe;
    }
    normalized.claims = claims;
  }
  return normalized;
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

    const parsedCandidate = normalizeSprintParserOutput(
      await this.#parser.parse(trimmed, { signal }),
      trimmed,
    );
    // Sprint-only downgrade rung: an otherwise complete demo input without an
    // explicit period uses the trailing three years. Explicit partial/invalid
    // windows are never repaired. Replace this with a caller-confirmed policy
    // after the vertical slice.
    const sprintDefault = applySprintWindowDefault(parsedCandidate, this.#freezeOptions.dataAsOf);
    const validation = validateStrategyCandidate(sprintDefault.candidate, {
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

    const frozen = freezeStrategySpec(validation.spec, this.#freezeOptions);
    return {
      kind: "ready",
      frozen:
        sprintDefault.defaultApplied === undefined
          ? frozen
          : Object.freeze({
              ...frozen,
              defaultsApplied: Object.freeze([
                ...frozen.defaultsApplied,
                sprintDefault.defaultApplied,
              ]),
            }),
    };
  }
}
