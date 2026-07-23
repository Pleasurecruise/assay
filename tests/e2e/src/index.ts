import { AgentRegistry, AgentRuntime } from "@assay/agent-runtime";
import { agentDefinitions, ParallelAuditCheckRunner } from "@assay/agents";
import { AUDIT_CHECK_IDS, AUDIT_CHECK_SCHEMA_VERSION } from "@assay/contracts";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog";

const DEFAULT_INPUT =
  "CSI 300 monthly momentum: rank by trailing 20-day return, hold the top 50 " +
  "equal-weighted names, and rebalance monthly.";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const provider = Bun.env.ASSAY_MODEL_PROVIDER ?? "deepseek";
const modelId = Bun.env.ASSAY_MODEL_ID ?? "deepseek-chat";
const apiKey =
  Bun.env.ASSAY_MODEL_API_KEY ?? (provider === "deepseek" ? Bun.env.DEEPSEEK_API_KEY : undefined);
const timeoutMs = positiveInteger(Bun.env.ASSAY_E2E_TIMEOUT_MS, 120_000, "ASSAY_E2E_TIMEOUT_MS");

if (!apiKey) {
  throw new Error("Missing ASSAY_MODEL_API_KEY (DEEPSEEK_API_KEY is also accepted for DeepSeek)");
}

const model = getBundledModels(provider as GeneratedProvider).find(
  (candidate) => candidate.id === modelId,
);
if (!model) {
  throw new Error(`Model "${provider}/${modelId}" is not present in the bundled catalog`);
}

const branchStarts = new Map<string, number>();
const branchCompletions = new Set<string>();
const runtime = new AgentRuntime({
  model,
  registry: new AgentRegistry(agentDefinitions),
  getApiKey: () => apiKey,
  maxRunMs: timeoutMs,
  onEvent: (event) => {
    if (event.type === "agent.started") {
      branchStarts.set(event.agentId, performance.now());
      process.stderr.write(`[started] ${event.agentId}\n`);
    }
    if (event.type === "agent.completed") {
      branchCompletions.add(event.agentId);
      process.stderr.write(`[completed] ${event.agentId}\n`);
    }
  },
});

const runner = new ParallelAuditCheckRunner(runtime, timeoutMs);
const result = await runner.run({
  schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
  auditId: Bun.env.ASSAY_E2E_AUDIT_ID ?? "e2e_parallel_checks",
  skill: "audit_strategy",
  subject: {
    id: Bun.env.ASSAY_E2E_SUBJECT_ID ?? "e2e_strategy",
    kind: "strategy",
    input: Bun.env.ASSAY_E2E_INPUT?.trim() || DEFAULT_INPUT,
  },
});

if (branchStarts.size !== AUDIT_CHECK_IDS.length) {
  throw new Error(`Expected ${AUDIT_CHECK_IDS.length} started branches, got ${branchStarts.size}`);
}
if (branchCompletions.size !== AUDIT_CHECK_IDS.length) {
  throw new Error(
    `Expected ${AUDIT_CHECK_IDS.length} completed branches, got ${branchCompletions.size}`,
  );
}

const hostFallbacks = result.checks.filter((check) =>
  check.missingEvidence.some((item) =>
    item.sourceRefs.some((sourceRef) => sourceRef.startsWith("runtime-error:")),
  ),
);
if (hostFallbacks.length > 0) {
  throw new Error(
    `Branches failed before producing valid contract JSON: ${hostFallbacks
      .map((check) => check.id)
      .join(", ")}`,
  );
}

const unexpectedConclusions = result.checks.filter(
  (check) => check.conclusion !== "insufficient_evidence",
);
if (unexpectedConclusions.length > 0) {
  throw new Error(
    `Tool-free E2E expected insufficient_evidence, got: ${unexpectedConclusions
      .map((check) => `${check.id}=${check.conclusion}`)
      .join(", ")}`,
  );
}

const startTimes = [...branchStarts.values()];
const fanOutSpreadMs = Math.max(...startTimes) - Math.min(...startTimes);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      provider,
      modelId,
      fanOutSpreadMs: Math.round(fanOutSpreadMs),
      result,
    },
    null,
    2,
  )}\n`,
);
