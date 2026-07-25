export const STRATEGY_SPEC_VERSION = "1" as const;

export const STRATEGY_TEMPLATE_NAMES = [
  "momentum",
  "reversal",
  "volatility",
  "turnover_rate",
] as const;

export type StrategyTemplateName = (typeof STRATEGY_TEMPLATE_NAMES)[number];

export const STRATEGY_COST_MODELS = ["none", "standard", "realistic", "pessimistic"] as const;

export type StrategyCostModel = (typeof STRATEGY_COST_MODELS)[number];
export type StrategySignalDirection = "low" | "high";
export type StrategyRebalanceFrequency = "monthly" | "weekly";

export interface StrategyUniverse {
  readonly index: string;
}

export interface LibraryStrategySignal {
  readonly kind: "library";
  readonly name: string;
}

export interface WindowTemplateParameters {
  readonly window?: number;
}

export interface DirectionalTemplateParameters extends WindowTemplateParameters {
  readonly direction?: StrategySignalDirection;
}

export type TemplateStrategySignal =
  | {
      readonly kind: "template";
      readonly template: "momentum" | "reversal";
      readonly params?: WindowTemplateParameters;
    }
  | {
      readonly kind: "template";
      readonly template: "volatility" | "turnover_rate";
      readonly params?: DirectionalTemplateParameters;
    };

export type StrategySignal = LibraryStrategySignal | TemplateStrategySignal;

export interface StrategySelection {
  readonly topN: number;
  readonly weighting?: "equal";
}

export interface StrategyRebalance {
  readonly frequency: StrategyRebalanceFrequency;
  readonly at?: "close";
}

export interface StrategyWindow {
  readonly start: string;
  readonly end: string;
}

export interface StrategyCosts {
  readonly model: StrategyCostModel;
}

export interface StrategyClaims {
  readonly annualReturn?: number;
  readonly sharpe?: number;
  readonly maxDrawdown?: number;
}

/**
 * Public StrategySpec before deterministic defaults have been expanded.
 */
export interface StrategySpec {
  readonly specVersion: typeof STRATEGY_SPEC_VERSION;
  readonly universe: StrategyUniverse;
  readonly signal: StrategySignal;
  readonly selection: StrategySelection;
  readonly rebalance: StrategyRebalance;
  readonly window: StrategyWindow;
  readonly costs?: StrategyCosts;
  readonly claims?: StrategyClaims;
}

export type CanonicalTemplateStrategySignal =
  | {
      readonly kind: "template";
      readonly template: "momentum" | "reversal";
      readonly params: {
        readonly window: number;
      };
    }
  | {
      readonly kind: "template";
      readonly template: "volatility" | "turnover_rate";
      readonly params: {
        readonly window: number;
        readonly direction: StrategySignalDirection;
      };
    };

export interface CanonicalStrategySpec {
  readonly specVersion: typeof STRATEGY_SPEC_VERSION;
  readonly universe: StrategyUniverse;
  readonly signal: LibraryStrategySignal | CanonicalTemplateStrategySignal;
  readonly selection: {
    readonly topN: number;
    readonly weighting: "equal";
  };
  readonly rebalance: {
    readonly frequency: StrategyRebalanceFrequency;
    readonly at: "close";
  };
  readonly window: StrategyWindow;
  readonly costs: StrategyCosts;
  readonly claims?: StrategyClaims;
}

/**
 * Canonical strategy fields that are allowed to influence data planning.
 *
 * `claims?: never` makes the boundary intentional: a claims-bearing
 * CanonicalStrategySpec is not assignable to a StrategyDataPlanner input.
 */
export type CanonicalStrategyDefinition = Omit<CanonicalStrategySpec, "claims"> & {
  readonly claims?: never;
};

export const STRATEGY_SPEC_ISSUE_CODES = [
  "missing_field",
  "invalid_type",
  "invalid_value",
  "unsupported_value",
  "unknown_field",
] as const;

