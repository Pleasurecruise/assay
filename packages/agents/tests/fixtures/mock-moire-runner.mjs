const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  typeof request?.spec !== "object" ||
  request.dataRef !==
    "assay-local-data-v1:audit_test:g01:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
) {
  process.exitCode = 2;
} else if (request.kind === "regime_slice_of_grid") {
  process.stdout.write(
    JSON.stringify({
      id: "M1",
      kind: "regime_slice_of_grid",
      sourceRef:
        process.env.MOCK_INVALID_MOIRE === "1"
          ? "/private/moire.json"
          : "artifact:moire/M1/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      dominantEnvironmentId: "up-normal",
      dominantRetention: 0.75,
      otherEnvironmentRetentions: [
        { environmentId: "down-high", retention: 0.3 },
        { environmentId: "down-normal", retention: 0.25 },
      ],
    }),
  );
} else if (request.kind === "corrected_cost_ladder") {
  process.stdout.write(
    JSON.stringify({
      id: "M2",
      kind: "corrected_cost_ladder",
      sourceRef:
        "artifact:moire/M2/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      correctedCostConclusion: "fail",
    }),
  );
} else {
  process.exitCode = 2;
}
