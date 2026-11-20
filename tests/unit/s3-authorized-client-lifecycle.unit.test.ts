/**
 * Case C1: when authorize fails and the facade falls back to an uncached S3 client, that
 * client must stay alive until the download body has been read. The defect is still present,
 * so the test uses `knownDefect` (see tests/support/known-defect.ts).
 */
import { describe, expect, vi } from "vitest";
import { expectDefect, knownDefect } from "../support/known-defect";

const BODY_BYTES = vi.hoisted(() => new TextEncoder().encode("stream-bound-to-this-client"));

interface FakePeer {
  destroy: ReturnType<typeof vi.fn>;
  getObject: ReturnType<typeof vi.fn>;
  /** Set when the response body is pulled after the owning client was destroyed. */
  pulledAfterDestroy: boolean;
}

const peers = vi.hoisted(() => [] as FakePeer[]);

vi.mock("@backblaze-labs/b2-sdk/s3", () => ({
  createS3ClientConfig: vi.fn((input) => ({
    endpoint: input.accountInfo.getS3ApiUrl(),
    region: input.region,
    credentials: { accessKeyId: input.applicationKeyId, secretAccessKey: input.applicationKey },
  })),
}));

vi.mock("../../src/s3/aws-sdk-adapter.js", () => ({
  createB2S3PeerClient: vi.fn(() => {
    const peer: FakePeer = {
      destroy: vi.fn(),
      pulledAfterDestroy: false,
      // A real S3 body is a stream bound to the client's connection: once the client is
      // destroyed, the stream can no longer be read.
      getObject: vi.fn(async () => ({
        key: "k",
        metadata: {},
        // highWaterMark 0: bytes are produced only when the caller reads, like a socket.
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (peer.destroy.mock.calls.length > 0) {
                peer.pulledAfterDestroy = true;
                controller.error(new Error("socket closed: client destroyed"));
                return;
              }
              controller.enqueue(BODY_BYTES);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      })),
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
        facade as unknown as {
          getObject: (input: unknown) => Promise<{ body: ReadableStream<Uint8Array> }>;
          destroy: () => void;
        }
      ).getObject({ bucket: "b", key: "k" });
      expect(peers, "one fallback client created").toHaveLength(1);
      const [peer] = peers;

      // Consume the body the way a caller does, to completion.
      const received: Uint8Array[] = [];
      let readError: unknown;
      try {
        const reader = object.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
      } catch (error) {
        readError = error;
      }

      // The body must stay readable while the caller reads it; destroying the client at
      // return would cut the transfer.
      await expectDefect(() => {
        expect(readError, "body readable while the fallback client is alive").toBeUndefined();
        expect(peer.pulledAfterDestroy, "body pulled after the client was destroyed").toBe(false);
        expect(Buffer.concat(received).toString(), "bytes read from the body").toBe(
          Buffer.from(BODY_BYTES).toString(),
        );
      });

      // Once the body is consumed and the facade is closed, the fallback client is released.
      object.body.cancel?.().catch(() => undefined);
      facade.destroy();
      await vi.waitFor(() => expect(peer.destroy, "fallback client destroyed").toHaveBeenCalled(), {
        timeout: 1000,
      });
    },
  );
});