export type StrategySpecIssueCode = (typeof STRATEGY_SPEC_ISSUE_CODES)[number];
export type StrategySpecIssueCategory = "incomplete" | "invalid" | "unsupported";
export type StrategySpecRejectionReason = "insufficient_information" | "unsupported_input";

export interface StrategySpecValidationIssue {
  readonly path: string;
  readonly code: StrategySpecIssueCode;
  readonly category: StrategySpecIssueCategory;
  readonly message: string;
}

export type StrategySpecValidationResult =
  | {
      readonly success: true;
      readonly spec: StrategySpec;
      readonly issues: readonly [];
    }
  | {
      readonly success: false;
      readonly reasonCode: StrategySpecRejectionReason;
      readonly issues: readonly StrategySpecValidationIssue[];
    };

export interface StrategySpecValidationOptions {
  /**
   * Provider data cutoff. Both YYYYMMDD and YYYY-MM-DD are accepted.
   */
  readonly dataAsOf?: string;
  /**
   * When supplied by a capability probe, library signals must appear here.
   * Omitting it performs shape validation without pretending a probe ran.
   */
  readonly availableLibraryFactors?: ReadonlySet<string> | readonly string[];
}

export class StrategySpecValidationError extends Error {
  readonly reasonCode: StrategySpecRejectionReason;
  readonly issues: readonly StrategySpecValidationIssue[];

  constructor(result: Extract<StrategySpecValidationResult, { success: false }>) {
    super(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "StrategySpecValidationError";
    this.reasonCode = result.reasonCode;
    this.issues = result.issues;
  }
}

const TEMPLATE_DEFAULTS = {
  momentum: { window: 20 },
  reversal: { window: 5 },
  volatility: { window: 20, direction: "low" },
  turnover_rate: { window: 20, direction: "low" },
} as const satisfies Record<StrategyTemplateName, Record<string, number | string>>;

const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const INDEX_PATTERN = /^\d{6}\.(SH|SZ)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function includesValue<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function addIssue(
  issues: StrategySpecValidationIssue[],
  path: string,
  code: StrategySpecIssueCode,
  category: StrategySpecIssueCategory,
  message: string,
): void {
  issues.push({ path, code, category, message });
}

function requireField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: StrategySpecValidationIssue[],
): boolean {
  if (hasOwn(record, key) && record[key] !== undefined && record[key] !== null) {
    return true;
  }
  addIssue(issues, `${path}.${key}`, "missing_field", "incomplete", "field is required");
  return false;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: StrategySpecValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      addIssue(
        issues,
        `${path}.${key}`,
        "unknown_field",
        "invalid",
        "field is not part of StrategySpec",
      );
    }
  }
}

function validateDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function normalizeDataAsOf(value: string): string | undefined {
  const compact = value.replaceAll("-", "");
  return validateDate(compact) ? compact : undefined;
}

function exceedsFiveCalendarYears(start: string, end: string): boolean {
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  if (endYear - startYear !== 5) {
    return endYear - startYear > 5;
  }
  return end.slice(4) > start.slice(4);
}

function validateTemplateParameters(
  value: unknown,
  template: StrategyTemplateName,
  issues: StrategySpecValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    addIssue(issues, "$.signal.params", "invalid_type", "invalid", "params must be an object");
    return;
  }

  const isDirectional = template === "volatility" || template === "turnover_rate";
  rejectUnknownFields(
    value,
    isDirectional ? ["window", "direction"] : ["window"],
    "$.signal.params",
    issues,
  );

  if (
    hasOwn(value, "window") &&
    (!Number.isInteger(value.window) || (value.window as number) <= 0)
  ) {
    addIssue(
      issues,
      "$.signal.params.window",
      "invalid_value",
      "invalid",
      "window must be a positive integer",
    );
  }

  if (
    isDirectional &&
    hasOwn(value, "direction") &&
    value.direction !== "low" &&
    value.direction !== "high"
  ) {
    addIssue(
      issues,
      "$.signal.params.direction",
      "unsupported_value",
      "unsupported",
      'direction must be "low" or "high"',
    );
  }
}

