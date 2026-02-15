export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO string
  invocationId: string;
  toolCalls?: Array<{ toolName: string; toolInput: unknown }>;
};

export class HistoryStore {
  private messages: HistoryMessage[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  append(message: HistoryMessage): void {
    if (this.messages.length >= this.maxSize) {
      this.messages.shift();
    }
    this.messages.push(message);
  }

  getAll(): HistoryMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }

  get count(): number {
    return this.messages.length;
  }
}
