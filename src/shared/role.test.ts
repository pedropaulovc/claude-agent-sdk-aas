import { describe, it, expect } from "vitest";
import { validateRole } from "./role.js";

describe("validateRole", () => {
  it("returns 'control-plane' for valid input", () => {
    expect(validateRole("control-plane")).toBe("control-plane");
  });

  it("returns 'worker' for valid input", () => {
    expect(validateRole("worker")).toBe("worker");
  });

  it("throws on undefined (missing AAS_ROLE)", () => {
    expect(() => validateRole(undefined)).toThrow("AAS_ROLE environment variable is required");
  });

  it("throws on empty string", () => {
    expect(() => validateRole("")).toThrow("AAS_ROLE environment variable is required");
  });

  it("throws on invalid value", () => {
    expect(() => validateRole("invalid")).toThrow('AAS_ROLE="invalid" is invalid');
  });

  it("throws on close-but-wrong value", () => {
    expect(() => validateRole("controlplane")).toThrow("invalid");
  });
});
