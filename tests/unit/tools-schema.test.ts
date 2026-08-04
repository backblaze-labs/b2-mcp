/**
 * Schema validation tests for all registered MCP tools.
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

import { createServer, getRegisteredTools } from "../../src/server";
import type { McpServer } from "../../src/mcp";

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
    allowLocalFiles: true,
    fileRoot: null,
  };
  server = createServer(config);
  tools = getRegisteredTools(server) ?? {};
  toolNames = Object.keys(tools).sort();
});

// ── Inventory ─────────────────────────────────────────────────────────────────

describe("Tool inventory", () => {
  it("registers exactly 40 callable tool names", () => {
    expect(toolNames.length).toBe(40);
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

  it("has 21 B2 native + Partner + insight b2_ tool names", () => {
    expect(toolNames.filter((n) => n.startsWith("b2_")).length).toBe(21);
  });

  it("has no bz_ backup tools (Computer Backup is out of scope)", () => {
    expect(toolNames.filter((n) => n.startsWith("bz_")).length).toBe(0);
  });

  it("has 19 S3-compatible tools (the object data plane)", () => {
    expect(toolNames.filter((n) => n.startsWith("s3_")).length).toBe(19);
  });
});

// ── Per-tool schema validation ────────────────────────────────────────────────

describe("Every tool has a valid description", () => {
  const toolList = [
    // B2 native — control plane (buckets, keys, object lock)
    "b2_authorize_account",
    "b2_list_buckets",
    "b2_create_bucket",
    "b2_delete_bucket",
    "b2_update_bucket",
    "b2_get_bucket_notification_rules",
    "b2_set_bucket_notification_rules",
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
    // S3-compatible — object data plane
    "s3_put_object",
    "s3_get_object",
    "s3_delete_object",
    "s3_delete_objects",
    "s3_head_object",
    "s3_copy_object",
    "s3_list_objects_v2",
    "s3_list_object_versions",
    "s3_create_multipart_upload",
    "s3_presign_upload_part",
    "s3_complete_multipart_upload",
    "s3_abort_multipart_upload",
    "s3_list_parts",
    "s3_list_multipart_uploads",
    "s3_upload_part_copy",
    "s3_get_presigned_url",
    "s3_head_bucket",
    "s3_get_bucket_location",
    "s3_put_bucket_lifecycle",
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
  const bucketTools = ["s3_head_bucket", "s3_put_bucket_lifecycle", "s3_get_bucket_location"];

  test.each(bucketTools)("%s requires a 'bucket' parameter", (name) => {
    const schema = tools[name]?.inputSchema;
    const shape = getShape(schema);
    expect(shape.bucket).toBeDefined();
    expect(requiredKeys(schema)).toContain("bucket");
  });
});

describe("S3 object tools require bucket and key where expected", () => {
  const objectTools = ["s3_put_object", "s3_get_object", "s3_delete_object", "s3_head_object"];

  test.each(objectTools)("%s requires 'bucket' and 'key'", (name) => {
    const schema = tools[name]?.inputSchema;
    const required = requiredKeys(schema);
    expect(getShape(schema).bucket).toBeDefined();
    expect(getShape(schema).key).toBeDefined();
    expect(required).toContain("bucket");
    expect(required).toContain("key");
  });

  it("s3_create_multipart_upload requires bucket and key", () => {
    const schema = tools["s3_create_multipart_upload"]?.inputSchema;
    const required = requiredKeys(schema);
    expect(required).toContain("bucket");
    expect(required).toContain("key");
  });

  it("registers durable-secret-producing names only as unavailable compatibility stubs", async () => {
    for (const name of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      const tool = tools[name];
      expect(tool).toBeDefined();
      const result = await tool.execute({}, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tool_unavailable");
      expect(result.content[0].text).not.toContain("applicationKey");
    }
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
