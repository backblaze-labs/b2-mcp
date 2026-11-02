import { describe, expect, it, vi } from "vitest";
const destroys = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
vi.mock("@backblaze-labs/b2-sdk/s3", () => ({
  createS3ClientConfig: vi.fn((i) => ({ endpoint: "x", region: i.region, credentials: {} })),
}));
vi.mock("../../src/s3/aws-sdk-adapter.js", () => ({
  createB2S3PeerClient: vi.fn(() => {
    const destroy = vi.fn();
    destroys.push(destroy);
    return { getObject: vi.fn(async () => ({ body: {} })), destroy };
  }),
}));
import { createAuthorizedS3Client } from "../../src/s3/client";
describe("fallback client lifetime", () => {
  it("does not destroy the one-shot client before the body is consumed", async () => {
    const facade = createAuthorizedS3Client({
      getConfig: () => ({ region: "us-west-004", applicationKeyId: "a", applicationKey: "b" }) as never,
      getAuth: async () => { throw Object.assign(new Error("down"), { status: 503 }); },
    });
    await (facade as never as { getObject: (i: unknown) => Promise<unknown> }).getObject({});
    expect(destroys[0]).not.toHaveBeenCalled();
  });
});
