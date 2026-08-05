import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { B2ReportClient } from "../../src/b2/report-client";
import type { McpServer } from "../../src/mcp";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "legacy-s3-key-id",
  appKey: "legacy-s3-secret",
  masterKeyId: "test-key-id",
  masterKey: "test-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

function maliciousAuthorizeResponse(overrides: { s3ApiUrl?: string; apiUrl?: string }) {
  const response = authorizeResponse(["readFiles"]);
  return {
    ...response,
    apiInfo: {
      storageApi: {
        ...response.apiInfo.storageApi,
        ...(overrides.s3ApiUrl !== undefined ? { s3ApiUrl: overrides.s3ApiUrl } : {}),
        ...(overrides.apiUrl !== undefined ? { apiUrl: overrides.apiUrl } : {}),
      },
    },
  };
}

function reportAuth() {
  return {
    accountId: "test-account-123",
    authorizationToken: "mock-token-xyz",
    apiUrl: "https://api005.backblazeb2.com",
    downloadUrl: "https://f005.backblazeb2.com",
    s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
    recommendedPartSize: 100 * 1024 * 1024,
    absoluteMinimumPartSize: 5 * 1024 * 1024,
    capabilities: ["readFiles"],
  };
}

function parseToolJson(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  return JSON.parse(result.content[0].text);
}

function reportCsv(
  accountId: string,
  date: string,
  storedGb: number,
  downloadedGb: number,
): string {
  return (
    "account_id,date,bucket_id,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\n" +
    `${accountId},${date},bucket-${accountId},bucket-${accountId},${storedGb},${downloadedGb},0,0\n`
  );
}

