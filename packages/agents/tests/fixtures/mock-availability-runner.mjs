const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  request?.kind !== "availability_audit" ||
  request.dataRef !==
    "assay-local-data-v1:audit_test:g01:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ||
  typeof request.spec !== "object" ||
  request.budget?.maxVariants !== 1
) {
  process.exitCode = 2;
} else {
  const response = {
    contractVersion: "1.0.0",
    engineVersion: "mock-availability-v1",
    mode: "full_pit",
    futureConstituentCount: 12,
    affectedRebalances: ["2024-01-31", "2024-02-29"],
    sampleSymbols: ["000001.SZ", "600000.SH"],
    untradableTargets: 3,
    contaminatedSelectionRate: 0.12,
    corrected: {
      annualReturn: 0.13,
      sharpe: 0.9,
      delta: -0.04,
    },
    sourceRef: "artifact:data-availability/pit-audit",
    assumptions: [],
  };
  if (request.spec.mockInvalidRate === true) {
    response.contaminatedSelectionRate = 1.2;
  }
  process.stdout.write(JSON.stringify(response));
}
