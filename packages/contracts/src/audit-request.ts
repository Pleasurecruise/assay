import {
  parseStrategySpec,
  type StrategySpec,
  type StrategySpecValidationOptions,
} from "./strategy-spec";

export const AUDIT_REQUEST_SCHEMA_VERSION = "1.0.0" as const;

export interface StrategySpecInput {
  readonly kind: "strategy_spec";
  readonly spec: StrategySpec;
}

export interface StrategyAuditSubject {
  /**
   * Optional at the public boundary. The server derives a stable id from the
   * task-scoped auditId when the caller omits it.
   */
  readonly id?: string;
  readonly input: StrategySpecInput;
}

export interface StrategyAuditRequest {
  readonly requestSchemaVersion: typeof AUDIT_REQUEST_SCHEMA_VERSION;
  readonly skill: "audit_strategy";
  readonly subject: StrategyAuditSubject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown field "${unknown[0]}"`);
  }
}

/**
 * Validates the public structured request envelope. The Skeleton server only
 * decodes text Parts; this contract is shared with the later structured-input
 * decoder so it cannot become a second domain model.
 */
export function parseStrategyAuditRequest(
  value: unknown,
  options: StrategySpecValidationOptions = {},
): StrategyAuditRequest {
  if (!isRecord(value)) {
    throw new Error("Audit request must be a JSON object");
  }
  assertExactKeys(value, ["requestSchemaVersion", "skill", "subject"], "$");
  if (value.requestSchemaVersion !== AUDIT_REQUEST_SCHEMA_VERSION) {
    throw new Error(`requestSchemaVersion must be "${AUDIT_REQUEST_SCHEMA_VERSION}"`);
  }
  if (value.skill !== "audit_strategy") {
    throw new Error('Skeleton request skill must be "audit_strategy"');
  }
  if (!isRecord(value.subject)) {
    throw new Error("subject must be an object");
  }
  assertExactKeys(value.subject, ["id", "input"], "$.subject");
  if (value.subject.id !== undefined && !isNonEmptyString(value.subject.id)) {
    throw new Error("subject.id must be a non-empty string when present");
  }
  if (!isRecord(value.subject.input)) {
    throw new Error("subject.input must be an object");
  }
  assertExactKeys(value.subject.input, ["kind", "spec"], "$.subject.input");
  if (value.subject.input.kind !== "strategy_spec") {
    throw new Error('subject.input.kind must be "strategy_spec"');
  }

  const spec = parseStrategySpec(value.subject.input.spec, options);
  return {
    requestSchemaVersion: AUDIT_REQUEST_SCHEMA_VERSION,
    skill: "audit_strategy",
    subject: {
      ...(value.subject.id === undefined ? {} : { id: value.subject.id.trim() }),
      input: {
        kind: "strategy_spec",
        spec,
      },
    },
  };
}