function validateSignal(
  value: unknown,
  issues: StrategySpecValidationIssue[],
  options: StrategySpecValidationOptions,
): void {
  if (!isRecord(value)) {
    addIssue(issues, "$.signal", "invalid_type", "invalid", "signal must be an object");
    return;
  }
  if (!requireField(value, "kind", "$.signal", issues)) {
    return;
  }

  if (value.kind === "library") {
    rejectUnknownFields(value, ["kind", "name"], "$.signal", issues);
    if (!requireField(value, "name", "$.signal", issues)) {
      return;
    }
    if (!isNonEmptyString(value.name)) {
      addIssue(
        issues,
        "$.signal.name",
        "invalid_value",
        "invalid",
        "library factor name must be a non-empty string",
      );
      return;
    }

    if (options.availableLibraryFactors !== undefined) {
      const available = Array.isArray(options.availableLibraryFactors)
        ? options.availableLibraryFactors.includes(value.name.trim())
        : (options.availableLibraryFactors as ReadonlySet<string>).has(value.name.trim());
      if (!available) {
        addIssue(
          issues,
          "$.signal.name",
          "unsupported_value",
          "unsupported",
          "library factor is not available in the verified factor catalog",
        );
      }
    }
    return;
  }

  if (value.kind === "template") {
    if (!requireField(value, "template", "$.signal", issues)) {
      rejectUnknownFields(value, ["kind", "template", "params"], "$.signal", issues);
      return;
    }
    if (!includesValue(STRATEGY_TEMPLATE_NAMES, value.template)) {
      addIssue(
        issues,
        "$.signal.template",
        "unsupported_value",
        "unsupported",
        "template is not implemented",
      );
      rejectUnknownFields(value, ["kind", "template", "params"], "$.signal", issues);
      return;
    }
    rejectUnknownFields(value, ["kind", "template", "params"], "$.signal", issues);
    validateTemplateParameters(value.params, value.template, issues);
    return;
  }

  addIssue(
    issues,
    "$.signal.kind",
    "unsupported_value",
    "unsupported",
    'signal kind must be "library" or an implemented "template"',
  );
}

function validateUniverse(value: unknown, issues: StrategySpecValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, "$.universe", "invalid_type", "invalid", "universe must be an object");
    return;
  }
  rejectUnknownFields(value, ["index"], "$.universe", issues);
  if (!requireField(value, "index", "$.universe", issues)) {
    return;
  }
  if (!isNonEmptyString(value.index) || !INDEX_PATTERN.test(value.index.trim().toUpperCase())) {
    addIssue(
      issues,
      "$.universe.index",
      "invalid_value",
      "invalid",
      "index must use a six-digit .SH or .SZ code",
    );
  }
}

function validateSelection(value: unknown, issues: StrategySpecValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, "$.selection", "invalid_type", "invalid", "selection must be an object");
    return;
  }
  rejectUnknownFields(value, ["topN", "weighting"], "$.selection", issues);
  if (
    requireField(value, "topN", "$.selection", issues) &&
    (!Number.isInteger(value.topN) || (value.topN as number) < 1 || (value.topN as number) > 200)
  ) {
    addIssue(
      issues,
      "$.selection.topN",
      "invalid_value",
      "invalid",
      "topN must be an integer between 1 and 200",
    );
  }
  if (hasOwn(value, "weighting") && value.weighting !== "equal") {
    addIssue(
      issues,
      "$.selection.weighting",
      "unsupported_value",
      "unsupported",
      'only "equal" weighting is implemented',
    );
  }
}

