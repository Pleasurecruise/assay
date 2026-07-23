import { AgentRegistry, AgentRuntime } from "@assay/agent-runtime";
import { agentDefinitions } from "@assay/agents";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog";

const provider = Bun.env.ASSAY_MODEL_PROVIDER ?? "deepseek";
const modelId = Bun.env.ASSAY_MODEL_ID ?? "deepseek-chat";
const apiKey =
  Bun.env.ASSAY_MODEL_API_KEY ?? (provider === "deepseek" ? Bun.env.DEEPSEEK_API_KEY : undefined);
const input = Bun.argv.slice(2).join(" ").trim();

if (!input) {
  throw new Error('Usage: bun run runtime -- "your research task"');
}
if (!apiKey) {
  throw new Error("Missing ASSAY_MODEL_API_KEY (DEEPSEEK_API_KEY is also accepted for DeepSeek)");
}

const model = getBundledModels(provider as GeneratedProvider).find(
  (candidate) => candidate.id === modelId,
);
if (!model) {
  throw new Error(`Model "${provider}/${modelId}" is not present in the bundled oh-my-pi catalog`);
}

const agentId = Bun.env.ASSAY_AGENT_ID ?? "param-robustness";
const runtime = new AgentRuntime({
  model,
  registry: new AgentRegistry(agentDefinitions),
  getApiKey: () => apiKey,
  onEvent: (event) => {
    if (event.type === "agent.delta") {
      process.stdout.write(event.delta);
    }
  },
});

const result = await runtime.run({
  agentId,
  input,
});

if (!result.output.endsWith("\n")) {
  process.stdout.write("\n");
}
