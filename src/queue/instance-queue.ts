import { logInfo, logWarn, countMetric } from "../telemetry/helpers.js";

const MAX_QUEUE_DEPTH = 25;

export type QueuedInvocation = {
  prompt: string;
  abortController: AbortController;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

export class InstanceQueue {
  private queues = new Map<string, QueuedInvocation[]>();

  /** Returns the current queue depth for an instance */
  depth(instanceName: string): number {
    return this.queues.get(instanceName)?.length ?? 0;
  }

  /**
   * Enqueue an invocation. Returns a promise that resolves when it's this
   * invocation's turn to run. Rejects immediately if queue is full.
   */
  enqueue(instanceName: string, prompt: string, abortController: AbortController): Promise<void> {
    const queue = this.queues.get(instanceName) ?? [];
    if (queue.length >= MAX_QUEUE_DEPTH) {
      logWarn(`${instanceName} | queue.full`, { depth: queue.length });
      throw new QueueFullError(instanceName);
    }

    return new Promise<void>((resolve, reject) => {
      queue.push({ prompt, abortController, resolve, reject });
      this.queues.set(instanceName, queue);
      logInfo(`${instanceName} | queue.enqueue`, { depth: queue.length });
      countMetric("queue.depth", queue.length, { instance: instanceName });
    });
  }

  /** Dequeue the next invocation. Returns null if queue is empty. */
  dequeue(instanceName: string): QueuedInvocation | null {
    const queue = this.queues.get(instanceName);
    if (!queue || queue.length === 0) return null;

    const item = queue.shift();
    if (!item) return null;

    logInfo(`${instanceName} | queue.dequeue`, { remaining: queue.length });
    countMetric("queue.depth", queue.length, { instance: instanceName });

    if (queue.length === 0) {
      this.queues.delete(instanceName);
    }

    return item;
  }

  /** Clear queue for an instance (used during nuke). Rejects all pending. */
  clear(instanceName: string): number {
    const queue = this.queues.get(instanceName);
    if (!queue) return 0;

    const count = queue.length;
    for (const item of queue) {
      item.reject(new Error("Instance nuked"));
    }
    this.queues.delete(instanceName);
    return count;
  }

  /** Clear all queues matching a prefix */
  clearByPrefix(prefix: string): number {
    let total = 0;
    for (const [name] of this.queues) {
      if (name === prefix || name.startsWith(`${prefix}/`)) {
        total += this.clear(name);
      }
    }
    return total;
  }
}

export class QueueFullError extends Error {
  constructor(public readonly instanceName: string) {
    super(`Queue full for instance "${instanceName}"`);
  }
}

export const instanceQueue = new InstanceQueue();
