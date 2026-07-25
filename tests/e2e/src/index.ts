import { runV9RealAcceptance } from "./v9-real-data";

const artifactPath = await runV9RealAcceptance();
process.stdout.write(`G01/G02/G03 local-data A2A E2E suite passed: ${artifactPath}\n`);
