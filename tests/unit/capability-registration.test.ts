/**
 * Capability-aware tool registration: the surface scales to the connected key's
 * capabilities. createServer does not authorize, so building servers here is
 * network-free; fetchCapabilities is tested against a mocked authorize.
 */
import axios from "axios";
import { createServer, fetchCapabilities } from "../../src/server";
import { isToolEnabled, TOOL_CAPABILITIES } from "../../src/utils/tool-capabilities";
import { B2Config } from "../../src/utils/types";

const baseConfig = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "k",
  masterKey: "s",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
} as unknown as B2Config;

function toolNames(caps: string[] | null, cfg: B2Config = baseConfig): string[] {
  const server = createServer(cfg, caps);
  return Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
}

describe("isToolEnabled", () => {
  it("registers unmapped tools unconditionally", () => {
    expect(isToolEnabled("b2_authorize_account", new Set())).toBe(true);
  });

  it("gates a mapped tool on its capability", () => {
    expect(isToolEnabled("s3_delete_object", new Set(["readFiles"]))).toBe(false);
    expect(isToolEnabled("s3_delete_object", new Set(["deleteFiles"]))).toBe(true);
  });

  it("uses any-of semantics for dual-capability tools", () => {
    expect(isToolEnabled("s3_get_presigned_url", new Set(["readFiles"]))).toBe(true);
    expect(isToolEnabled("s3_get_presigned_url", new Set(["writeFiles"]))).toBe(true);
    expect(isToolEnabled("s3_get_presigned_url", new Set(["listKeys"]))).toBe(false);
  });
});

describe("capability-aware registration", () => {
  it("null capabilities → full surface, no filtering (40 tools)", () => {
    expect(toolNames(null).length).toBe(40);
  });

  it("read-only key drops every write/delete/admin tool", () => {
    const names = toolNames(["listBuckets", "listFiles", "readFiles", "listKeys"]);
    // present
    for (const t of ["s3_get_object", "s3_list_objects_v2", "b2_list_buckets",
      "s3_get_presigned_url", "b2_usage_growth", "b2_list_keys"]) {
      expect(names).toContain(t);
    }
    // absent
    for (const t of ["s3_delete_object", "s3_delete_objects", "s3_put_object",
      "b2_delete_bucket", "b2_create_key", "b2_delete_key",
      "b2_update_file_retention", "b2_update_file_legal_hold",
      "b2_create_group_member", "b2_list_groups"]) {
      expect(names).not.toContain(t);
    }
    expect(names.length).toBeLessThan(40);
  });

  it("write-but-no-delete key keeps writes, drops deletes", () => {
    const names = toolNames(["listBuckets", "listFiles", "readFiles", "writeFiles", "writeBuckets"]);
    expect(names).toContain("s3_put_object");
    expect(names).toContain("s3_create_multipart_upload");
    expect(names).toContain("s3_put_bucket_lifecycle");
    expect(names).not.toContain("s3_delete_object");
    expect(names).not.toContain("b2_delete_bucket");
  });

  it("every mapped tool registers for a key holding all capabilities", () => {
    const allCaps = [...new Set(Object.values(TOOL_CAPABILITIES).flat())];
    const names = toolNames(allCaps);
    for (const t of Object.keys(TOOL_CAPABILITIES)) expect(names).toContain(t);
  });

  it("partner tools are gated: dropped without a distinct master key, present with one", () => {
    expect(toolNames(["listBuckets"])).not.toContain("b2_list_groups");
    const withMaster = { ...baseConfig, masterKeyId: "master-distinct", masterKey: "ms" } as B2Config;
    const names = toolNames(["listBuckets"], withMaster);
    expect(names).toContain("b2_list_groups");
    expect(names).toContain("b2_create_group_member");
  });
});

describe("fetchCapabilities", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.B2_REGISTER_ALL_TOOLS;
  });

  it("returns the key's capabilities from the authorize response", async () => {
    jest.spyOn(axios, "get").mockResolvedValue({
      data: {
        accountId: "a",
        authorizationToken: "t",
        apiInfo: {
          storageApi: {
            apiUrl: "u", downloadUrl: "d", s3ApiUrl: "s",
            recommendedPartSize: 1, absoluteMinimumPartSize: 1,
          },
        },
        allowed: { capabilities: ["readFiles", "listBuckets"] },
      },
    } as never);
    expect(await fetchCapabilities(baseConfig)).toEqual(["readFiles", "listBuckets"]);
  });

  it("returns null on auth failure so callers fall back to the full surface", async () => {
    jest.spyOn(axios, "get").mockRejectedValue(Object.assign(new Error("denied"), { response: { status: 401 } }));
    expect(await fetchCapabilities(baseConfig)).toBeNull();
  });

  it("returns null without any network call when B2_REGISTER_ALL_TOOLS=true", async () => {
    const spy = jest.spyOn(axios, "get");
    process.env.B2_REGISTER_ALL_TOOLS = "true";
    expect(await fetchCapabilities(baseConfig)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
