/**
 * Tests for the stdio entry point. Mocks SDK v2 serveStdio so no real stdin/
 * stdout wiring happens, and exercises startStdio() end-to-end.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRegisteredTools } from "../../src/mcp";
import { invalidateCapabilityCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(),
}));

import { startStdio } from "../../src/index";

/** Build the server from the factory that startStdio handed to serveStdio. */
function servedTools() {
  const factory = vi.mocked(serveStdio).mock.calls[0]?.[0] as unknown as () => Parameters<
    typeof getRegisteredTools
  >[0];
  expect(factory).toBeTypeOf("function");
  return getRegisteredTools(factory()) ?? {};
}

async function listBucketsResult() {
  const result = await servedTools().b2_list_buckets.execute({}, {} as never);
  return JSON.stringify(result);
}

function setTempSecretSinkFile(): void {
  process.env.B2_SECRET_SINK_FILE = join(
    mkdtempSync(join(tmpdir(), "b2-mcp-stdio-secret-sink-")),
    "secrets.jsonl",
  );
}

describe("startStdio", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    setB2SdkClientFactoryForTests(null);
    invalidateCapabilityCache();
    vi.clearAllMocks();
  });

  it("loads config, builds the server, and connects the stdio transport", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    process.env.B2_REGISTER_ALL_TOOLS = "true";
    setTempSecretSinkFile();

    await expect(startStdio()).resolves.toBeUndefined();
    expect(serveStdio).toHaveBeenCalledTimes(1);
    const tools = servedTools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["b2_list_buckets", "s3_put_object", "b2_delete_bucket"]),
    );
    expect(tools.b2_list_buckets.availability).toBe("available");
  });

  it("starts stdio with full surface when capability discovery is transiently unavailable", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    delete process.env.B2_REGISTER_ALL_TOOLS;
    setTempSecretSinkFile();
    installSdkTransport(
      new RecordingTransport(
        () =>
          new StaticHttpResponse(500, {
            status: 500,
            code: "internal_error",
            message: "timeout",
          }),
      ),
    );

    await expect(startStdio()).resolves.toBeUndefined();
    expect(serveStdio).toHaveBeenCalledTimes(1);
    // Unknown capabilities (null) keep the full, working surface.
    const tools = servedTools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["b2_list_buckets", "s3_put_object", "b2_delete_bucket"]),
    );
    expect(await listBucketsResult()).not.toContain("missing_credentials");
  });

  it("starts discovery mode when stdio capability discovery rejects the credential", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    delete process.env.B2_REGISTER_ALL_TOOLS;
    setTempSecretSinkFile();
    installSdkTransport(
      new RecordingTransport(
        () =>
          new StaticHttpResponse(401, {
            status: 401,
            code: "unauthorized",
            message: "denied",
          }),
      ),
    );

    await expect(startStdio()).resolves.toBeUndefined();
    expect(serveStdio).toHaveBeenCalledTimes(1);
    // The surface stays listable, but every call is refused as missing credentials.
    expect(Object.keys(servedTools())).toContain("b2_list_buckets");
    expect(await listBucketsResult()).toContain("missing_credentials");
  });

  it("starts in credential-less discovery mode instead of exiting when credentials are missing", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    // Discovery mode replaces the old exit(1): the server starts and registers
    // the full surface so directories can enumerate tools without credentials.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(startStdio()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(serveStdio).toHaveBeenCalledTimes(1);
    expect(Object.keys(servedTools())).toEqual(
      expect.arrayContaining(["b2_list_buckets", "s3_put_object"]),
    );
    expect(await listBucketsResult()).toContain("missing_credentials");
    exit.mockRestore();
  });
});
