import { S3Client } from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../../src/auth";
import type { McpServer } from "../../src/mcp";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "./sdk-test-helpers";

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
});
