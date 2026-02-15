import { logInfo, countMetric, withSpan } from "../telemetry/helpers.js";
import type { InstanceRecord, ProvisionRequest, UpdateRequest } from "../shared/types.js";

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code: "conflict" | "not_found",
  ) {
    super(message);
  }
}

export class InstanceStore {
  private instances = new Map<string, InstanceRecord>();

  get size(): number {
    return this.instances.size;
  }

  async provision(request: ProvisionRequest): Promise<InstanceRecord> {
    return withSpan("instance.provision", "registry", async () => {
      if (this.instances.has(request.name)) {
        throw new StoreError(`Instance "${request.name}" already exists`, "conflict");
      }

      const instance: InstanceRecord = {
        name: request.name,
        systemPrompt: request.systemPrompt,
        mcpServers: request.mcpServers,
        model: request.model,
        maxTurns: request.maxTurns,
        maxBudgetUsd: request.maxBudgetUsd,
        status: "provisioning",
        railwayServiceId: null,
        workerUrl: null,
        workerNumber: null,
        provisionError: null,
        createdAt: new Date(),
      };

      this.instances.set(request.name, instance);
      logInfo(`${request.name} | provision`, { model: request.model, mcpServers: request.mcpServers.length });
      countMetric("instance.count", 1);
      return instance;
    });
  }

  get(name: string): InstanceRecord | null {
    return this.instances.get(name) ?? null;
  }

  list(prefix?: string): InstanceRecord[] {
    if (!prefix) return Array.from(this.instances.values());

    return Array.from(this.instances.values()).filter(
      (i) => i.name === prefix || i.name.startsWith(`${prefix}/`),
    );
  }

  async update(name: string, updates: UpdateRequest): Promise<InstanceRecord> {
    return withSpan("instance.update", "registry", async () => {
      const instance = this.instances.get(name);
      if (!instance) {
        throw new StoreError(`Instance "${name}" not found`, "not_found");
      }
      if (instance.status === "provisioning" || instance.status === "destroying") {
        throw new StoreError(`Instance "${name}" cannot be updated while ${instance.status}`, "conflict");
      }

      if (updates.systemPrompt !== undefined) instance.systemPrompt = updates.systemPrompt;
      if (updates.mcpServers !== undefined) instance.mcpServers = updates.mcpServers;
      if (updates.model !== undefined) instance.model = updates.model;
      if (updates.maxTurns !== undefined) instance.maxTurns = updates.maxTurns;
      if (updates.maxBudgetUsd !== undefined) instance.maxBudgetUsd = updates.maxBudgetUsd;

      instance.status = "deploying";

      logInfo(`${name} | update`, { fields: Object.keys(updates) });
      return instance;
    });
  }

  delete(name: string): number {
    const deleted = this.instances.delete(name) ? 1 : 0;
    if (deleted) {
      logInfo(`${name} | delete`);
      countMetric("instance.count", -1);
    }
    return deleted;
  }

  clear(): void {
    this.instances.clear();
  }

  nukeByPrefix(prefix: string): number {
    const toDelete = Array.from(this.instances.keys()).filter(
      (name) => name === prefix || name.startsWith(`${prefix}/`),
    );

    for (const name of toDelete) {
      this.instances.delete(name);
    }

    if (toDelete.length > 0) {
      logInfo(`${prefix} | nuke`, { deleted: toDelete.length });
      countMetric("nuke.count", 1, { prefix });
      countMetric("instance.count", -toDelete.length);
    }

    return toDelete.length;
  }
}

// Singleton instance store
export const store = new InstanceStore();
