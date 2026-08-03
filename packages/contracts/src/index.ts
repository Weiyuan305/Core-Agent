export const CONTRACT_PACKAGE_VERSION = "0.1.0" as const;
export const WIRE_SCHEMA_VERSION = 1 as const;

export * from "./common/primitives.js";
export * from "./common/validation.js";
export * from "./runtime/refs.js";
export * from "./tenant/identity.js";
export * from "./profile/profile.js";
export * from "./approval/schema.js";
export * from "./runtime/resources.js";
export * from "./runtime/transitions.js";
export * from "./runtime/invariants.js";
