import { runV9RealAcceptance } from "./v9-real-data";

const artifactPath = await runV9RealAcceptance();
process.stdout.write(`local golden A2A E2E passed: ${artifactPath}\n`);
