import { AsyncLocalStorage } from "async_hooks";
import { getRegisteredTools } from "../../src/mcp";
import { createServer } from "../../src/server";
import {
  createPreparedMcpServerFactory,
  type PreparedMcpRequest,
} from "../../src/http-fetch-handler";
import type { CreateServerOptions } from "../../src/server";
import {
  DURABLE_SECRET_PRODUCING_TOOLS,
  OAUTH_TOOL_SCOPE_POLICY,
  PARTNER_TOOLS,
  TOOL_CAPABILITIES,
} from "../../src/utils/tool-capabilities";
import type { B2Config } from "../../src/utils/types";

const config: B2Config = {
  applicationKeyId: "app-id",
  applicationKey: "app-secret",
  appKeyId: "app-id",
  appKey: "app-secret",
  masterKeyId: "app-id",
  masterKey: "app-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
  destructivePolicy: "block",
  transport: "http",
  credentialFingerprint: "fingerprint",
};

const broadB2Capabilities = [
  "listBuckets",
  "readFiles",
  "listFiles",
  "writeFiles",
  "deleteFiles",
  "writeBuckets",
  "deleteBuckets",
  "listKeys",
  "deleteKeys",
  "readBucketNotifications",
  "writeBucketNotifications",
  "writeFileLegalHolds",
  "writeFileRetentions",
];

function registeredTools(scopes: string[], capabilities = broadB2Capabilities) {
  const server = createServer(config, capabilities, { oauthScopes: scopes });
  return getRegisteredTools(server) ?? {};
}

function toolNames(scopes: string[], capabilities = broadB2Capabilities) {
  return new Set(Object.keys(registeredTools(scopes, capabilities)));
}

describe("OAuth scope-aware tool registration", () => {
  it("classifies every current registered tool explicitly for OAuth scope filtering", () => {
    const server = createServer(config, null);
    const tools = getRegisteredTools(server) ?? {};

    for (const name of Object.keys(tools)) {
      expect(OAUTH_TOOL_SCOPE_POLICY).toHaveProperty(name);
    }
    for (const name of [
      ...Object.keys(TOOL_CAPABILITIES),
      ...DURABLE_SECRET_PRODUCING_TOOLS,
      ...PARTNER_TOOLS,
      "b2_authorize_account",
    ]) {
      expect(OAUTH_TOOL_SCOPE_POLICY).toHaveProperty(name);
    }
  });

  it("limits b2:read tokens to reviewed read/list/inspect tools", () => {
    const tools = toolNames(["b2:read"]);

    expect(tools.has("b2_authorize_account")).toBe(true);
    expect(tools.has("b2_list_buckets")).toBe(true);
    expect(tools.has("s3_get_object")).toBe(true);
    expect(tools.has("s3_list_objects_v2")).toBe(true);
    expect(tools.has("s3_get_presigned_url")).toBe(true);
    expect(tools.has("s3_put_object")).toBe(false);
    expect(tools.has("b2_create_bucket")).toBe(false);
    expect(tools.has("b2_list_keys")).toBe(false);
    expect(tools.has("b2_set_bucket_notification_rules")).toBe(false);
  });

  it("keeps read-scoped presigned URLs GetObject-only even with a write-capable B2 key", () => {
    const tools = registeredTools(["b2:read"], ["readFiles", "writeFiles"]);
    const presigned = tools.s3_get_presigned_url;

    expect(presigned).toBeDefined();
    expect(presigned.description).toContain("GetObject");
    expect(presigned.description).not.toContain("PutObject");
    expect(
      presigned.inputSchema?.safeParse({ bucket: "bucket", key: "key", operation: "GetObject" })
        .success,
    ).toBe(true);
    expect(
      presigned.inputSchema?.safeParse({ bucket: "bucket", key: "key", operation: "PutObject" })
        .success,
    ).toBe(false);
  });

  it("lets b2:write expose object and bucket mutations but not admin tools", () => {
    const tools = toolNames(["b2:write"]);

    expect(tools.has("s3_put_object")).toBe(true);
    expect(tools.has("s3_delete_object")).toBe(true);
    expect(tools.has("b2_create_bucket")).toBe(true);
    expect(tools.has("b2_delete_bucket")).toBe(true);
    expect(tools.has("b2_list_keys")).toBe(false);
    expect(tools.has("b2_update_file_retention")).toBe(false);
  });

  it("lets b2:admin expose administrative names still bounded by B2 capabilities", () => {
    const tools = toolNames(["b2:admin"]);

    expect(tools.has("b2_list_keys")).toBe(true);
    expect(tools.has("b2_delete_key")).toBe(true);
    expect(tools.has("b2_set_bucket_notification_rules")).toBe(true);
    expect(tools.has("b2_update_file_legal_hold")).toBe(true);
  });

  it("fails closed when verified scopes lack the b2 prefix", () => {
    const tools = toolNames(["openid", "profile"]);

    expect(tools.size).toBe(0);
  });

  it("passes an empty OAuth scope set for injected non-b2 AuthInfo", () => {
    const scope = new AsyncLocalStorage<PreparedMcpRequest>();
    const optionsSeen: unknown[] = [];
    const fakeServer = { close: vi.fn() };
    const factory = createPreparedMcpServerFactory(scope, ((
      _config: B2Config,
      _capabilities: string[] | null | undefined,
      options: CreateServerOptions | undefined,
    ) => {
      optionsSeen.push(options);
      return fakeServer;
    }) as unknown as typeof createServer);
    const prepared: PreparedMcpRequest = {
      resolved: {
        config,
        cacheKey: "credential:fingerprint",
        capabilityCacheKey: "credential:capability",
      },
      capabilities: broadB2Capabilities,
      servers: new Set(),
      authInfo: {
        token: "verified-token",
        clientId: "client",
        scopes: ["openid", "profile"],
        expiresAt: 2000,
      },
    };

    scope.run(prepared, () => factory({} as never));

    expect(optionsSeen).toEqual([{ oauthScopes: [] }]);
  });
});
