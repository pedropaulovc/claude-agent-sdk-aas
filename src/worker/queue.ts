import {
  logInfo,
  logWarn,
  logError,
  countMetric,
} from "../telemetry/helpers.js";

export type SseEvent =
  | { event: "init"; data: { invocationId: string; instanceName: string; model: string; turn: number } }
  | { event: "assistant_text"; data: { text: string; turn: number } }
  | { event: "tool_use"; data: { toolName: string; toolInput: unknown; toolUseId: string; turn: number } }
  | { event: "tool_result"; data: { toolUseId: string; result: unknown; turn: number } }
  | { event: "turn_complete"; data: { turn: number; stopReason: string } }
  | { event: "done"; data: { invocationId: string; turns: number; costUsd: number; durationMs: number; stopReason: string; sessionId: string } }
  | { event: "error"; data: { invocationId: string; error: string; code?: string; stderr?: string } }
  | { event: "queued"; data: { invocationId: string; position: number } };

export type QueueItem = {
  invocationId: string;
  message: string;
  onEvent: (event: SseEvent) => void;
  signal: AbortSignal;
};

export type RunFn = (
  message: string,
  invocationId: string,
  signal: AbortSignal,
) => AsyncGenerator<SseEvent>;

export class QueueFullError extends Error {
  constructor(maxSize: number) {
    super(`Queue is full (max ${maxSize})`);
    this.name = "QueueFullError";
  }
}

export class InvocationQueue {
  private readonly maxSize: number;
  private readonly queue: QueueItem[] = [];
  private activeItem: QueueItem | null = null;
  private activeAbortController: AbortController | null = null;
  private runFn: RunFn | null = null;
  private processing = false;

  constructor(maxSize: number = 25) {
    this.maxSize = maxSize;
  }

  setRunner(runFn: RunFn): void {
    this.runFn = runFn;
  }

  enqueue(item: QueueItem): number {
    if (this.queue.length >= this.maxSize) {
      throw new QueueFullError(this.maxSize);
    }

    this.queue.push(item);
    const position = this.activeItem ? this.queue.length : this.queue.length - 1;

    logInfo("Invocation enqueued", {
      invocationId: item.invocationId,
      position,
      queueDepth: this.queue.length,
    });
    countMetric("invocation.enqueued", 1);

    if (!this.processing) {
      void this.processNext();
    }

    return position;
  }

  get depth(): number {
    return this.queue.length;
  }

  get activeInvocationId(): string | null {
    return this.activeItem?.invocationId ?? null;
  }

  abort(): { aborted: boolean; invocationId: string | null } {
    if (!this.activeAbortController || !this.activeItem) {
      return { aborted: false, invocationId: null };
    }

    const invocationId = this.activeItem.invocationId;
    logWarn("Aborting active invocation", { invocationId });
    this.activeAbortController.abort();
    countMetric("invocation.aborted", 1);

    return { aborted: true, invocationId };
  }

  clear(): void {
    const cleared = this.queue.length;
    this.queue.length = 0;
    logInfo("Queue cleared", { itemsCleared: cleared });
  }

  private async processNext(): Promise<void> {
    if (this.processing) {
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      return;
    }

    if (!this.runFn) {
      logError("No runner function set on InvocationQueue");
      item.onEvent({
        event: "error",
        data: { invocationId: item.invocationId, error: "Queue runner not configured", code: "runner_not_configured" },
      });
      return;
    }

    this.processing = true;
    this.activeAbortController = new AbortController();
    this.activeItem = item;

    // Link the item's abort signal to our internal controller
    if (item.signal.aborted) {
      this.activeAbortController.abort();
    } else {
      item.signal.addEventListener("abort", () => {
        this.activeAbortController?.abort();
      }, { once: true });
    }

    try {
      const events = this.runFn(
        item.message,
        item.invocationId,
        this.activeAbortController.signal,
      );

      for await (const event of events) {
        item.onEvent(event);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError("Invocation failed", {
        invocationId: item.invocationId,
        error: errorMessage,
      });
      item.onEvent({
        event: "error",
        data: { invocationId: item.invocationId, error: errorMessage },
      });
    } finally {
      this.activeItem = null;
      this.activeAbortController = null;
      this.processing = false;
      void this.processNext();
    }
  }
}
