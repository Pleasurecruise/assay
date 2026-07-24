const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  request?.kind !== "regime_split" ||
  typeof request.spec !== "object" ||
  request.budget?.maxVariants !== 1
) {
  process.exitCode = 2;
} else {
  const response = {
    contractVersion: "1.0.0",
    engineVersion: "mock-regime-v1",
    kind: "regime_split",
    mode: "index_daily",
    environments: [
      {
        id: "up-high",
        trend: "up",
        volatility: "high",
        days: 80,
        annualReturn: 0.24,
        sharpe: 1.4,
        pnlShare: 0.82,
      },
      {
        id: "up-normal",
        trend: "up",
        volatility: "normal",
        days: 260,
        annualReturn: 0.07,
        sharpe: 0.6,
        pnlShare: 0.08,
      },
      {
        id: "down-high",
        trend: "down",
        volatility: "high",
        days: 90,
        annualReturn: 0.03,
        sharpe: 0.2,
        pnlShare: 0.06,
      },
      {
        id: "down-normal",
        trend: "down",
        volatility: "normal",
        days: 180,
        annualReturn: 0.02,
        sharpe: 0.15,
        pnlShare: 0.04,
      },
    ],
    dominantEnvironment: {
      id: "up-high",
      pnlShare: 0.82,
    },
    sourceRef: "artifact:regime-dependency/regime-split",
    assumptions: [],
  };
  if (request.spec.mockInvalidDominant === true) {
    response.dominantEnvironment.pnlShare = 0.81;
  }
  process.stdout.write(JSON.stringify(response));
}