function validateRebalance(value: unknown, issues: StrategySpecValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, "$.rebalance", "invalid_type", "invalid", "rebalance must be an object");
    return;
  }
  rejectUnknownFields(value, ["frequency", "at"], "$.rebalance", issues);
  if (
    requireField(value, "frequency", "$.rebalance", issues) &&
    value.frequency !== "monthly" &&
    value.frequency !== "weekly"
  ) {
    addIssue(
      issues,
      "$.rebalance.frequency",
      "unsupported_value",
      "unsupported",
      'frequency must be "monthly" or "weekly"',
    );
  }
  if (hasOwn(value, "at") && value.at !== "close") {
    addIssue(
      issues,
      "$.rebalance.at",
      "unsupported_value",
      "unsupported",
      'only rebalance at "close" is implemented',
    );
  }
}

function validateWindow(
  value: unknown,
  issues: StrategySpecValidationIssue[],
  dataAsOf: string | undefined,
): void {
  if (!isRecord(value)) {
    addIssue(issues, "$.window", "invalid_type", "invalid", "window must be an object");
    return;
  }
  rejectUnknownFields(value, ["start", "end"], "$.window", issues);
  const hasStart = requireField(value, "start", "$.window", issues);
  const hasEnd = requireField(value, "end", "$.window", issues);
  const validStart = hasStart && validateDate(value.start);
  const validEnd = hasEnd && validateDate(value.end);
  if (hasStart && !validStart) {
    addIssue(
      issues,
      "$.window.start",
      "invalid_value",
      "invalid",
      "start must be a valid YYYYMMDD date",
    );
  }
  if (hasEnd && !validEnd) {
    addIssue(
      issues,
      "$.window.end",
      "invalid_value",
      "invalid",
      "end must be a valid YYYYMMDD date",
    );
  }
  if (!validStart || !validEnd) {
    return;
  }
  const start = value.start as string;
  const end = value.end as string;
  if (start > end) {
    addIssue(
      issues,
      "$.window",
      "invalid_value",
      "invalid",
      "window start must not be later than end",
    );
  } else if (exceedsFiveCalendarYears(start, end)) {
    addIssue(
      issues,
      "$.window",
      "invalid_value",
      "invalid",
      "window must not exceed five calendar years",
    );
  }
  if (dataAsOf !== undefined && end > dataAsOf) {
    addIssue(
      issues,
      "$.window.end",
      "invalid_value",
      "invalid",
      "end must not be later than the provider data cutoff",
    );
  }
}

function validateCosts(value: unknown, issues: StrategySpecValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    addIssue(issues, "$.costs", "invalid_type", "invalid", "costs must be an object");
    return;
  }
  rejectUnknownFields(value, ["model"], "$.costs", issues);
  if (!requireField(value, "model", "$.costs", issues)) {
    return;
  }
  if (!includesValue(STRATEGY_COST_MODELS, value.model)) {
    addIssue(
      issues,
      "$.costs.model",
      "unsupported_value",
      "unsupported",
      "cost model is not implemented",
    );
  }
}

function validateClaims(value: unknown, issues: StrategySpecValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    addIssue(issues, "$.claims", "invalid_type", "invalid", "claims must be an object");
    return;
  }
  rejectUnknownFields(value, ["annualReturn", "sharpe", "maxDrawdown"], "$.claims", issues);
  for (const key of ["annualReturn", "sharpe", "maxDrawdown"] as const) {
    if (hasOwn(value, key) && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      addIssue(
        issues,
        `$.claims.${key}`,
        "invalid_value",
        "invalid",
        "claim must be a finite number",
      );
    }
  }
}

