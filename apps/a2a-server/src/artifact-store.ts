import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts";

export interface AuditArtifactStore {
  save(taskId: string, artifact: AuditArtifact): Promise<void>;
  load(taskId: string): Promise<AuditArtifact | undefined>;
}

/**
 * Skeleton persistence boundary. The interface is intentionally durable-store
 * shaped even though this phase keeps records in memory.
 */
export class InMemoryAuditArtifactStore implements AuditArtifactStore {
  readonly #artifacts = new Map<string, AuditArtifact>();

  async save(taskId: string, artifact: AuditArtifact): Promise<void> {
    const id = taskId.trim();
    if (id.length === 0) {
      throw new Error("Cannot persist an Artifact without a task id");
    }
    const validated = parseAuditArtifact(artifact);
    this.#artifacts.set(id, structuredClone(validated));
  }

  async load(taskId: string): Promise<AuditArtifact | undefined> {
    const artifact = this.#artifacts.get(taskId);
    return artifact === undefined ? undefined : structuredClone(artifact);
  }
}
