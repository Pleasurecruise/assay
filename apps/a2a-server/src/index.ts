import { createProductionA2AApp, readProductionConfig } from "./production";

export * from "./agent-card";
export * from "./artifact-store";
export * from "./auth";
export * from "./audit-orchestrator";
export * from "./database";
export * from "./execution-timeline";
export * from "./executor";
export * from "./local-data-package";
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
  const { app } = await createProductionA2AApp(readProductionConfig());
  const server = app.listen(port, "0.0.0.0");

  server.once("listening", () => {
    if (server.address() === null) {
      process.stderr.write(`Assay A2A Server failed to bind port ${port}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Assay A2A Server listening on port ${port}\n`);
  });

  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(`Assay A2A Server cannot start: port ${port} is already in use\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
}
