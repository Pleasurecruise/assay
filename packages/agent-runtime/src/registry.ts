import type {
  AgentState,
  AgentTool,
} from "@oh-my-pi/pi-agent-core";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: readonly string[];
  tools?: readonly AgentTool[];
  thinkingLevel?: AgentState["thinkingLevel"];
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
      throw new Error(
        `Unknown agent "${id}". Available agents: ${this.ids().join(", ")}`,
      );
    }
    return definition;
  }

  ids(): string[] {
    return [...this.#definitions.keys()].sort();
  }
}
