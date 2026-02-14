import { describe, it, expect } from "vitest";
import { validateRole } from "./role.js";

describe("validateRole", () => {
  it("returns 'control-plane' for valid input", () => {
    expect(validateRole("control-plane")).toBe("control-plane");
  });

  it("returns 'worker' for valid input", () => {
    expect(validateRole("worker")).toBe("worker");
  });

  it("defaults to 'control-plane' when undefined", () => {
    expect(validateRole(undefined)).toBe("control-plane");
  });

  it("defaults to 'control-plane' when empty string", () => {
    expect(validateRole("")).toBe("control-plane");
  });

  it("throws on invalid value", () => {
    expect(() => validateRole("invalid")).toThrow('AAS_ROLE="invalid" is invalid');
  });

  it("throws on close-but-wrong value", () => {
    expect(() => validateRole("controlplane")).toThrow("invalid");
  });
});