function normalizeStrategySpec(value: Record<string, unknown>): StrategySpec {
  const universe = value.universe as Record<string, unknown>;
  const signal = value.signal as Record<string, unknown>;
  const selection = value.selection as Record<string, unknown>;
  const rebalance = value.rebalance as Record<string, unknown>;
  const window = value.window as Record<string, unknown>;

  const normalizedSignal: StrategySignal =
    signal.kind === "library"
      ? {
          kind: "library",
          name: (signal.name as string).trim(),
        }
      : signal.template === "momentum" || signal.template === "reversal"
        ? {
            kind: "template",
            template: signal.template,
            ...(signal.params === undefined
              ? {}
              : {
                  params:
                    (signal.params as Record<string, unknown>).window === undefined
                      ? {}
                      : {
                          window: (signal.params as Record<string, unknown>).window as number,
                        },
                }),
          }
        : {
            kind: "template",
            template: signal.template as "volatility" | "turnover_rate",
            ...(signal.params === undefined
              ? {}
              : {
                  params: {
                    ...((signal.params as Record<string, unknown>).window === undefined
                      ? {}
                      : { window: (signal.params as Record<string, unknown>).window as number }),
                    ...((signal.params as Record<string, unknown>).direction === undefined
                      ? {}
                      : {
                          direction: (signal.params as Record<string, unknown>)
                            .direction as StrategySignalDirection,
                        }),
                  },
                }),
          };

  const costs = value.costs as Record<string, unknown> | undefined;
  const claims = value.claims as Record<string, unknown> | undefined;

  return {
    specVersion: STRATEGY_SPEC_VERSION,
    universe: {
      index: (universe.index as string).trim(),
    },
    signal: normalizedSignal,
    selection: {
      topN: selection.topN as number,
      ...(selection.weighting === undefined ? {} : { weighting: selection.weighting as "equal" }),
    },
    rebalance: {
      frequency: rebalance.frequency as StrategyRebalanceFrequency,
      ...(rebalance.at === undefined ? {} : { at: rebalance.at as "close" }),
    },
    window: {
      start: window.start as string,
      end: window.end as string,
    },
    ...(costs === undefined
      ? {}
      : {
          costs: {
            model: costs.model as StrategyCostModel,
          },
        }),
    ...(claims === undefined
      ? {}
      : {
          claims: {
            ...(claims.annualReturn === undefined
              ? {}
              : { annualReturn: claims.annualReturn as number }),
            ...(claims.sharpe === undefined ? {} : { sharpe: claims.sharpe as number }),
            ...(claims.maxDrawdown === undefined
              ? {}
              : { maxDrawdown: claims.maxDrawdown as number }),
          },
        }),
  };
}

export function validateStrategySpec(
  value: unknown,
  options: StrategySpecValidationOptions = {},
): StrategySpecValidationResult {
  const issues: StrategySpecValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      success: false,
      reasonCode: "insufficient_information",
      issues: [
        {
          path: "$",
          code: "invalid_type",
          category: "invalid",
          message: "StrategySpec must be an object",
        },
      ],
    };
  }

  rejectUnknownFields(
    value,
    ["specVersion", "universe", "signal", "selection", "rebalance", "window", "costs", "claims"],
    "$",
    issues,
  );

  if (
    requireField(value, "specVersion", "$", issues) &&
    value.specVersion !== STRATEGY_SPEC_VERSION
  ) {
    addIssue(
      issues,
      "$.specVersion",
      "unsupported_value",
      "unsupported",
      `specVersion must be "${STRATEGY_SPEC_VERSION}"`,
    );
  }

  for (const field of ["universe", "signal", "selection", "rebalance", "window"] as const) {
    requireField(value, field, "$", issues);
  }

  if (hasOwn(value, "universe") && value.universe !== undefined && value.universe !== null) {
    validateUniverse(value.universe, issues);
  }
  if (hasOwn(value, "signal") && value.signal !== undefined && value.signal !== null) {
    validateSignal(value.signal, issues, options);
  }
  if (hasOwn(value, "selection") && value.selection !== undefined && value.selection !== null) {
    validateSelection(value.selection, issues);
  }
  if (hasOwn(value, "rebalance") && value.rebalance !== undefined && value.rebalance !== null) {
    validateRebalance(value.rebalance, issues);
  }

  let dataAsOf: string | undefined;
  if (options.dataAsOf !== undefined) {
    dataAsOf = normalizeDataAsOf(options.dataAsOf);
    if (dataAsOf === undefined) {
      throw new Error("StrategySpec validation dataAsOf must be YYYYMMDD or YYYY-MM-DD");
    }
  }
  if (hasOwn(value, "window") && value.window !== undefined && value.window !== null) {
    validateWindow(value.window, issues, dataAsOf);
  }
  validateCosts(value.costs, issues);
  validateClaims(value.claims, issues);

  if (issues.length > 0) {
    return {
      success: false,
      reasonCode: issues.some((issue) => issue.category === "unsupported")
        ? "unsupported_input"
        : "insufficient_information",
      issues,
    };
  }

  return {
    success: true,
    spec: normalizeStrategySpec(value),
    issues: [],
  };
}