function reportBody(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

describe("insight report S3 endpoint validation", () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    invalidateAuthManagerCache();
    sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({ Contents: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setB2SdkClientFactoryForTests(null);
    invalidateAuthManagerCache();
  });

  it.each([
    ["b2_usage_growth", { period: "month", limit: 1 }],
    ["b2_egress_leaders", { by: "account", limit: 1 }],
  ])("%s rejects an injected report S3 endpoint before S3 send", async (toolName, args) => {
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(
          200,
          maliciousAuthorizeResponse({
            s3ApiUrl: "https://attacker.example/report-bucket",
          }),
        );
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    const server = createServer(testConfig);

    const result = await callTool(server, toolName, args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authorized B2 S3 endpoint");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects an injected native B2 API endpoint before sending the bearer token", async () => {
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(
          200,
          maliciousAuthorizeResponse({
            apiUrl: "https://169.254.169.254/",
          }),
        );
      }
      throw new Error(`unexpected token-bearing request to ${request.url}`);
    });
    installSdkTransport(transport);
    const server = createServer(testConfig);

    const result = await callTool(server, "b2_list_buckets", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authorized B2 API endpoint");
    expect(transport.requests).toHaveLength(1);
  });

  it("destroys the per-server report S3 client when the server closes", async () => {
    const destroySpy = jest.spyOn(B2ReportClient.prototype, "destroy");
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["readFiles"]));
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    const server = createServer(testConfig);

    const result = await callTool(server, "b2_usage_growth", { period: "month", limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(sendSpy).toHaveBeenCalled();

    await server.close();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("streams report downloads and stops at the configured byte cap", async () => {
    let chunksRead = 0;
    const body = {
      transformToString: jest.fn(() => {
        throw new Error("should not buffer the whole object");
      }),
      destroy: jest.fn(),
      async *[Symbol.asyncIterator]() {
        chunksRead++;
        yield Buffer.from("abcdef");
        chunksRead++;
        yield Buffer.from("ghijkl");
      },
    };
    sendSpy.mockResolvedValueOnce({ Body: body });
    const client = new B2ReportClient({
      getConfig: () => testConfig,
      getAuth: async () => reportAuth(),
    } as never);

    const result = await client.downloadReportObjectText("b2-reports-test", "large.csv", {
      maxBytes: 3,
    });

    expect(result).toEqual({ text: "abc", bytes: 3, truncated: true });
    expect(chunksRead).toBe(1);
    expect(body.transformToString).not.toHaveBeenCalled();
    expect(body.destroy).toHaveBeenCalled();
  });

  it("aborts a stalled report body read at the request deadline", async () => {
    let resolveNext: ((value: IteratorResult<Buffer>) => void) | undefined;
    const next = jest.fn(
      () =>
        new Promise<IteratorResult<Buffer>>((resolve) => {
          resolveNext = resolve;
        }),
    );
    const body = {
      destroy: jest.fn(() => {
        resolveNext?.({ done: true, value: undefined as never });
      }),
      [Symbol.asyncIterator]: () => ({
        next,
        return: jest.fn(async () => ({ done: true, value: undefined as never })),
      }),
    };
    sendSpy.mockResolvedValueOnce({ Body: body });
    const client = new B2ReportClient({
      getConfig: () => testConfig,
      getAuth: async () => reportAuth(),
    } as never);

    await expect(
      client.downloadReportObjectText("b2-reports-test", "stalled.csv", {
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out|Timeout/);

    expect(next).toHaveBeenCalledTimes(1);
    expect(body.destroy).toHaveBeenCalled();
  });

  it.each([
    ["b2_usage_growth", { days: 30, limit: 10 }],
    ["b2_egress_leaders", { by: "account", days: 90, limit: 10 }],
  ])("%s does not use the broader S3 override credential", async (toolName, args) => {
    const thenDay = daysAgo(29);
    const latestDay = daysAgo(1);
    const tenantKeys = [
      `${thenDay}/usage.account-tenant.csv`,
      `${latestDay}/usage.account-tenant.csv`,
    ];
    const broadKeys = [
      `${thenDay}/usage.account-outside.csv`,
      `${latestDay}/usage.account-outside.csv`,
    ];
    const seenAccessKeys: string[] = [];
    sendSpy.mockImplementation(async function (this: S3Client, command: any) {
      const credentials = await this.config.credentials();
      seenAccessKeys.push(credentials.accessKeyId);
      const usingBroadOverride = credentials.accessKeyId === testConfig.appKeyId;
      const keys = usingBroadOverride ? broadKeys : tenantKeys;
      const account = usingBroadOverride ? "outside-account" : "tenant-account";
      const commandName = command.constructor.name;
      const input = command.input ?? {};

      if (commandName === "ListObjectsV2Command") {
        const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;
        const startAfter = typeof input.StartAfter === "string" ? input.StartAfter : undefined;
        let listed = [...keys].sort();
        if (prefix) listed = listed.filter((key) => key.startsWith(prefix));
        if (startAfter) listed = listed.filter((key) => key > startAfter);
        if (typeof input.MaxKeys === "number") listed = listed.slice(0, input.MaxKeys);
        return { Contents: listed.map((Key) => ({ Key })), IsTruncated: false };
      }

      if (commandName === "GetObjectCommand") {
        const key = String(input.Key);
        const date = key.slice(0, 10);
        const stored = date === thenDay ? 10 : 15;
        return { Body: reportBody(reportCsv(account, date, stored, 4)) };
      }

      throw new Error(`unexpected command ${commandName}`);
    });
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, {
          ...authorizeResponse(["readFiles"]),
          accountId: "tenant-account",
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    const server = createServer(testConfig);

    const result = await callTool(server, toolName, args);
    const text = JSON.stringify(parseToolJson(result));
    const authHeader = transport.requests[0].headers?.Authorization ?? "";
    const authorizedCredential = Buffer.from(authHeader.replace(/^Basic\s+/i, ""), "base64")
      .toString("utf8")
      .split(":")[0];

    expect(result.isError).not.toBe(true);
    expect(authorizedCredential).toBe(testConfig.applicationKeyId);
    expect(seenAccessKeys).toEqual(expect.arrayContaining([testConfig.applicationKeyId]));
    expect(seenAccessKeys).not.toContain(testConfig.appKeyId);
    expect(text).toContain("tenant-account");
    expect(text).not.toContain("outside-account");
  });
});
