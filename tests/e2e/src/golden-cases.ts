import {
  canonicalizeStrategySpec,
  hashStrategySpec,
  strategyForData,
  toCanonicalStrategySpec,
  type CanonicalStrategyDefinition,
  type CanonicalStrategySpec,
  type StrategyClaims,
} from "@assay/contracts";
import {
  DeterministicStrategyDataPlanner,
  type DataPlan,
} from "@assay/finance-tools";

export const GOLDEN_STRATEGY_CASES_VERSION = "assay-golden-strategy-cases-v1" as const;

export const GOLDEN_SHARED_RUNTIME_CHECKSUMS = Object.freeze({
  marketData: "sha256-27779f08aac594467eb16be723a2ac0e743042fddb078e4ca704ea6484dd9382",
  auditSupport: "sha256-d8018da42a6e8e4ddf074741b3ab55cda9e3e6040f6a448ac13903d7b9563886",
  pitMembership: "sha256-8a5b143d9faeb18d49f73564a1ab5e84a628e1da975b83f57376b3bc1a27dc4a",
} as const);

export type GoldenStrategyCaseLabel = "G01" | "G02" | "G03";

export interface GoldenStrategyCase {
  /**
   * Test/golden-fixture label only. It must never be sent to the A2A server or
   * participate in data planning or package resolution.
   */
  readonly label: GoldenStrategyCaseLabel;
  readonly input: string;
  readonly strategy: CanonicalStrategyDefinition;
  readonly claims: StrategyClaims;
  readonly packageId: string;
  readonly strategyKey: `sha256-${string}`;
  readonly specHash: `sha256:${string}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

const COMMON_STRATEGY = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  rebalance: { frequency: "monthly", at: "close" },
  window: { start: "20230723", end: "20260723" },
  costs: { model: "standard" },
} as const;

export const GOLDEN_STRATEGY_CASES: readonly GoldenStrategyCase[] = deepFreeze([
  {
    label: "G01",
    input: "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9",
    strategy: {
      ...COMMON_STRATEGY,
      signal: { kind: "template", template: "momentum", params: { window: 20 } },
      selection: { topN: 50, weighting: "equal" },
    },
    claims: { annualReturn: 0.18, sharpe: 1.9 },
    packageId: "csi300-momentum-20d-monthly-top50-equal",
    strategyKey: "sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb",
    specHash: "sha256:a76adf550c3f94aa8892726f0ffa5de597725fe40406d0b409e2c351c8d063f6",
  },
  {
    label: "G02",
    input:
      "请审计这套策略：2023-07-23 至 2026-07-23，在沪深 300 成分股中，每月底按过去 14 个交易日涨幅排序，买入前 30 只并等权持有。策略报告宣称年化收益 60%，夏普 2.3。",
    strategy: {
      ...COMMON_STRATEGY,
      signal: { kind: "template", template: "momentum", params: { window: 14 } },
      selection: { topN: 30, weighting: "equal" },
    },
    claims: { annualReturn: 0.6, sharpe: 2.3 },
    packageId: "csi300-momentum-14d-monthly-top30-equal",
    strategyKey: "sha256-9242fb1add11336293dd23983415e1493e25bdf924c06d04159b645b7f1c8195",
    specHash: "sha256:862b452edaf1650844d21e419c96782730d8c994c0b79da3602b305a0bd88d31",
  },
  {
    label: "G03",
    input:
      "请独立复核：2023-07-23 至 2026-07-23，在沪深 300 成分股中，每月底按过去 26 个交易日涨幅排序，持有前 70 只，等权配置。管理人宣称年化收益 20%，夏普 0.9。",
    strategy: {
      ...COMMON_STRATEGY,
      signal: { kind: "template", template: "momentum", params: { window: 26 } },
      selection: { topN: 70, weighting: "equal" },
    },
    claims: { annualReturn: 0.2, sharpe: 0.9 },
    packageId: "csi300-momentum-26d-monthly-top70-equal",
    strategyKey: "sha256-15a2f8c08d6a7f1e2f8013d1c663c325cf9666b30a06a5d8382aefcfc99f21f9",
    specHash: "sha256:18d1a3ff19ce6983f3c99d1c1e3dbe6e0e9c381eb9cfa572ff42314b0c9115ed",
  },
] satisfies readonly GoldenStrategyCase[]);

const planner = new DeterministicStrategyDataPlanner();

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function canonicalSpecForGoldenCase(
  goldenCase: GoldenStrategyCase,
): CanonicalStrategySpec {
  return toCanonicalStrategySpec({
    ...goldenCase.strategy,
    claims: goldenCase.claims,
  });
}

export function dataPlanForGoldenCase(goldenCase: GoldenStrategyCase): DataPlan {
  const plan = planner.plan(goldenCase.strategy);
  requireValue(
    plan.strategyKey === goldenCase.strategyKey,
    `${goldenCase.label} frozen strategyKey drifted`,
  );
  return plan;
}

for (const goldenCase of GOLDEN_STRATEGY_CASES) {
  requireValue(
    !Object.hasOwn(goldenCase.strategy, "claims"),
    `${goldenCase.label} fixture strategy must be claims-free`,
  );
  const canonicalSpec = canonicalSpecForGoldenCase(goldenCase);
  requireValue(
    canonicalizeStrategySpec(canonicalSpec) === canonicalizeStrategySpec({
      ...goldenCase.strategy,
      claims: goldenCase.claims,
    }),
    `${goldenCase.label} canonical StrategySpec drifted`,
  );
  requireValue(
    hashStrategySpec(canonicalizeStrategySpec(canonicalSpec)) === goldenCase.specHash,
    `${goldenCase.label} frozen specHash drifted`,
  );
  requireValue(
    dataPlanForGoldenCase(goldenCase).strategyKey === goldenCase.strategyKey,
    `${goldenCase.label} frozen DataPlan drifted`,
  );
  requireValue(
    !Object.hasOwn(strategyForData(canonicalSpec), "claims"),
    `${goldenCase.label} claims leaked into the data identity`,
  );
}
