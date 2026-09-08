// Branch-coverage expansion for src/server.ts (issue #400, phase 1).
//
// Drives the capability-failure error mapper through fetchCapabilities across
// the retryable/non-retryable and network-code permutations that existing
// tests leave uncovered, plus the discovery-mode argument-summary helper via
// createMissingCredentialsToolCallback and the low-level tools/call interceptor.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createMissingCredentialsToolCallback,
  createServer,
  fetchCapabilities,
  invalidateCapabilityCache,
} from "../../src/server";
import { logger } from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";
import { testConfig } from "../support/deterministic-fakes";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

const baseConfig = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "k",
  masterKey: "s",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
} as unknown as B2Config;

function installAuthorizeFailure(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): RecordingTransport {
  const transport = new RecordingTransport(
    () => new StaticHttpResponse(status, { status, code, message }, headers),
  );
  installSdkTransport(transport);
  return transport;
}

afterEach(() => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateCapabilityCache();
});

describe("capability failure error mapper", () => {
  it("maps a 403 upstream status to a fail-closed auth error", async () => {
    installAuthorizeFailure(403, "forbidden", "no access");
    await expect(fetchCapabilities(baseConfig)).rejects.toMatchObject({
      status: 403,
      code: "capability_auth_failed",
    });
  });

  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"])(
    "treats a client-status failure carrying %s as retryable",
    async (networkCode) => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      installAuthorizeFailure(400, networkCode, `network ${networkCode}`);
      await expect(
        fetchCapabilities(baseConfig, `credential:${networkCode}`, `log:${networkCode}`),
      ).rejects.toMatchObject({
        status: 503,
        code: "capability_upstream_unavailable",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ retryable: true }),
        "capability.fetch.failed",
      );
    },
  );

  it("maps a non-retryable client failure to capability_upstream_failed (502)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    installAuthorizeFailure(400, "bad_request", "malformed capability request");
    await expect(
      fetchCapabilities(baseConfig, "credential:client-fail", "log:client-fail"),
    ).rejects.toMatchObject({
      status: 502,
      code: "capability_upstream_failed",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: false }),
      "capability.fetch.failed",
    );
  });

  it("treats a statusless transport error as retryable with no upstream code", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    installSdkTransport(
      new RecordingTransport(() => {
        throw new Error("socket exploded before any response");
      }),
    );
    await expect(
      fetchCapabilities(baseConfig, "credential:statusless", "log:statusless"),
    ).rejects.toMatchObject({
      status: 503,
      code: "capability_upstream_unavailable",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamStatus: undefined, upstreamCode: undefined }),
      "capability.fetch.failed",
    );
  });
});

describe("discovery-mode argument summary helper", () => {
  it.each([
    { label: "array", args: ["a", "b"], expected: { argKeyCount: 0 } },
    { label: "primitive", args: 42, expected: { argKeyCount: 0 } },
    { label: "null", args: null, expected: { argKeyCount: 0 } },
    { label: "object", args: { one: 1, two: 2 }, expected: { argKeyCount: 2 } },
  ])("summarizes $label arguments as $expected.argKeyCount keys", async ({ args, expected }) => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const callback = createMissingCredentialsToolCallback("b2_list_buckets", testConfig);

    const result = await callback(args as never, {} as never);

    expect(result.isError).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "b2_list_buckets", ...expected }),
      "tool.call",
    );
  });

  it("truncates an oversized argument-key count and flags it", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const callback = createMissingCredentialsToolCallback("b2_list_buckets", testConfig);
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 150; i++) manyKeys[`k${i}`] = i;

    await callback(manyKeys as never, {} as never);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ argKeyCount: 100, argKeysTruncated: true }),
      "tool.call",
    );
  });
});

describe("discovery-mode tools/call interceptor", () => {
  async function connectDiscoveryClient() {
    const server = createServer(testConfig, null, { credentialsUnavailable: true });
    const client = new Client({ name: "discovery-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      async close() {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      },
    };
  }

  it("records the resolved tool name for a registered tool call", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const { client, close } = await connectDiscoveryClient();
    try {
      const result = await client.callTool({ name: "b2_list_buckets", arguments: {} });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "b2_list_buckets", code: "missing_credentials" }),
        "tool.call",
      );
    } finally {
      await close();
    }
  });

  it("classifies an unregistered tool name as unknown_tool", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const { client, close } = await connectDiscoveryClient();
    try {
      await client.callTool({ name: "totally_made_up_tool", arguments: { a: 1 } });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "unknown_tool", argKeyCount: 1 }),
        "tool.call",
      );
    } finally {
      await close();
    }
  });
});
