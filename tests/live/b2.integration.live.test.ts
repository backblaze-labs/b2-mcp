/**
 * Live integration tests for the B2 MCP Server.
 *
 * Prerequisites:
 *   export B2_APPLICATION_KEY_ID=<dedicated test key id>
 *   export B2_APPLICATION_KEY=<dedicated test key secret>
 *
 * Run with:
 *   pnpm run test:live:b2-integration
 *
 * These tests create run-prefixed buckets and objects and clean only resources
 * owned by the current run. Direct Vitest selection skips this file's cases when
 * credentials are absent so a local editor cannot accidentally call B2.
 */

import { loadConfig, createServer } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { parseErrorText } from "../../src/utils/errors";
import { callTool, parseResult } from "../support/deterministic-fakes";
import {
  contractObjectKey,
  createContractBucketTracker,
  type ContractBucketTracker,
  liveErrorText,
  liveRunPrefix,
  redactedLiveResourceDetail,
  type CreatedContractBucket,
} from "./support/contract-buckets";
import { hasLiveB2Credentials, assertAndSelectLiveB2Test } from "../support/live-b2-test-guard";

const HAS_CREDS = hasLiveB2Credentials();
const liveIt = assertAndSelectLiveB2Test(test);

function isError(result: any): boolean {
  return result?.isError === true;
}

