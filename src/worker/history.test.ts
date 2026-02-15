import { describe, it, expect, beforeEach } from "vitest";
import { HistoryStore, type HistoryMessage } from "./history.js";

function makeMessage(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    role: overrides.role ?? "user",
    content: overrides.content ?? "test message",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    invocationId: overrides.invocationId ?? "inv-1",
    ...(overrides.toolCalls ? { toolCalls: overrides.toolCalls } : {}),
  };
}

describe("HistoryStore", () => {
  let store: HistoryStore;

  beforeEach(() => {
    store = new HistoryStore();
  });

  it("appends and retrieves messages", () => {
    const msg = makeMessage({ content: "hello" });
    store.append(msg);

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("hello");
  });

  it("returns messages in insertion order", () => {
    store.append(makeMessage({ content: "first" }));
    store.append(makeMessage({ content: "second" }));
    store.append(makeMessage({ content: "third" }));

    const all = store.getAll();
    expect(all.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("caps at maxSize, evicting oldest", () => {
    const small = new HistoryStore(3);
    small.append(makeMessage({ content: "a" }));
    small.append(makeMessage({ content: "b" }));
    small.append(makeMessage({ content: "c" }));
    small.append(makeMessage({ content: "d" }));

    const all = small.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.content)).toEqual(["b", "c", "d"]);
  });

  it("defaults maxSize to 1000", () => {
    const big = new HistoryStore();
    for (let i = 0; i < 1001; i++) {
      big.append(makeMessage({ content: `msg-${i}` }));
    }

    expect(big.count).toBe(1000);
    const all = big.getAll();
    expect(all[0].content).toBe("msg-1");
    expect(all[999].content).toBe("msg-1000");
  });

  it("clear removes all messages", () => {
    store.append(makeMessage());
    store.append(makeMessage());
    expect(store.count).toBe(2);

    store.clear();
    expect(store.count).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it("count tracks the number of messages", () => {
    expect(store.count).toBe(0);
    store.append(makeMessage());
    expect(store.count).toBe(1);
    store.append(makeMessage());
    expect(store.count).toBe(2);
  });

  it("getAll returns a copy, not a reference", () => {
    store.append(makeMessage({ content: "original" }));
    const all = store.getAll();
    all.push(makeMessage({ content: "injected" }));

    expect(store.count).toBe(1);
    expect(store.getAll()).toHaveLength(1);
  });

  it("preserves toolCalls on messages", () => {
    const tools = [{ toolName: "read_file", toolInput: { path: "/tmp/x" } }];
    store.append(makeMessage({ role: "assistant", toolCalls: tools }));

    const all = store.getAll();
    expect(all[0].toolCalls).toEqual(tools);
  });
});
