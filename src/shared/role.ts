export const VALID_ROLES = ["control-plane", "worker"] as const;
export type AasRole = (typeof VALID_ROLES)[number];

export function validateRole(raw: string | undefined): AasRole {
  if (!raw) {
    console.warn("Warning: AAS_ROLE not set, defaulting to 'control-plane'");
    return "control-plane";
  }

  if (!VALID_ROLES.includes(raw as AasRole)) {
    throw new Error(`AAS_ROLE="${raw}" is invalid. Must be 'control-plane' or 'worker'.`);
  }

  return raw as AasRole;
}
