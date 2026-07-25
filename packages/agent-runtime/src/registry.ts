import type { AuditCheckResult } from "@assay/contracts";
import type { AgentState, AgentTool } from "@oh-my-pi/pi-agent-core";

export interface AgentSubmissionValidationContext {
  readonly submission: AuditCheckResult;
  readonly evidenceTool: {
    readonly name: string;
    readonly details: unknown;
  };
}

export type AgentSubmissionValidator = (
  context: AgentSubmissionValidationContext,
) => void | Promise<void>;

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: readonly string[];
  tools?: readonly AgentTool[];
  thinkingLevel?: AgentState["thinkingLevel"];
  /**
   * Optional host-owned semantic validation for submit_check_result.
   *
   * AgentRuntime supplies the accepted schema result plus the successful
   * evidence tool's opaque details payload. Domain packages can therefore
   * enforce their own submission contract without AgentRuntime importing
   * domain implementations.
   */
  submissionValidator?: AgentSubmissionValidator;
}

export class AgentRegistry {
  readonly #definitions = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: AgentDefinition): void {
    const id = definition.id.trim();
    if (!id) {
      throw new Error("Agent id cannot be empty");
    }
    if (this.#definitions.has(id)) {
      throw new Error(`Agent "${id}" is already registered`);
    }
    if (definition.systemPrompt.length === 0) {
      throw new Error(`Agent "${id}" must have at least one system prompt`);
    }

    this.#definitions.set(id, {
      ...definition,
      id,
      systemPrompt: [...definition.systemPrompt],
      tools: [...(definition.tools ?? [])],
    });
  }

  get(id: string): AgentDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown agent "${id}". Available agents: ${this.ids().join(", ")}`);
    }
    return definition;
  }

  ids(): string[] {
    return [...this.#definitions.keys()].sort();
  }
}
