/**
 * Capability-aware tool registration: the surface scales to the connected key's
 * capabilities. createServer does not authorize, so building servers here is
 * network-free; fetchCapabilities is tested against a mocked authorize.
 */
import axios from "axios";
import {
  capabilityCacheSizeForTests,
  createServer,
  fetchCapabilities,
  invalidateCapabilityCache,
} from "../../src/server";
import { verificationFingerprintConfig } from "../../src/credentials";
import { logger } from "../../src/utils/logger";
import {
  DURABLE_SECRET_PRODUCING_TOOLS,
  isToolEnabled,
  TOOL_CAPABILITIES,
} from "../../src/utils/tool-capabilities";
import { B2Config } from "../../src/utils/types";

const CANARY = "B2_MCP_CANARY_SECRET_capability_do_not_leak";

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
  return Object.keys(
    (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  );
}

describe("isToolEnabled", () => {
  it("registers unmapped tools unconditionally", () => {
    expect(isToolEnabled("b2_authorize_account", new Set())).toBe(true);
  });

  it("always excludes durable-secret-producing tools", () => {
    for (const tool of DURABLE_SECRET_PRODUCING_TOOLS) {
      expect(isToolEnabled(tool, null)).toBe(false);
      expect(isToolEnabled(tool, new Set(Object.values(TOOL_CAPABILITIES).flat()))).toBe(false);
    }
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
  it("null capabilities → full surface plus compatibility stubs, no filtering (40 tools)", () => {
    expect(toolNames(null).length).toBe(40);
  });

  it("EMPTY capabilities → fail closed instead of full surface", () => {
    const names = toolNames([]);
    expect(names.length).toBeLessThan(40);
    expect(names).toContain("b2_authorize_account");
    expect(names).toContain("b2_create_key");
    expect(names).not.toContain("b2_usage_growth");
  });

  it("read-only key drops every write/delete/admin tool", () => {
    const names = toolNames(["listBuckets", "listFiles", "readFiles", "listKeys"]);
    // present
    for (const t of [
      "s3_get_object",
      "s3_list_objects_v2",
      "b2_list_buckets",
      "s3_get_presigned_url",
      "b2_usage_growth",
      "b2_list_keys",
    ]) {
      expect(names).toContain(t);
    }
    // absent
    for (const t of [
      "s3_delete_object",
      "s3_delete_objects",
      "s3_put_object",
      "b2_delete_bucket",
      "b2_delete_key",
      "b2_update_file_retention",
      "b2_update_file_legal_hold",
      "b2_list_groups",
    ]) {
      expect(names).not.toContain(t);
    }
    for (const t of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      expect(names).toContain(t);
    }
    expect(names.length).toBeLessThan(40);
  });

  it("write-but-no-delete key keeps writes, drops deletes", () => {
    const names = toolNames([
      "listBuckets",
      "listFiles",
      "readFiles",
      "writeFiles",
      "writeBuckets",
    ]);
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
    const withMaster = {
      ...baseConfig,
      masterKeyId: "master-distinct",
      masterKey: "ms",
    } as B2Config;
    const names = toolNames(["listBuckets"], withMaster);
    expect(names).toContain("b2_list_groups");
    expect(names).toContain("b2_eject_group_member");
    expect(names).toContain("b2_list_group_members");
    expect(names).toContain("b2_create_group_member");
    expect(names).toContain("b2_reserve_trial_create_account");
  });
});

describe("fetchCapabilities", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    invalidateCapabilityCache();
    delete process.env.B2_REGISTER_ALL_TOOLS;
    delete process.env.B2_CAPABILITY_CACHE_TTL_MS;
    delete process.env.B2_CAPABILITY_CACHE_MAX_ENTRIES;
  });

  // v4 puts capabilities at apiInfo.storageApi.allowed.capabilities.
  const authData = (caps?: string[]) => ({
    data: {
      accountId: "a",
      authorizationToken: "t",
      apiInfo: {
        storageApi: {
          apiUrl: "u",
          downloadUrl: "d",
          s3ApiUrl: "s",
          recommendedPartSize: 1,
          absoluteMinimumPartSize: 1,
          ...(caps ? { allowed: { capabilities: caps } } : {}),
        },
      },
    },
  });

  it("returns the key's capabilities from apiInfo.storageApi.allowed", async () => {
    jest.spyOn(axios, "get").mockResolvedValue(authData(["readFiles", "listBuckets"]) as never);
    expect(await fetchCapabilities(baseConfig)).toEqual(["readFiles", "listBuckets"]);
  });

  it("returns an empty list when capabilities are empty or absent", async () => {
    jest.spyOn(axios, "get").mockResolvedValue(authData(undefined) as never);
    expect(await fetchCapabilities(baseConfig)).toEqual([]);
  });

  it("rejects on auth failure so callers fail closed", async () => {
    jest
      .spyOn(axios, "get")
      .mockRejectedValue(Object.assign(new Error("denied"), { response: { status: 401 } }));
    await expect(fetchCapabilities(baseConfig)).rejects.toMatchObject({
      status: 401,
      code: "capability_auth_failed",
    });
  });

  it("returns retryable status for upstream capability failures", async () => {
    jest
      .spyOn(axios, "get")
      .mockRejectedValue(Object.assign(new Error("B2 500"), { response: { status: 500 } }));
    await expect(fetchCapabilities(baseConfig)).rejects.toMatchObject({
      status: 503,
      code: "capability_upstream_unavailable",
    });
  });

  it("sanitizes capability fetch failure log text, code, and request id", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const configWithSecrets = {
      ...baseConfig,
      applicationKey: "configured-capability-secret",
      appKey: "configured-app-capability-secret",
      masterKey: "configured-master-capability-secret",
    } as B2Config;
    jest.spyOn(axios, "get").mockRejectedValue(
      Object.assign(new Error(`authorizationToken=${CANARY} ${configWithSecrets.applicationKey}`), {
        code: `bad_${CANARY}`,
        response: { status: 500, headers: { "x-bz-request-id": `req-${CANARY}` } },
      }),
    );

    await expect(
      fetchCapabilities(configWithSecrets, "credential:capability-leak", "credential:non-secret"),
    ).rejects.toMatchObject({
      status: 503,
      code: "capability_upstream_unavailable",
    });

    const logText = JSON.stringify(warnSpy.mock.calls);
    expect(logText).not.toContain(CANARY);
    expect(logText).not.toContain(configWithSecrets.applicationKey);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamCode: "[redacted]",
        requestId: "[redacted]",
        message: expect.not.stringContaining(CANARY),
      }),
      "capability.fetch.failed",
    );
  });

  it("returns null without any network call when B2_REGISTER_ALL_TOOLS=true", async () => {
    const spy = jest.spyOn(axios, "get");
    process.env.B2_REGISTER_ALL_TOOLS = "true";
    expect(await fetchCapabilities(baseConfig)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("caches by explicit secret-bound cache key and supports invalidation", async () => {
    process.env.B2_CAPABILITY_CACHE_TTL_MS = "60000";
    const spy = jest.spyOn(axios, "get").mockResolvedValue(authData(["readFiles"]) as never);

    await expect(fetchCapabilities(baseConfig, "credential:a")).resolves.toEqual(["readFiles"]);
    await expect(fetchCapabilities(baseConfig, "credential:a")).resolves.toEqual(["readFiles"]);
    expect(spy).toHaveBeenCalledTimes(1);

    await expect(fetchCapabilities(baseConfig, "credential:b")).resolves.toEqual(["readFiles"]);
    expect(spy).toHaveBeenCalledTimes(2);

    invalidateCapabilityCache("credential:a");
    await expect(fetchCapabilities(baseConfig, "credential:a")).resolves.toEqual(["readFiles"]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a warm cache entry for the same key id with a wrong secret", async () => {
    process.env.B2_CAPABILITY_CACHE_TTL_MS = "60000";
    const wrongSecret = {
      ...baseConfig,
      applicationKey: "wrong",
      appKey: "wrong",
      masterKey: "wrong",
    };
    const spy = jest
      .spyOn(axios, "get")
      .mockResolvedValueOnce(authData(["readFiles"]) as never)
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { response: { status: 401 } }));

    await expect(
      fetchCapabilities(
        baseConfig,
        `credential:${verificationFingerprintConfig(baseConfig)}`,
        "credential:non-secret",
      ),
    ).resolves.toEqual(["readFiles"]);

    await expect(
      fetchCapabilities(
        wrongSecret,
        `credential:${verificationFingerprintConfig(wrongSecret)}`,
        "credential:non-secret",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache an empty capability response at the positive TTL", async () => {
    process.env.B2_CAPABILITY_CACHE_TTL_MS = "60000";
    const spy = jest.spyOn(axios, "get").mockResolvedValue(authData(undefined) as never);
    await expect(fetchCapabilities(baseConfig, "credential:empty")).resolves.toEqual([]);
    await expect(fetchCapabilities(baseConfig, "credential:empty")).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent cold-cache capability lookups", async () => {
    process.env.B2_CAPABILITY_CACHE_TTL_MS = "60000";
    const spy = jest.spyOn(axios, "get").mockResolvedValue(authData(["readFiles"]) as never);

    await expect(
      Promise.all([
        fetchCapabilities(baseConfig, "credential:singleflight"),
        fetchCapabilities(baseConfig, "credential:singleflight"),
        fetchCapabilities(baseConfig, "credential:singleflight"),
      ]),
    ).resolves.toEqual([["readFiles"], ["readFiles"], ["readFiles"]]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("bounds capability-cache growth as distinct credentials connect", async () => {
    process.env.B2_CAPABILITY_CACHE_TTL_MS = "60000";
    process.env.B2_CAPABILITY_CACHE_MAX_ENTRIES = "2";
    jest.spyOn(axios, "get").mockResolvedValue(authData(["readFiles"]) as never);

    for (let i = 0; i < 5; i++) {
      await fetchCapabilities({ ...baseConfig, applicationKey: `s-${i}` }, `credential:${i}`);
    }
    expect(capabilityCacheSizeForTests()).toBeLessThanOrEqual(2);
  });
});
