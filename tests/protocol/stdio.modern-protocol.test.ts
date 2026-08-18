/**
 * Tests for the stdio entry point. Mocks SDK v2 serveStdio so no real stdin/
 * stdout wiring happens, and exercises startStdio() end-to-end.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  });

  it("fails closed when stdio capability discovery rejects the credential", async () => {
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

    await expect(startStdio()).rejects.toMatchObject({ code: "capability_auth_failed" });
    expect(serveStdio).not.toHaveBeenCalled();
  });

  it("exits the process when required credentials are missing", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    // loadConfig() calls process.exit(1) on missing creds — stub it so the
    // test doesn't actually exit, and assert it was triggered.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(startStdio()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
