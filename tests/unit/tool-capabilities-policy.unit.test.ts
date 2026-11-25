import fullContract from "../fixtures/tool-contract/full.modern.json";
import type { B2Config } from "../../src/utils/types";

type Policy = typeof import("../../src/utils/tool-capabilities");
let policy: Policy;

// Load policy data during the test, after Stryker activates its mutant. Module
// scope imports can otherwise retain tables created before mutant activation.
beforeEach(async () => {
  vi.resetModules();
  policy = await import("../../src/utils/tool-capabilities");
});

// Independent authorization examples from the native/S3 operation contracts in
// docs/design-docs/sdk-adoption-contract.md. Do not derive expected grants from
// TOOL_CAPABILITIES: that would let a changed policy change its own expectation.
const capabilityProfiles = [
  {
    capability: "listBuckets",
    tools: ["b2_list_buckets", "s3_head_bucket", "s3_get_bucket_location"],
  },
  {
    capability: "writeBuckets",
    tools: ["b2_create_bucket", "b2_update_bucket", "s3_put_bucket_lifecycle"],
  },
  { capability: "deleteBuckets", tools: ["b2_delete_bucket"] },
  { capability: "readBucketNotifications", tools: ["b2_get_bucket_notification_rules"] },
  {
    capability: "writeBucketNotifications",
    tools: ["b2_get_bucket_notification_rules", "b2_set_bucket_notification_rules"],
  },
  { capability: "writeKeys", tools: ["b2_create_key"] },
  { capability: "listKeys", tools: ["b2_list_keys"] },
  { capability: "deleteKeys", tools: ["b2_delete_key"] },
  { capability: "writeFileRetentions", tools: ["b2_update_file_retention"] },
  { capability: "writeFileLegalHolds", tools: ["b2_update_file_legal_hold"] },
  {
    capability: "readFiles",
    tools: [
      "b2_report_usage_growth",
      "b2_rank_egress_leaders",
      "s3_get_object",
      "s3_head_object",
      "s3_get_presigned_url",
    ],
  },
  {
    capability: "listFiles",
    tools: [
      "b2_list_largest_files",
      "b2_unfinished_uploads",
      "s3_list_objects_v2",
      "s3_list_object_versions",
      "s3_list_parts",
      "s3_list_multipart_uploads",
    ],
  },
  {
    capability: "writeFiles",
    tools: [
      "s3_put_object",
      "s3_copy_object",
      "s3_create_multipart_upload",
      "s3_get_presigned_upload_part_url",
      "s3_complete_multipart_upload",
      "s3_abort_multipart_upload",
      "s3_upload_part_copy",
      "s3_get_presigned_url",
    ],
  },
  { capability: "deleteFiles", tools: ["s3_delete_object", "s3_delete_objects"] },
];

// These names bypass only the B2 capability helper. Partner entitlement,
// master-key routing, OAuth, and secret-sink availability remain separate gates.
const capabilityExemptTools = [
  "b2_authorize_account",
  "b2_list_groups",
  "b2_create_group_member",
  "b2_eject_group_member",
  "b2_list_group_members",
  "b2_reserve_trial_create_account",
];

// Reviewed deployment-scope examples: reads, object/bucket writes, and the
// administrative key/Partner/protection/notification operations. Keep these
// independent of OAUTH_TOOL_SCOPE_POLICY and its operation-scope lookup table.
const oauthReadTools = [
  "b2_authorize_account",
  "b2_rank_egress_leaders",
  "b2_list_largest_files",
  "b2_list_buckets",
  "b2_unfinished_uploads",
  "b2_report_usage_growth",
  "s3_get_bucket_location",
  "s3_get_object",
  "s3_get_presigned_url",
  "s3_head_bucket",
  "s3_head_object",
  "s3_list_multipart_uploads",
  "s3_list_object_versions",
  "s3_list_objects_v2",
  "s3_list_parts",
];
const oauthWriteTools = [
  "b2_create_bucket",
  "b2_delete_bucket",
  "s3_abort_multipart_upload",
  "s3_complete_multipart_upload",
  "s3_copy_object",
  "s3_create_multipart_upload",
  "s3_delete_object",
  "s3_delete_objects",
  "s3_get_presigned_upload_part_url",
  "s3_put_object",
  "s3_upload_part_copy",
];
const oauthAdminTools = [
  "b2_create_group_member",
  "b2_create_key",
  "b2_delete_key",
  "b2_eject_group_member",
  "b2_get_bucket_notification_rules",
  "b2_list_group_members",
  "b2_list_groups",
  "b2_list_keys",
  "b2_reserve_trial_create_account",
  "b2_set_bucket_notification_rules",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "s3_put_bucket_lifecycle",
];

describe("independent B2 capability policy", () => {
  it.each(capabilityProfiles)(
    "grants exactly the $capability operations",
    ({ capability, tools }) => {
      const expected = new Set([...tools, ...capabilityExemptTools]);
      for (const name of fullContract.names) {
        expect(policy.isToolEnabled(name, new Set([capability])), name).toBe(expected.has(name));
      }
    },
  );

  it.each([
    { capabilities: [] },
    { capabilities: ["unrelated"] },
    { capabilities: ["readfiles"] },
    { capabilities: ["readFiles:extra"] },
  ])(
    "does not grant mapped tools for unsupported capabilities $capabilities",
    ({ capabilities }) => {
      for (const name of fullContract.names) {
        expect(policy.isToolEnabled(name, new Set(capabilities)), name).toBe(
          capabilityExemptTools.includes(name),
        );
      }
    },
  );

  it("keeps explicit full-surface mode and the unmapped-tool compatibility policy", () => {
    for (const name of [...fullContract.names, "future_tool"]) {
      expect(policy.isToolEnabled(name, null), name).toBe(true);
    }
    expect(policy.isToolEnabled("future_tool", new Set())).toBe(true);
  });

  it("classifies the Partner entitlement exemptions separately from bootstrap authorization", () => {
    expect([...policy.PARTNER_TOOLS].sort()).toEqual(
      capabilityExemptTools.filter((name) => name !== "b2_authorize_account").sort(),
    );
  });

  it.each(["s3_get_presigned_url", "b2_get_bucket_notification_rules"])(
    "does not classify mixed read/write capability requirements as read-only: %s",
    (name) => {
      expect(policy.hasReadOnlyToolCapabilities(name)).toBe(false);
    },
  );

  it("does not infer read-only capabilities for an unmapped tool", () => {
    expect(policy.hasReadOnlyToolCapabilities("future_tool")).toBe(false);
  });
});

