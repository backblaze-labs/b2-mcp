/**
 * Schema validation tests for all 85 registered MCP tools.
 *
 * These tests run without any credentials and verify that every tool:
 *   - Is registered with a unique name
 *   - Has a non-trivial description
 *   - Has a valid Zod-mini input schema (type: object with a shape)
 *   - Follows the b2_ / bz_ / s3_ naming convention
 *   - Does not expose sensitive fields in its schema
 *
 * Note: The MCP SDK stores input schemas as Zod-mini objects, not plain
 * JSON Schema. Shape properties live at schema.def.shape, and the object
 * type is at schema.def.type. A field is required when its def.type is
 * neither "optional" nor "default".
 */

import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Zod-mini schema helpers ───────────────────────────────────────────────────

function getShape(schema: any): Record<string, any> {
  return schema?.def?.shape ?? {};
}

function schemaDefType(schema: any): string {
  return schema?.def?.type ?? "";
}

function isRequired(fieldSchema: any): boolean {
  const t = fieldSchema?.def?.type;
  return t !== "optional" && t !== "default";
}

function requiredKeys(schema: any): string[] {
  return Object.entries(getShape(schema))
    .filter(([, v]) => isRequired(v))
    .map(([k]) => k);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let server: McpServer;
let tools: Record<string, any>;
let toolNames: string[];

beforeAll(() => {
  const config = {
    applicationKeyId: "test",
    applicationKey: "test",
    appKeyId: "test",
    appKey: "test",
    masterKeyId: "test",
    masterKey: "test",
    region: "us-west-004",
    largeFileThreshold: 1e8,
    partSize: 1e8,
    allowLocalFiles: true,
    fileRoot: null,
  };
  server = createServer(config);
  tools = (server as any)._registeredTools ?? {};
  toolNames = Object.keys(tools).sort();
});

// ── Inventory ─────────────────────────────────────────────────────────────────

describe("Tool inventory", () => {
  it("registers exactly 85 tools", () => {
    expect(toolNames.length).toBe(85);
  });

  it("has no duplicate tool names", () => {
    const unique = new Set(toolNames);
    expect(unique.size).toBe(toolNames.length);
  });

  it("all tools use b2_ / bz_ / s3_ prefix", () => {
    const invalid = toolNames.filter(
      (n) => !n.startsWith("b2_") && !n.startsWith("bz_") && !n.startsWith("s3_"),
    );
    expect(invalid).toEqual([]);
  });

  it("has 38 B2 native + Partner b2_ tools", () => {
    expect(toolNames.filter((n) => n.startsWith("b2_")).length).toBe(38);
  });

  it("has 2 bz_ backup tools", () => {
    expect(toolNames.filter((n) => n.startsWith("bz_")).length).toBe(2);
  });

  it("has 45 S3-compatible tools", () => {
    expect(toolNames.filter((n) => n.startsWith("s3_")).length).toBe(45);
  });
});

// ── Per-tool schema validation ────────────────────────────────────────────────

describe("Every tool has a valid description", () => {
  const toolList = [
    // B2 native
    "b2_authorize_account",
    "b2_list_buckets",
    "b2_create_bucket",
    "b2_delete_bucket",
    "b2_update_bucket",
    "b2_get_bucket_notification_rules",
    "b2_set_bucket_notification_rules",
    "b2_upload_file",
    "b2_download_file_by_id",
    "b2_download_file_by_name",
    "b2_list_file_names",
    "b2_list_file_versions",
    "b2_get_file_info",
    "b2_delete_file_version",
    "b2_hide_file",
    "b2_copy_file",
    "b2_get_upload_url",
    "b2_start_large_file",
    "b2_get_upload_part_url",
    "b2_upload_part",
    "b2_copy_part",
    "b2_finish_large_file",
    "b2_cancel_large_file",
    "b2_list_parts",
    "b2_list_unfinished_large_files",
    "b2_get_download_authorization",
    "b2_get_download_url_for_file",
    "b2_get_download_url_for_file_id",
    "b2_create_key",
    "b2_list_keys",
    "b2_delete_key",
    "b2_update_file_legal_hold",
    "b2_update_file_retention",
    // Partner API (b2_ prefix)
    "b2_list_groups",
    "b2_create_group_member",
    "b2_eject_group_member",
    "b2_list_group_members",
    "b2_reserve_trial_create_account",
    // Partner API (bz_ prefix)
    "bz_list_computers",
    "bz_delete_computer",
    // S3-compatible
    "s3_list_buckets",
    "s3_create_bucket",
    "s3_delete_bucket",
    "s3_head_bucket",
    "s3_get_bucket_versioning",
    "s3_put_bucket_versioning",
    "s3_get_bucket_cors",
    "s3_put_bucket_cors",
    "s3_delete_bucket_cors",
    "s3_get_bucket_lifecycle",
    "s3_put_bucket_lifecycle",
    "s3_get_bucket_acl",
    "s3_put_bucket_acl",
    "s3_put_object",
    "s3_get_object",
    "s3_delete_object",
    "s3_delete_objects",
    "s3_head_object",
    "s3_copy_object",
    "s3_list_objects_v2",
    "s3_list_object_versions",
    "s3_get_object_acl",
    "s3_put_object_acl",
    "s3_create_multipart_upload",
    "s3_upload_part",
    "s3_complete_multipart_upload",
    "s3_abort_multipart_upload",
    "s3_list_multipart_uploads",
    "s3_list_parts",
    "s3_get_presigned_url",
    "s3_get_object_lock_configuration",
    "s3_put_object_lock_configuration",
    "s3_get_object_legal_hold",
    "s3_put_object_legal_hold",
    "s3_get_object_retention",
    "s3_put_object_retention",
    "s3_get_bucket_location",
    "s3_get_bucket_encryption",
    "s3_put_bucket_encryption",
    "s3_delete_bucket_encryption",
    "s3_get_bucket_logging",
    "s3_put_bucket_logging",
    "s3_delete_bucket_lifecycle",
    "s3_list_objects",
    "s3_upload_part_copy",
  ];

  test.each(toolList)("%s has a description longer than 20 chars", (name) => {
    const tool = tools[name];
    expect(tool).toBeDefined();
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(20);
  });
});

describe("Every tool has a valid input schema", () => {
  it("all tools have an inputSchema object", () => {
    for (const name of toolNames) {
      const schema = tools[name]?.inputSchema;
      expect(schema).toBeDefined();
      expect(typeof schema).toBe("object");
    }
  });

  it("all tool schemas declare type: object at the def level", () => {
    const nonObject = toolNames.filter((n) => schemaDefType(tools[n]?.inputSchema) !== "object");
    expect(nonObject).toEqual([]);
  });

  it("all tool schemas have a shape (properties) field in def", () => {
    const missing = toolNames.filter((n) => typeof getShape(tools[n]?.inputSchema) !== "object");
    expect(missing).toEqual([]);
  });
});

// ── Required parameters check ─────────────────────────────────────────────────

describe("Tools that need a bucket param declare it as required", () => {
  const bucketTools = [
    "s3_create_bucket",
    "s3_delete_bucket",
    "s3_head_bucket",
    "s3_get_bucket_versioning",
    "s3_put_bucket_versioning",
    "s3_get_bucket_cors",
    "s3_put_bucket_cors",
    "s3_delete_bucket_cors",
    "s3_get_bucket_lifecycle",
    "s3_put_bucket_lifecycle",
    "s3_get_bucket_acl",
    "s3_put_bucket_acl",
    "s3_list_objects_v2",
    "s3_list_objects",
    "s3_list_object_versions",
    "s3_get_bucket_location",
    "s3_get_bucket_encryption",
    "s3_put_bucket_encryption",
    "s3_delete_bucket_encryption",
    "s3_get_bucket_logging",
    "s3_put_bucket_logging",
    "s3_delete_bucket_lifecycle",
  ];

  test.each(bucketTools)("%s requires a 'bucket' parameter", (name) => {
    const schema = tools[name]?.inputSchema;
    const shape = getShape(schema);
    expect(shape.bucket).toBeDefined();
    expect(requiredKeys(schema)).toContain("bucket");
  });
});

describe("Object tools require both bucket and key", () => {
  // s3_copy_object uses destinationBucket/destinationKey rather than bucket/key,
  // so it is excluded here and covered in a separate check below.
  const objectTools = [
    "s3_put_object",
    "s3_get_object",
    "s3_delete_object",
    "s3_head_object",
    "s3_get_object_acl",
    "s3_put_object_acl",
    "s3_get_object_legal_hold",
    "s3_put_object_legal_hold",
    "s3_get_object_retention",
    "s3_put_object_retention",
  ];

  test.each(objectTools)("%s requires 'bucket' and 'key'", (name) => {
    const schema = tools[name]?.inputSchema;
    const shape = getShape(schema);
    const required = requiredKeys(schema);
    expect(shape.bucket).toBeDefined();
    expect(shape.key).toBeDefined();
    expect(required).toContain("bucket");
    expect(required).toContain("key");
  });
});

describe("B2 file tools require fileId or bucketId where expected", () => {
  it("b2_get_file_info requires fileId", () => {
    const schema = tools["b2_get_file_info"]?.inputSchema;
    expect(getShape(schema).fileId).toBeDefined();
    expect(requiredKeys(schema)).toContain("fileId");
  });

  it("b2_delete_file_version requires fileId and fileName", () => {
    const schema = tools["b2_delete_file_version"]?.inputSchema;
    const required = requiredKeys(schema);
    expect(required).toContain("fileId");
    expect(required).toContain("fileName");
  });

  it("b2_list_file_names requires bucketId", () => {
    const schema = tools["b2_list_file_names"]?.inputSchema;
    expect(requiredKeys(schema)).toContain("bucketId");
  });

  it("b2_upload_file requires bucketId, fileName, and filePath or content", () => {
    const schema = tools["b2_upload_file"]?.inputSchema;
    const required = requiredKeys(schema);
    expect(required).toContain("bucketId");
    expect(required).toContain("fileName");
    const shape = getShape(schema);
    const hasFile = !!(shape.filePath || shape.content);
    expect(hasFile).toBe(true);
  });

  it("s3_copy_object requires sourceBucket, sourceKey, destinationBucket, destinationKey", () => {
    const schema = tools["s3_copy_object"]?.inputSchema;
    const shape = getShape(schema);
    const required = requiredKeys(schema);
    expect(shape.sourceBucket).toBeDefined();
    expect(shape.sourceKey).toBeDefined();
    expect(shape.destinationBucket).toBeDefined();
    expect(shape.destinationKey).toBeDefined();
    expect(required).toContain("sourceBucket");
    expect(required).toContain("sourceKey");
    expect(required).toContain("destinationBucket");
    expect(required).toContain("destinationKey");
  });
});

// ── Multipart tools ───────────────────────────────────────────────────────────

describe("Multipart tools require uploadId where needed", () => {
  const uploadIdTools = [
    "s3_upload_part",
    "s3_complete_multipart_upload",
    "s3_abort_multipart_upload",
    "s3_list_parts",
    "s3_upload_part_copy",
  ];

  test.each(uploadIdTools)("%s requires uploadId", (name) => {
    const schema = tools[name]?.inputSchema;
    const shape = getShape(schema);
    expect(shape.uploadId).toBeDefined();
    expect(requiredKeys(schema)).toContain("uploadId");
  });
});

// ── Security checks ───────────────────────────────────────────────────────────

describe("Tool schemas do not expose sensitive field names", () => {
  // "token" and "credential" are omitted because legitimate B2/S3 API parameters
  // (authorizationToken, uploadAuthToken, continuationToken) contain these strings.
  // "password" and "secret" would never appear in a well-designed storage API schema.
  const sensitiveNames = ["password", "secret"];

  it("no tool schema property is named a sensitive name", () => {
    const violations: string[] = [];
    for (const name of toolNames) {
      const shape = getShape(tools[name]?.inputSchema);
      for (const prop of Object.keys(shape)) {
        if (sensitiveNames.some((s) => prop.toLowerCase().includes(s))) {
          violations.push(`${name}.${prop}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── Description quality ───────────────────────────────────────────────────────

describe("Tool descriptions mention B2 or S3 context", () => {
  const contextTerms = [
    "b2",
    "s3",
    "bucket",
    "object",
    "file",
    "key",
    "upload",
    "download",
    "backblaze",
    "multipart",
    "version",
    "lock",
    "presigned",
    "cors",
    "lifecycle",
    "acl",
    "encryption",
    "logging",
    "group",
    "backup",
    "account",
    "computer",
    "partner",
  ];

  it("every tool description references at least one storage concept", () => {
    const missing: string[] = [];
    for (const name of toolNames) {
      const desc: string = (tools[name]?.description ?? "").toLowerCase();
      const hasContext = contextTerms.some((t) => desc.includes(t));
      if (!hasContext) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});