export function parseStrategySpec(
  value: unknown,
  options: StrategySpecValidationOptions = {},
): StrategySpec {
  const result = validateStrategySpec(value, options);
  if (!result.success) {
    throw new StrategySpecValidationError(result);
  }
  return result.spec;
}

function normalizeCanonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function canonicalizeClaims(claims: StrategyClaims): StrategyClaims {
  return {
    ...(claims.annualReturn === undefined
      ? {}
      : { annualReturn: normalizeCanonicalNumber(claims.annualReturn) }),
    ...(claims.sharpe === undefined ? {} : { sharpe: normalizeCanonicalNumber(claims.sharpe) }),
    ...(claims.maxDrawdown === undefined
      ? {}
      : { maxDrawdown: normalizeCanonicalNumber(claims.maxDrawdown) }),
  };
}

export function toCanonicalStrategySpec(value: StrategySpec): CanonicalStrategySpec {
  const spec = parseStrategySpec(value);
  let signal: CanonicalStrategySpec["signal"];
  if (spec.signal.kind === "library") {
    signal = {
      kind: "library",
      name: spec.signal.name,
    };
  } else if (spec.signal.template === "momentum" || spec.signal.template === "reversal") {
    signal = {
      kind: "template",
      template: spec.signal.template,
      params: {
        window: spec.signal.params?.window ?? TEMPLATE_DEFAULTS[spec.signal.template].window,
      },
    };
  } else {
    const params = spec.signal.params as DirectionalTemplateParameters | undefined;
    signal = {
      kind: "template",
      template: spec.signal.template,
      params: {
        window: params?.window ?? TEMPLATE_DEFAULTS[spec.signal.template].window,
        direction: params?.direction ?? TEMPLATE_DEFAULTS[spec.signal.template].direction,
      },
    };
  }

  return {
    specVersion: STRATEGY_SPEC_VERSION,
    universe: {
      index: spec.universe.index.toUpperCase(),
    },
    signal,
    selection: {
      topN: spec.selection.topN,
      weighting: spec.selection.weighting ?? "equal",
    },
    rebalance: {
      frequency: spec.rebalance.frequency,
      at: spec.rebalance.at ?? "close",
    },
    window: {
      start: spec.window.start,
      end: spec.window.end,
    },
    costs: {
      model: spec.costs?.model ?? "standard",
    },
    ...(spec.claims === undefined ? {} : { claims: canonicalizeClaims(spec.claims) }),
  };
}

/**
 * Projects the audited subject into the claims-free strategy definition used
 * for deterministic data planning. The returned object truly omits `claims`;
 * this is not a type assertion over the original object.
 */
export function strategyForData(spec: CanonicalStrategySpec): CanonicalStrategyDefinition {
  return {
    specVersion: spec.specVersion,
    universe: spec.universe,
    signal: spec.signal,
    selection: spec.selection,
    rebalance: spec.rebalance,
    window: spec.window,
    costs: spec.costs,
  };
}

/**
 * Returns the exact canonical UTF-8 JSON bytes used as AuditSubject.input.
 */
export function canonicalizeStrategySpec(value: StrategySpec): string {
  return JSON.stringify(toCanonicalStrategySpec(value));
}

/**
 * Hashes the exact canonical string supplied by the caller without reparsing
 * or reserializing it.
 */
