import { createProductionA2AApp, readProductionConfig } from "./production";

export * from "./agent-card";
export * from "./artifact-store";
export * from "./audit-orchestrator";
export * from "./execution-timeline";
export * from "./executor";
export * from "./production";
export * from "./server";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3001");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ASSAY_A2A_PORT must be an integer between 1 and 65535");
  }
  return port;
}

if (import.meta.main) {
  const port = parsePort(process.env.ASSAY_A2A_PORT);
  const { app } = createProductionA2AApp(readProductionConfig());
  app.listen(port, "0.0.0.0", () => {
    process.stdout.write(`Assay A2A Server listening on port ${port}\n`);
  });
}
