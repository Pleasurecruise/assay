const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !request ||
  !["baseline", "grid", "cost_ladder"].includes(request.kind) ||
  request.dataRef !==
    "assay-local-data-v1:audit_test:test-package:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ||
  typeof request.spec !== "object" ||
  typeof request.budget?.maxVariants !== "number"
) {
  process.stderr.write("invalid experiment request\n");
  process.exitCode = 2;
} else if (request.spec.mockFailure === true) {
  process.stderr.write('{"error":"MockFailure","message":"forced engine failure"}\n');
  process.exitCode = 7;
} else {
  const baselineParams = {
    window: request.spec.signal?.params?.window ?? 20,
    topN: request.spec.selection?.topN ?? 50,
    costModel: request.spec.costs?.model ?? "standard",
  };
  const variants =
    request.kind === "baseline"
      ? []
      : request.kind === "grid"
        ? (request.grid?.signalParams?.window ?? []).flatMap((window) =>
            (request.grid?.topN ?? []).map((topN, index) => ({
              params: {
                variantId: `w${window}-n${topN}`,
                window,
                topN,
                costModel: baselineParams.costModel,
                dailyReturnsRef: `artifact:backtest/parameter-grid/${window}-${topN}/daily-returns`,
              },
              annualReturn: 0.1 - index * 0.01,
              sharpe: 1.2 - index * 0.1,
              maxDrawdown: -0.1,
              annualTurnover: 2,
            })),
          )
        : [
            {
              params: { ...baselineParams, costModel: "standard" },
              annualReturn: 0.08,
              sharpe: 1.1,
              maxDrawdown: -0.11,
              annualTurnover: 2,
            },
            {
              params: { ...baselineParams, costModel: "realistic" },
              annualReturn: 0.05,
              sharpe: 0.8,
              maxDrawdown: -0.13,
              annualTurnover: 2,
            },
            {
              params: { ...baselineParams, costModel: "pessimistic" },
              annualReturn: 0.02,
              sharpe: 0.4,
              maxDrawdown: -0.16,
              annualTurnover: 2,
            },
          ];

  const gridDailyReturns =
    request.kind === "grid"
      ? variants.map((variant, variantIndex) => {
          const days = 64;
          const series = [];
          for (let day = 0; day < days; day += 1) {
            // Deterministic pseudo-noise plus a variant-specific drift so the
            // overfitting statistics have a well-defined, reproducible value.
            series.push(
              0.004 * Math.sin(day * (variantIndex + 2) * 0.7) +
                0.0005 * ((variantIndex % 5) - 2) +
                0.001,
            );
          }
          return series;
        })
      : undefined;

  const response = {
    engineVersion: "mock-v1",
    baseline: {
      params: baselineParams,
      annualReturn: 0.12,
      sharpe: 1.3,
      maxDrawdown: -0.09,
      annualTurnover: 1.8,
    },
    variants,
    ...(request.kind === "grid"
      ? {
          summaryRef: "artifact:backtest/parameter-grid",
          variantDailyReturns: gridDailyReturns,
        }
      : request.kind === "cost_ladder"
        ? { summaryRef: "artifact:backtest/cost-stress" }
        : {}),
  };

  if (request.spec.mockResponseShape === "baseline-missing-metric") {
    delete response.baseline.annualTurnover;
  } else if (request.spec.mockResponseShape === "variant-invalid-metric") {
    response.variants[0].sharpe = "not-a-number";
  } else if (request.spec.mockResponseShape === "extra-top-level-field") {
    response.debug = true;
  } else if (request.spec.mockResponseShape === "wrong-summary-ref") {
    response.summaryRef = "artifact:backtest/wrong";
  } else if (request.spec.mockResponseShape === "grid-missing-daily-returns") {
    delete response.variantDailyReturns;
  } else if (request.spec.mockResponseShape === "grid-misaligned-daily-returns") {
    response.variantDailyReturns = response.variantDailyReturns?.slice(1);
  } else if (request.spec.mockResponseShape === "grid-degenerate-daily-returns") {
    response.variantDailyReturns = response.variantDailyReturns?.map((series) =>
      series.map(() => 0.001),
    );
  }

  process.stdout.write(JSON.stringify(response));
}