describe("independent OAuth scope policy", () => {
  it("assigns every published tool to its reviewed deployment tier", () => {
    expect([...oauthReadTools, ...oauthWriteTools, ...oauthAdminTools].sort()).toEqual(
      fullContract.names,
    );
    for (const [tier, names] of [
      ["read", oauthReadTools],
      ["write", oauthWriteTools],
      ["admin", oauthAdminTools],
    ] as const) {
      for (const name of names) expect(policy.oauthToolScopePolicy(name), name).toBe(tier);
    }
  });

  it.each([
    { scopes: ["b2:read"], allowed: oauthReadTools },
    { scopes: ["b2:write"], allowed: [...oauthReadTools, ...oauthWriteTools] },
    { scopes: ["b2:admin"], allowed: [...fullContract.names, "future_tool"] },
    { scopes: ["openid", "b2:read"], allowed: oauthReadTools },
    { scopes: ["b2:read", "b2:write"], allowed: [...oauthReadTools, ...oauthWriteTools] },
    { scopes: [], allowed: [] },
    { scopes: ["openid", "profile"], allowed: [] },
    { scopes: ["b2:administrator", "B2:READ"], allowed: [] },
  ])("allows only the reviewed tool surface for $scopes", ({ scopes, allowed }) => {
    const expected = new Set(allowed);
    for (const name of [...fullContract.names, "future_tool"]) {
      expect(policy.isToolAllowedByOAuthScopes(name, new Set(scopes)), name).toBe(
        expected.has(name),
      );
    }
  });

  it.each([
    { scopes: ["b2:read"], read: true, write: false, admin: false },
    { scopes: ["b2:write"], read: true, write: true, admin: false },
    { scopes: ["b2:admin"], read: true, write: true, admin: true },
    { scopes: ["openid", "b2:read"], read: true, write: false, admin: false },
    { scopes: [], read: false, write: false, admin: false },
    { scopes: ["b2:administrator"], read: false, write: false, admin: false },
  ])("enforces operation-tier inheritance for $scopes", ({ scopes, read, write, admin }) => {
    expect(policy.oauthScopesAllowOperation(new Set(scopes), "read")).toBe(read);
    expect(policy.oauthScopesAllowOperation(new Set(scopes), "write")).toBe(write);
    expect(policy.oauthScopesAllowOperation(new Set(scopes), "admin")).toBe(admin);
  });

  it("treats unknown tool policies as unmapped and OAuth-inactive requests as unrestricted", () => {
    expect(policy.oauthToolScopePolicy("future_tool")).toBeNull();
    for (const name of [...fullContract.names, "future_tool"]) {
      expect(policy.isToolAllowedByOAuthScopes(name, null), name).toBe(true);
    }
    for (const operation of ["read", "write", "admin"] as const) {
      expect(policy.oauthScopesAllowOperation(null, operation)).toBe(true);
    }
  });
});

describe("published capability and annotation contracts", () => {
  const config: B2Config = {
    applicationKeyId: "policy-app",
    applicationKey: "policy-secret",
    appKeyId: "policy-app",
    appKey: "policy-secret",
    masterKeyId: "policy-master",
    masterKey: "policy-master-secret",
    region: "us-west-004",
    allowLocalFiles: false,
    fileRoot: null,
    secretSink: { mode: "off" },
    destructivePolicy: "block",
  };

  it("preserves every published annotation without deriving expected hints from live policy", () => {
    for (const tool of fullContract.tools) {
      expect(policy.annotationsForTool(tool.name), tool.name).toEqual(tool.annotations);
    }
    expect(policy.annotationsForTool("future_tool")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("registers the full reviewed surface, including each unavailable secret-producing name", async () => {
    const { createServer, getRegisteredTools } = await import("../../src/server");
    const { callTool } = await import("../support/deterministic-fakes");
    const server = createServer(config, null);
    try {
      const tools = getRegisteredTools(server) ?? {};
      expect(Object.keys(tools).sort()).toEqual(fullContract.names);
      for (const name of [
        "b2_create_key",
        "b2_create_group_member",
        "b2_reserve_trial_create_account",
      ]) {
        expect(tools[name].availability, name).toBe("unavailable");
        const result = await callTool(server, name, {});
        expect(result.isError, name).toBe(true);
        expect(JSON.stringify(result), name).toContain("tool_unavailable");
      }
    } finally {
      await server.close();
    }
  });

  it("registers only bootstrap authorization when capability discovery fails closed", async () => {
    const { createServer, getRegisteredTools } = await import("../../src/server");
    const server = createServer(config, [], { failClosedUnknownCapabilities: true });
    try {
      expect(Object.keys(getRegisteredTools(server) ?? {})).toEqual(["b2_authorize_account"]);
    } finally {
      await server.close();
    }
  });
});
