/**
 * Tests for the stdio entry point. Mocks SDK v2 serveStdio so no real stdin/
 * stdout wiring happens, and exercises startStdio() end-to-end.
 */

import axios from "axios";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

jest.mock("axios");
jest.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: jest.fn(),
}));

import { startStdio } from "../../src/index";

const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

describe("startStdio", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.clearAllMocks();
  });

  it("loads config, builds the server, and connects the stdio transport", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    process.env.B2_REGISTER_ALL_TOOLS = "true";

    await expect(startStdio()).resolves.toBeUndefined();
    expect(serveStdio).toHaveBeenCalledTimes(1);
  });

  it("starts stdio with full surface when capability discovery is transiently unavailable", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    delete process.env.B2_REGISTER_ALL_TOOLS;
    mockedAxios.get.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));

    await expect(startStdio()).resolves.toBeUndefined();
    expect(serveStdio).toHaveBeenCalledTimes(1);
  });

  it("fails closed when stdio capability discovery rejects the credential", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    delete process.env.B2_REGISTER_ALL_TOOLS;
    mockedAxios.get.mockRejectedValue(
      Object.assign(new Error("denied"), { response: { status: 401 } }),
    );

    await expect(startStdio()).rejects.toMatchObject({ code: "capability_auth_failed" });
    expect(serveStdio).not.toHaveBeenCalled();
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