function expectLiveSuccess(result: any, label: string): void {
  if (isError(result)) {
    throw new Error(`${label} failed: ${redactedLiveResourceDetail(liveErrorText(result))}`);
  }
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

let server: McpServer;
let bucketTracker: ContractBucketTracker;
let primaryBucket: CreatedContractBucket;

function bucketName(): string {
  if (!primaryBucket?.bucketName) throw new Error("Live primary bucket was not created.");
  return primaryBucket.bucketName;
}

beforeAll(async () => {
  if (!HAS_CREDS) return;
  const config = loadConfig();
  server = createServer({ ...config, destructivePolicy: "allow" });
  bucketTracker = createContractBucketTracker(server);
  primaryBucket = await bucketTracker.createBucket("integration", {
    lifecycleRules: [
      {
        fileNamePrefix: `${liveRunPrefix()}/`,
        daysFromStartingToCancelingUnfinishedLargeFiles: 1,
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  if (!HAS_CREDS) return;
  await bucketTracker.cleanupAll();
}, 120_000);

describe("B2 Auth", () => {
  liveIt("b2_authorize_account returns accountId and apiUrl without exposing tokens", async () => {
    const result = parseResult(await callTool(server, "b2_authorize_account", {}));
    expect(result).toHaveProperty("accountId");
    expect(result).toHaveProperty("apiUrl");
    expect(result).not.toHaveProperty("authorizationToken");
  });
});

describe("B2 Bucket and key tools", () => {
  liveIt("b2_list_buckets can target the run-owned fixture bucket", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_buckets", { bucketName: bucketName() }),
    );
    expect(result).toHaveProperty("buckets");
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].bucketId).toBe(primaryBucket.bucketId);
  });

  liveIt(
    "b2_list_buckets bucketType filter works without choosing a writable fixture",
    async () => {
      const result = parseResult(
        await callTool(server, "b2_list_buckets", { bucketTypes: ["allPrivate"], limit: 1000 }),
      );
      expect(Array.isArray(result.buckets)).toBe(true);
      expect(result.buckets.some((bucket: any) => bucket.bucketId === primaryBucket.bucketId)).toBe(
        true,
      );
    },
  );

  liveIt("b2_list_keys returns key metadata without exposing secrets", async () => {
    const result = parseResult(await callTool(server, "b2_list_keys", { maxKeyCount: 100 }));
    expect(result).toHaveProperty("keys");
    expect(Array.isArray(result.keys)).toBe(true);
    expect(result.keys.length).toBeGreaterThan(0);
    for (const key of result.keys) {
      expect(key).toHaveProperty("applicationKeyId");
      expect(key).toHaveProperty("keyName");
      expect(key).toHaveProperty("capabilities");
      expect(key).not.toHaveProperty("applicationKey");
      expect(key).not.toHaveProperty("masterApplicationKey");
    }
  });
});

describe("S3-compatible bucket and object tools", () => {
  liveIt("s3_head_bucket and s3_get_bucket_location target the run-owned bucket", async () => {
    expectLiveSuccess(
      await callTool(server, "s3_head_bucket", { bucket: bucketName() }),
      "s3_head_bucket",
    );
    const location = parseResult(
      await callTool(server, "s3_get_bucket_location", { bucket: bucketName() }),
    );
    expect(location).toHaveProperty("locationConstraint");
  });

  liveIt("uploads, downloads, copies, paginates, and deletes run-owned objects", async () => {
    const sourceKey = contractObjectKey("objects", "source.txt");
    const copyKey = contractObjectKey("objects", "copy.txt");
    const versionedKey = contractObjectKey("objects-version", "versioned.txt");
    const pagedKeys = [1, 2, 3].map((n) => contractObjectKey("objects-page", `item-${n}.txt`));

    for (const key of [sourceKey, ...pagedKeys]) {
      expectLiveSuccess(
        await callTool(server, "s3_put_object", {
          bucket: bucketName(),
          key,
          content: base64(`fixture:${key}`),
          contentType: "text/plain",
          metadata: { run: liveRunPrefix() },
        }),
        "s3_put_object",
      );
    }

    const downloaded = parseResult(
      await callTool(server, "s3_get_object", { bucket: bucketName(), key: sourceKey }),
    );
    expect(Buffer.from(downloaded.content, "base64").toString("utf8")).toContain("fixture:");

    expectLiveSuccess(
      await callTool(server, "s3_copy_object", {
        sourceBucket: bucketName(),
        sourceKey,
        destinationBucket: bucketName(),
        destinationKey: copyKey,
      }),
      "s3_copy_object",
    );

    const copiedHead = parseResult(
      await callTool(server, "s3_head_object", { bucket: bucketName(), key: copyKey }),
    );
    expect(copiedHead.key).toBe(copyKey);

    const firstPage = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/objects-page/`,
        maxKeys: 2,
      }),
    );
    expect(firstPage.objects).toHaveLength(2);
    expect(firstPage.isTruncated).toBe(true);
    const secondPage = parseResult(
      await callTool(server, "s3_list_objects_v2", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/objects-page/`,
        continuationToken: firstPage.nextContinuationToken,
        maxKeys: 2,
      }),
    );
    expect(secondPage.objects.length).toBeGreaterThanOrEqual(1);

    for (const content of ["version:1", "version:2"]) {
      expectLiveSuccess(
        await callTool(server, "s3_put_object", {
          bucket: bucketName(),
          key: versionedKey,
          content: base64(content),
          contentType: "text/plain",
          metadata: { run: liveRunPrefix() },
        }),
        "s3_put_object versioned fixture",
      );
    }

    expectLiveSuccess(
      await callTool(server, "s3_delete_object", {
        bucket: bucketName(),
        key: versionedKey,
        confirm: true,
      }),
      "s3_delete_object versioned fixture",
    );

    const firstVersionPage = parseResult(
      await callTool(server, "s3_list_object_versions", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/objects-version/`,
        maxKeys: 1,
      }),
    );
    expect(firstVersionPage.isTruncated).toBe(true);
    expect(firstVersionPage.nextKeyMarker).toEqual(expect.any(String));
    expect(firstVersionPage.nextVersionIdMarker).toEqual(expect.any(String));
    const secondVersionPage = parseResult(
      await callTool(server, "s3_list_object_versions", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/objects-version/`,
        keyMarker: firstVersionPage.nextKeyMarker,
        versionIdMarker: firstVersionPage.nextVersionIdMarker,
        maxKeys: 1000,
      }),
    );
    const versionRows = [
      ...(firstVersionPage.versions ?? []),
      ...(secondVersionPage.versions ?? []),
    ];
    const deleteMarkerRows = [
      ...(firstVersionPage.deleteMarkers ?? []),
      ...(secondVersionPage.deleteMarkers ?? []),
    ];
    expect(versionRows.some((version: any) => version.Key === versionedKey)).toBe(true);
    expect(deleteMarkerRows.some((marker: any) => marker.Key === versionedKey)).toBe(true);

    const versionDeleteTargets = [...versionRows, ...deleteMarkerRows]
      .filter((entry: any) => entry.Key === versionedKey && typeof entry.VersionId === "string")
      .map((entry: any) => ({ key: entry.Key, versionId: entry.VersionId }));
    expect(versionDeleteTargets.length).toBeGreaterThanOrEqual(2);
    const versionCleanup = parseResult(
      await callTool(server, "s3_delete_objects", {
        bucket: bucketName(),
        objects: versionDeleteTargets,
        quiet: false,
        confirm: true,
      }),
    );
    expect(versionCleanup.errors).toEqual([]);
    expect(versionCleanup.attempted).toBe(versionDeleteTargets.length);

    const deleted = parseResult(
      await callTool(server, "s3_delete_objects", {
        bucket: bucketName(),
        objects: [sourceKey, copyKey, ...pagedKeys].map((key) => ({ key })),
        quiet: false,
        confirm: true,
      }),
    );
    expect(deleted.errors).toEqual([]);
    expect(deleted.attempted).toBe(2 + pagedKeys.length);
  });
});

