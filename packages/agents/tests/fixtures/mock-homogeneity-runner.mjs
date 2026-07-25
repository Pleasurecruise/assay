const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  request?.kind !== "homogeneity" ||
  request.dataRef !==
    "assay-local-data-v1:audit_test:g01:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ||
  typeof request.spec !== "object" ||
  request.budget?.maxVariants !== 1
) {
  process.exitCode = 2;
} else {
  const response = {
    contractVersion: "1.0.0",
    engineVersion: "mock-homogeneity-v1",
    kind: "homogeneity",
    mode: "full_factor_library",
    comparisons: [
      {
        comparator: "momentum_20",
        meanSpearman: 1,
        rebalanceObservations: 35,
      },
      {
        comparator: "reversal_5",
        meanSpearman: -0.28,
        rebalanceObservations: 35,
      },
      {
        comparator: "volatility_20",
        meanSpearman: -0.17,
        rebalanceObservations: 35,
      },
      {
        comparator: "ratio_pe_ttm",
        meanSpearman: -0.08,
        rebalanceObservations: 34,
      },
      {
        comparator: "market_cap",
        meanSpearman: 0.11,
        rebalanceObservations: 35,
      },
    ],
    annualIc: [
      {
        year: "2023",
        observations: 5,
        pearsonIc: 0.12,
        rankIc: 0.1,
      },
      {
        year: "2024",
        observations: 12,
        pearsonIc: 0.08,
        rankIc: 0.07,
      },
      {
        year: "2025",
        observations: 12,
        pearsonIc: 0.04,
        rankIc: 0.04,
      },
    ],
    summary: {
      nearestComparator: "momentum_20",
      maxAbsMeanSpearman: 1,
      yearsCovered: 2,
      rankIcSlope: -0.03,
    },
    sourceRef: "artifact:homogeneity-decay/spearman-ic",
    assumptions: [],
  };
  if (request.spec.mockInvalidYears === true) {
    response.summary.yearsCovered = 2.5;
  }
  process.stdout.write(JSON.stringify(response));
}
