import { describe, it, expect } from "vitest";
import { instanceNameSchema, provisionSchema } from "./types.js";

describe("registry types", () => {
  // --- instanceNameSchema ---

  it("accepts simple alphanumeric name", () => {
    expect(instanceNameSchema.safeParse("michael").success).toBe(true);
  });

  it("accepts name with dots, dashes, and underscores", () => {
    expect(instanceNameSchema.safeParse("my-instance_v2.0").success).toBe(true);
  });

  it("accepts hierarchical name with slashes", () => {
    expect(instanceNameSchema.safeParse("dev/A/michael").success).toBe(true);
  });

  it("accepts complex hierarchical name", () => {
    expect(instanceNameSchema.safeParse("prod/office/michael.scott").success).toBe(true);
  });

  it("rejects leading slash", () => {
    expect(instanceNameSchema.safeParse("/leading").success).toBe(false);
  });

  it("rejects trailing slash", () => {
    expect(instanceNameSchema.safeParse("trailing/").success).toBe(false);
  });

  it("rejects double slash", () => {
    expect(instanceNameSchema.safeParse("double//slash").success).toBe(false);
  });

  it("rejects segment starting with dot", () => {
    expect(instanceNameSchema.safeParse(".starts-with-dot").success).toBe(false);
  });

  it("rejects name with spaces", () => {
    expect(instanceNameSchema.safeParse("has spaces").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(instanceNameSchema.safeParse("").success).toBe(false);
  });

  // --- provisionSchema ---

  it("applies default model when not provided", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
    });
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  it("applies default maxTurns when not provided", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
    });
    expect(result.maxTurns).toBe(50);
  });

  it("applies default maxBudgetUsd when not provided", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
    });
    expect(result.maxBudgetUsd).toBe(1.0);
  });

  it("applies default empty mcpServers when not provided", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
    });
    expect(result.mcpServers).toEqual([]);
  });

  it("requires name", () => {
    const result = provisionSchema.safeParse({
      systemPrompt: "You are a helper.",
    });
    expect(result.success).toBe(false);
  });

  it("requires systemPrompt", () => {
    const result = provisionSchema.safeParse({
      name: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid name via provisionSchema", () => {
    const result = provisionSchema.safeParse({
      name: "/bad-name",
      systemPrompt: "You are a helper.",
    });
    expect(result.success).toBe(false);
  });

  it("accepts remote MCP server config", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
      mcpServers: [{ name: "remote", url: "https://example.com/mcp" }],
    });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]).toHaveProperty("url");
  });

  it("accepts stdio MCP server config", () => {
    const result = provisionSchema.parse({
      name: "test",
      systemPrompt: "You are a helper.",
      mcpServers: [{ name: "local", command: "npx", args: ["-y", "mcp-server"] }],
    });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]).toHaveProperty("command");
  });

  it("overrides defaults when values are provided", () => {
    const result = provisionSchema.parse({
      name: "custom",
      systemPrompt: "Custom prompt.",
      model: "claude-sonnet-4-20250514",
      maxTurns: 10,
      maxBudgetUsd: 5.0,
    });
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.maxTurns).toBe(10);
    expect(result.maxBudgetUsd).toBe(5.0);
  });
});
