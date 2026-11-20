/**
 * Case C1: when authorize fails and the facade falls back to an uncached S3 client, that
 * client must stay alive until the download body has been read. The defect is still present,
 * so the test uses `knownDefect` (see tests/support/known-defect.ts).
 */
import { describe, expect, vi } from "vitest";
import { knownDefect } from "../support/known-defect";

const peers = vi.hoisted(
  () => [] as Array<{ destroy: ReturnType<typeof vi.fn>; destroyedAtReturn?: boolean }>,
);

vi.mock("@backblaze-labs/b2-sdk/s3", () => ({
  createS3ClientConfig: vi.fn((input) => ({
    endpoint: input.accountInfo.getS3ApiUrl(),
    region: input.region,
    credentials: { accessKeyId: input.applicationKeyId, secretAccessKey: input.applicationKey },
  })),
}));

vi.mock("../../src/s3/aws-sdk-adapter.js", () => ({
  createB2S3PeerClient: vi.fn(() => {
    const peer = {
      destroy: vi.fn(),
      getObject: vi.fn(async () => ({ body: "stream-bound-to-this-client" })),
    };
    peers.push(peer);
    return peer;
  }),
}));

import { createAuthorizedS3Client } from "../../src/s3/client";
import type { B2Config } from "../../src/utils/types";

const config: B2Config = {
  applicationKeyId: "principal-key-id",
  applicationKey: "principal-secret",
  appKeyId: "legacy-s3-key-id",
  appKey: "legacy-s3-secret",
  masterKeyId: "master-key-id",
  masterKey: "master-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
  transport: "stdio",
};

describe("createAuthorizedS3Client fallback client lifecycle (Finding C1)", () => {
  knownDefect(
    "Finding C1: does not destroy the fallback client before the caller has consumed the object body",
    async () => {
      const facade = createAuthorizedS3Client({
        getConfig: () => config,
        getAuth: async () => {
          throw Object.assign(new Error("authorize outage"), { status: 503, code: "unavailable" });
        },
      });

      const object = await (
        facade as unknown as { getObject: (input: unknown) => Promise<{ body: unknown }> }
      ).getObject({ bucket: "b", key: "k" });

      expect(object.body, "object body is returned").toBe("stream-bound-to-this-client");
      expect(peers, "one fallback client created").toHaveLength(1);
      // The body is still unread here; tearing the client down now would cut the transfer.
      expect(peers[0].destroy).not.toHaveBeenCalled();
    },
  );
});