describe("S3 presigned and multipart helpers", () => {
  liveIt(
    "s3_get_presigned_url generates GET and PUT bearer URLs without logging them",
    async () => {
      const key = contractObjectKey("presign", "probe.txt");
      const getUrl = parseResult(
        await callTool(server, "s3_get_presigned_url", {
          bucket: bucketName(),
          key,
          operation: "GetObject",
          expiresIn: 60,
        }),
      );
      const putUrl = parseResult(
        await callTool(server, "s3_get_presigned_url", {
          bucket: bucketName(),
          key,
          operation: "PutObject",
          contentType: "text/plain",
          expiresIn: 60,
          confirm: true,
        }),
      );
      expect(getUrl.url).toMatch(/^https:\/\//);
      expect(putUrl.url).toMatch(/^https:\/\//);
    },
  );

  liveIt("creates, lists, presigns, and aborts a test-owned multipart upload", async () => {
    const key = contractObjectKey("multipart", "large.bin");
    const created = parseResult(
      await callTool(server, "s3_create_multipart_upload", {
        bucket: bucketName(),
        key,
        contentType: "application/octet-stream",
      }),
    );
    expect(created.uploadId).toBeTruthy();

    try {
      const listed = parseResult(
        await callTool(server, "s3_list_multipart_uploads", {
          bucket: bucketName(),
          prefix: `${liveRunPrefix()}/multipart/`,
          maxUploads: 1000,
        }),
      );
      expect(listed.uploads.some((upload: any) => upload.UploadId === created.uploadId)).toBe(true);

      const presigned = parseResult(
        await callTool(server, "s3_presign_upload_part", {
          bucket: bucketName(),
          key,
          uploadId: created.uploadId,
          partNumbers: [1],
          expiresIn: 60,
        }),
      );
      expect(presigned.parts?.[0]?.url).toMatch(/^https:\/\//);
    } finally {
      await callTool(server, "s3_abort_multipart_upload", {
        bucket: bucketName(),
        key,
        uploadId: created.uploadId,
        confirm: true,
      });
    }
  });
});

describe("Object Lock live file contracts", () => {
  liveIt("sets and clears legal hold and governance retention on a run-owned object", async () => {
    const lockBucket = await bucketTracker.createBucket("object-lock", {
      fileLockEnabled: true,
    });
    try {
      const key = contractObjectKey("object-lock", "locked.txt");
      expectLiveSuccess(
        await callTool(server, "s3_put_object", {
          bucket: lockBucket.bucketName,
          key,
          content: base64("locked fixture"),
          contentType: "text/plain",
        }),
        "s3_put_object object lock fixture",
      );
      const head = parseResult(
        await callTool(server, "s3_head_object", { bucket: lockBucket.bucketName, key }),
      );
      expect(head.versionId).toBeTruthy();

      expectLiveSuccess(
        await callTool(server, "b2_update_file_legal_hold", {
          fileId: head.versionId,
          fileName: key,
          legalHold: "on",
        }),
        "b2_update_file_legal_hold on",
      );
      expectLiveSuccess(
        await callTool(server, "b2_update_file_legal_hold", {
          fileId: head.versionId,
          fileName: key,
          legalHold: "off",
          confirm: true,
        }),
        "b2_update_file_legal_hold off",
      );

      const retainUntilTimestamp = Date.now() + 2 * 60 * 1000;
      expectLiveSuccess(
        await callTool(server, "b2_update_file_retention", {
          fileId: head.versionId,
          fileName: key,
          fileRetention: { mode: "governance", retainUntilTimestamp },
        }),
        "b2_update_file_retention set",
      );
      expectLiveSuccess(
        await callTool(server, "b2_update_file_retention", {
          fileId: head.versionId,
          fileName: key,
          fileRetention: { mode: null, retainUntilTimestamp: null },
          bypassGovernance: true,
          confirm: true,
        }),
        "b2_update_file_retention clear",
      );
    } finally {
      await bucketTracker.cleanupBucket(lockBucket);
    }
  });
});

describe("Insight scans, cancellation, and error mapping", () => {
  liveIt("b2_largest_files and b2_unfinished_uploads scan only the run-owned bucket", async () => {
    const key = contractObjectKey("insights", "largest.txt");
    expectLiveSuccess(
      await callTool(server, "s3_put_object", {
        bucket: bucketName(),
        key,
        content: base64("insight fixture"),
        contentType: "text/plain",
      }),
      "s3_put_object insight fixture",
    );

    const largest = parseResult(
      await callTool(server, "b2_largest_files", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/insights/`,
        limit: 5,
        max_scan: 1000,
      }),
    );
    expect(largest.scanned).toBeGreaterThanOrEqual(1);
    expect(largest.files.some((file: any) => file.name === key || file.fileName === key)).toBe(
      true,
    );

    const unfinished = parseResult(
      await callTool(server, "b2_unfinished_uploads", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/`,
        max_uploads: 100,
      }),
    );
    expect(unfinished).toHaveProperty("unfinished_count");
  });

  liveIt("propagates cancellation through a live SDK-backed tool", async () => {
    const controller = new AbortController();
    controller.abort(new Error("live contract cancellation"));
    const result = await runWithMcpRequestSignal(controller.signal, () =>
      callTool(server, "b2_largest_files", {
        bucket: bucketName(),
        prefix: `${liveRunPrefix()}/`,
        limit: 1,
        max_scan: 1000,
      }),
    );
    expect(isError(result)).toBe(true);
    expect(liveErrorText(result)).toMatch(/abort|cancel/i);
  });

  liveIt("maps provider errors with status, code, and request id when B2 returns one", async () => {
    const result = await callTool(server, "s3_head_object", {
      bucket: bucketName(),
      key: contractObjectKey("missing-error", "missing.txt"),
    });
    expect(isError(result)).toBe(true);
    const parsed = parseErrorText(liveErrorText(result));
    expect(parsed?.status).toBeGreaterThanOrEqual(400);
    expect(parsed?.code).toBeTruthy();
    expect(parsed?.requestId).toEqual(expect.any(String));
    expect(parsed?.requestId?.length).toBeGreaterThan(0);
    expect(liveErrorText(result)).not.toContain("internal_error");
  });
});

describe("Partner API read paths", () => {
  liveIt("b2_list_groups returns groups for the Partner-entitled account", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    const result = await callTool(server, "b2_list_groups", { adminAccountId: authData.accountId });
    expectLiveSuccess(result, "b2_list_groups");
    const data = parseResult(result);
    expect(data).toHaveProperty("groups");
    expect(Array.isArray(data.groups)).toBe(true);
  });

  liveIt("b2_list_group_members returns a structured error for an unknown groupId", async () => {
    const authData = parseResult(await callTool(server, "b2_authorize_account", {}));
    const result = await callTool(server, "b2_list_group_members", {
      adminAccountId: authData.accountId,
      groupId: "000000000000000000000000",
    });
    expect(isError(result)).toBe(true);
    expect(liveErrorText(result)).toMatch(/invalid_group_id|bad_request/i);
  });
});
