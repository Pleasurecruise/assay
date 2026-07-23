import { describe, expect, test } from "vitest";
import { AgentRegistry } from "./registry";
import { ToolPolicy, resolveToolApproval } from "./policy";

describe("AgentRegistry", () => {
  test("rejects duplicate agent ids", () => {
    const registry = new AgentRegistry([
      {
        id: "research",
        name: "Research",
        description: "Research agent",
        systemPrompt: ["Research carefully."],
      },
    ]);

    expect(() =>
      registry.register({
        id: "research",
        name: "Duplicate",
        description: "Duplicate",
        systemPrompt: ["Duplicate."],
      }),
    ).toThrow('Agent "research" is already registered');
  });
});

describe("ToolPolicy", () => {
  const baseRequest = {
    agentId: "research",
    taskId: "task-1",
    traceId: "trace-1",
    toolCallId: "call-1",
    toolName: "market_data",
  };

  test("allows read tools without approval", async () => {
    const decision = await new ToolPolicy().evaluate(baseRequest, "read", {});
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("read");
  });

  test("denies undeclared tools as exec", async () => {
    const decision = await new ToolPolicy().evaluate(baseRequest, undefined, {});
    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("exec");
  });

  test("delegates write approval to the host", async () => {
    const policy = new ToolPolicy(async (request) => {
      return request.toolName === "save_report" && request.tier === "write";
    });
    const decision = await policy.evaluate(
      { ...baseRequest, toolName: "save_report" },
      { tier: "write", reason: "Persists a report artifact" },
      {},
    );
    expect(decision.allowed).toBe(true);
  });

  test("resolves dynamic approval declarations", () => {
    const approval = resolveToolApproval(
      (args) => ((args as { dryRun?: boolean }).dryRun ? "read" : "exec"),
      { dryRun: true },
    );
    expect(approval).toBe("read");
  });
});
