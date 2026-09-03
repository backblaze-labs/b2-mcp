import { createServer, getRegisteredTools } from "../../src/server";
import { DESTRUCTIVE_TOOL_NAMES } from "../../src/utils/destructive-gate";
import {
  IDEMPOTENT_NON_READONLY_TOOL_NAMES,
  NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES,
  NON_READ_ONLY_TOOL_NAMES,
  READ_ONLY_OPERATION_TOOL_NAMES,
  TOOL_CAPABILITIES,
  annotationsForTool,
} from "../../src/utils/tool-capabilities";

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

function registeredToolNames(): string[] {
  const server = createServer(config);
  return Object.keys(getRegisteredTools(server) ?? {}).sort();
}

function hasReadListCapabilities(capabilities: string[]): boolean {
  return capabilities.every(
    (capability) => capability.startsWith("read") || capability.startsWith("list"),
  );
}

describe("tool annotation policy", () => {
  const toolNames = registeredToolNames();

  it("keeps manual annotation policy sets free of stale tool names", () => {
    for (const names of [
      READ_ONLY_OPERATION_TOOL_NAMES,
      NON_READ_ONLY_TOOL_NAMES,
      NON_IDEMPOTENT_DESTRUCTIVE_TOOL_NAMES,
      IDEMPOTENT_NON_READONLY_TOOL_NAMES,
    ]) {
      for (const name of names) {
        expect(toolNames, `${name} is not a registered tool`).toContain(name);
      }
    }
  });

  it("marks destructive-gate tools destructive and never read-only", () => {
    for (const name of DESTRUCTIVE_TOOL_NAMES) {
      expect(annotationsForTool(name)).toMatchObject({
        destructiveHint: true,
        readOnlyHint: false,
      });
    }
  });

  it("never marks write tools read-only and marks them destructive only when gated", () => {
    const writeTools = Object.entries(TOOL_CAPABILITIES)
      .filter(([, capabilities]) =>
        capabilities.some(
          (capability) =>
            capability === "writeFiles" ||
            capability === "writeBuckets" ||
            capability === "writeBucketLifecycleRules",
        ),
      )
      .map(([name]) => name)
      .sort();
    expect(writeTools).toEqual([
      "b2_create_bucket",
      "b2_update_bucket",
      "s3_abort_multipart_upload",
      "s3_complete_multipart_upload",
      "s3_copy_object",
      "s3_create_multipart_upload",
      "s3_get_presigned_url",
      "s3_presign_upload_part",
      "s3_put_bucket_lifecycle",
      "s3_put_object",
      "s3_upload_part_copy",
    ]);

    for (const name of writeTools) {
      expect(annotationsForTool(name)).toMatchObject({
        destructiveHint: DESTRUCTIVE_TOOL_NAMES.includes(name),
        readOnlyHint: false,
      });
    }
  });

  it("treats non-gated overwriting writes as additive and idempotent, not destructive", () => {
    for (const name of [
      "s3_put_object",
      "s3_copy_object",
      "s3_upload_part_copy",
      "s3_complete_multipart_upload",
    ]) {
      expect(annotationsForTool(name)).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it("marks read/list capability tools read-only except explicit local-side-effect tools", () => {
    const readListTools = Object.entries(TOOL_CAPABILITIES)
      .filter(
        ([name, capabilities]) =>
          !DESTRUCTIVE_TOOL_NAMES.includes(name) &&
          !NON_READ_ONLY_TOOL_NAMES.has(name) &&
          hasReadListCapabilities(capabilities),
      )
      .map(([name]) => name)
      .sort();
    expect(readListTools.length).toBeGreaterThan(0);

    for (const name of readListTools) {
      expect(annotationsForTool(name)).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
  });

  it("marks explicit read-only operations read-only", () => {
    for (const name of READ_ONLY_OPERATION_TOOL_NAMES) {
      expect(annotationsForTool(name)).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it("does not advertise s3_get_object as read-only or idempotent while saveToPath exists", () => {
    expect(annotationsForTool("s3_get_object")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("does not advertise versionless S3 deletes as idempotent at tool granularity", () => {
    for (const name of ["s3_delete_object", "s3_delete_objects"]) {
      expect(annotationsForTool(name)).toMatchObject({
        destructiveHint: true,
        idempotentHint: false,
      });
    }
  });

  it("does not advertise durable-secret creators as idempotent", () => {
    for (const name of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      expect(annotationsForTool(name)).toMatchObject({
        destructiveHint: true,
        idempotentHint: false,
      });
    }
  });

  it("keeps presign minting idempotent, destructive only for the gated PutObject minter", () => {
    // s3_get_presigned_url is gated (a PutObject URL mints overwrite/create bearer
    // capability); s3_presign_upload_part is not gated. Both are idempotent: the
    // same request mints an equivalent URL without mutating B2 state.
    expect(annotationsForTool("s3_get_presigned_url")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(annotationsForTool("s3_presign_upload_part")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});
