import type * as CapabilitiesModule from "../../src/utils/tool-capabilities";

let policy: typeof CapabilitiesModule;

beforeEach(async () => {
  vi.resetModules();
  policy = await import("../../src/utils/tool-capabilities");
});

describe("empty capability requirements in the exported policy", () => {
  it("registers a no-requirement entry without advertising it as read-only", () => {
    // The exported Record permits policy entries with no B2 requirements.
    // Exercise that configuration without changing the shipped tool surface.
    const name = "b2_extension_without_required_capabilities";
    policy.TOOL_CAPABILITIES[name] = [];
    try {
      expect(policy.isToolEnabled(name, new Set())).toBe(true);
      expect(policy.isToolEnabled(name, new Set(["readFiles"]))).toBe(true);
      expect(policy.isToolEnabled(name, null)).toBe(true);
      // No B2 requirements must not grant an unclassified tool OAuth access.
      expect(policy.isToolAllowedByOAuthScopes(name, new Set(["b2:read"]))).toBe(false);
      expect(policy.isToolAllowedByOAuthScopes(name, new Set(["b2:admin"]))).toBe(true);
      expect(policy.hasReadOnlyToolCapabilities(name)).toBe(false);
      expect(policy.annotationsForTool(name)).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    } finally {
      delete policy.TOOL_CAPABILITIES[name];
    }
  });
});
