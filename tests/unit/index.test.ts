/**
 * Tests for the stdio entry point. Mocks the SDK transport so no real stdin/
 * stdout wiring happens, and exercises startStdio() end-to-end (loadConfig →
 * createServer → connect).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { startStdio } from "../../src/index";

describe("startStdio", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.clearAllMocks();
  });

  it("loads config, builds the server, and connects the stdio transport", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";

    await expect(startStdio()).resolves.toBeUndefined();
    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
  });

  it("exits the process when required credentials are missing", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    // loadConfig() calls process.exit(1) on missing creds — stub it so the
    // test doesn't actually exit, and assert it was triggered.
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(startStdio()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
