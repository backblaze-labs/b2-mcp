import { getRegisteredTools } from "../../src/mcp";
import { createServer } from "../../src/server";
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

function toolNames(scopes: string[]) {
  const server = createServer(config, broadB2Capabilities, { oauthScopes: scopes });
  const tools = getRegisteredTools(server);
  return new Set(Object.keys(tools ?? {}));
}

describe("OAuth scope-aware tool registration", () => {
  it("limits b2:read tokens to reviewed read/list/inspect tools", () => {
    const tools = toolNames(["b2:read"]);

    expect(tools.has("b2_authorize_account")).toBe(true);
    expect(tools.has("b2_list_buckets")).toBe(true);
    expect(tools.has("s3_get_object")).toBe(true);
    expect(tools.has("s3_list_objects_v2")).toBe(true);
    expect(tools.has("s3_put_object")).toBe(false);
    expect(tools.has("b2_create_bucket")).toBe(false);
    expect(tools.has("b2_list_keys")).toBe(false);
    expect(tools.has("b2_set_bucket_notification_rules")).toBe(false);
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
});
