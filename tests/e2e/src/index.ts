import { runV9RealAcceptance } from "./v9-real-data";

const outputPath = await runV9RealAcceptance();
process.stdout.write(`v9 real-data acceptance passed: ${outputPath}\n`);
