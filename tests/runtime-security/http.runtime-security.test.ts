/**
 * Runtime-security regression suite for issue #197.
 *
 * These tests are intentionally local and deterministic: Node HTTP is exercised
 * through an actual localhost listener, while Vercel and Cloudflare Worker
 * coverage enters through their supported adapter fetch functions.
 */

import * as http from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import type { HttpTransport } from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import {
  closeCloudflareMcpHandlerForTests,
  cloudflareWorkerFetch,
} from "../../deploy/cloudflare-worker/adapter";
import { closeVercelMcpHandlerForTests, vercelMcpFetch } from "../../deploy/vercel/adapter";
import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import { invalidateAuthManagerCache } from "../../src/server";
import { logger } from "../../src/utils/logger";
import { _resetRateLimiter } from "../../src/utils/rate-limiter";
import { MODERN_PROTOCOL_VERSION, modernBody, modernHeaders } from "../protocol/support/clients";
import { adapterProtocolEnv } from "../protocol/support/serverless-adapter";
import { closeHttpServer, creds, JSON_HEADERS, listenOnLocalhost, request } from "../support/http";
import { introspectionResponse } from "../support/oauth-introspection";
import { signedJwt } from "../support/oauth-jwks";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";
import {
  runtimeApplicability,
  serverlessRuntimeNames,
  type ServerlessRuntimeName,
} from "./support/applicability";

const ISSUE = "issue-197-runtime-security";
const SERVERLESS_URL = "https://mcp.example.com/mcp";
const CANARY_BODY = "B2_MCP_CANARY_SECRET_runtime_security_body";
const CANARY_B2_SECRET = "runtime-b2-secret-value";
const CANARY_BEARER = "runtime-bearer-token-value";
const CANARY_APP_SECRET = "runtime-app-secret-value";
const RUNTIME_SECURITY_SUBJECT = "subject";

let handle: HttpServerHandle | null = null;
let port = 0;

const savedEnv = { ...process.env };

const nodeRuntime = runtimeApplicability["node-http"];

interface ServerlessRuntime {
  readonly name: ServerlessRuntimeName;
  readonly applicability: (typeof runtimeApplicability)[ServerlessRuntimeName];
  fetch(request: Request, envOverrides?: NodeJS.ProcessEnv): Promise<Response>;
}

function resetNodeEnv(overrides: NodeJS.ProcessEnv = {}): void {
  process.env = {
    ...savedEnv,
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_HTTP_CREDENTIAL_MODE: "headers",
    ...overrides,
  };
}

function serverlessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return adapterProtocolEnv(savedEnv, {
    subject: RUNTIME_SECURITY_SUBJECT,
    url: SERVERLESS_URL,
    envOverrides: {
      B2_APPLICATION_KEY_ID: "runtime-app-id",
      B2_APPLICATION_KEY: CANARY_APP_SECRET,
      B2_OAUTH_INTROSPECTION_RETRIES: "0",
      B2_OAUTH_INTROSPECTION_TIMEOUT_MS: "250",
      ...overrides,
    },
  });
}

const serverlessFetchers: Record<ServerlessRuntimeName, ServerlessRuntime["fetch"]> = {
  async vercel(input, envOverrides = {}) {
    process.env = serverlessEnv(envOverrides);
    return vercelMcpFetch(input, { remoteAddress: "198.51.100.22" });
  },
  async "cloudflare-worker"(input, envOverrides = {}) {
    process.env = { ...savedEnv, NODE_ENV: "test" };
    return cloudflareWorkerFetch(
      input,
      serverlessEnv({ B2_ALLOW_LOCAL_FILES: "false", ...envOverrides }),
      {
        remoteAddress: "198.51.100.23",
      },
    );
  },
};

const serverlessRuntimes: ServerlessRuntime[] = serverlessRuntimeNames.map((name) => ({
  name,
  applicability: runtimeApplicability[name],
  fetch: serverlessFetchers[name],
}));

const tokenClaimCases: Array<{
  name: string;
  claims: Record<string, unknown>;
  status: number;
}> = [
  { name: "expired", claims: { exp: 1 }, status: 401 },
  { name: "wrong issuer", claims: { iss: "https://issuer.evil.example/" }, status: 401 },
  { name: "wrong audience", claims: { aud: ["https://mcp.example.com/other"] }, status: 401 },
  { name: "wrong resource", claims: { resource: ["https://mcp.example.com/other"] }, status: 401 },
  { name: "wrong scope", claims: { scope: "profile" }, status: 403 },
];

function mcpRequest(
  headers: Record<string, string>,
  body = modernBody("tools/list"),
  method = "POST",
): Request {
  return new Request(SERVERLESS_URL, {
    method,
    headers: { host: "mcp.example.com", ...headers },
    body: method === "POST" ? body : undefined,
  });
}

async function startNode(
  overrides: NodeJS.ProcessEnv = {},
  transport?: HttpTransport,
): Promise<void> {
  if (handle) await closeHttpServer(handle);
  resetNodeEnv(overrides);
  const simulator = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 });
  installSdkTransport(transport ?? simulator.transport());
  handle = buildHttpServer();
  port = await listenOnLocalhost(handle);
}

function parseJson(body: string): Record<string, any> {
  return JSON.parse(body) as Record<string, any>;
}

async function responseBody(response: Response): Promise<string> {
  return await response.text();
}

function assertNoSensitiveMaterial(text: string, property: string): void {
  for (const secret of [CANARY_BODY, CANARY_B2_SECRET, CANARY_BEARER, CANARY_APP_SECRET]) {
    expect(text, `${property}: response/log output must not contain ${secret}`).not.toContain(
      secret,
    );
  }
}

function destructiveCallBody(name: string, args: Record<string, unknown>, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        "io.modelcontextprotocol/clientInfo": {
          name: "b2-mcp-runtime-security-test",
          version: "1.0.0",
        },
      },
    },
  });
}

function slowInvalidPost(): http.ClientRequest {
  const slow = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/mcp",
    headers: modernHeaders("tools/list"),
  });
  slow.on("error", () => undefined);
  slow.write("{");
  return slow;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetNodeEnv();
  _resetRateLimiter();
  installSdkTransport(
    new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 }).transport(),
  );
  vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({});
});

afterEach(async () => {
  if (handle) {
    await closeHttpServer(handle);
    handle = null;
  }
  await closeVercelMcpHandlerForTests();
  await closeCloudflareMcpHandlerForTests();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
  _resetRateLimiter();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("HTTP runtime security regression suite (#197)", () => {
  it("rejects malformed, batched, and oversized JSON-RPC bodies on Node HTTP", async () => {
    const batchTransport = new RecordingTransport((sdkRequest) => {
      const endpoint = b2EndpointName(sdkRequest);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, { buckets: [] });
      }
      return new StaticHttpResponse(500, {
        code: "unexpected_runtime_security_endpoint",
        endpoint,
      });
    });
    await startNode({}, batchTransport);
    const malformed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"canary":"${CANARY_BODY}"`,
    });
    const batch = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: JSON.stringify([
        JSON.parse(modernBody("tools/call", { name: "b2_list_buckets", arguments: {} }, 2)),
      ]),
    });
    const oversized = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: "x".repeat(1024 * 1024 + 1),
    });

    expect(
      malformed.status,
      `${ISSUE}: ${nodeRuntime.runtime} malformed JSON-RPC must be rejected predictably`,
    ).toBeGreaterThanOrEqual(400);
    const batchBody = parseJson(batch.body);
    expect(
      Array.isArray(batchBody),
      `${ISSUE}: ${nodeRuntime.runtime} JSON-RPC batch rejection must not be a batch response`,
    ).toBe(false);
    expect(
      batchBody.error,
      `${ISSUE}: ${nodeRuntime.runtime} JSON-RPC batch requests must return an error`,
    ).toBeDefined();
    expect(
      batch.status >= 400 || batchBody.error,
      `${ISSUE}: ${nodeRuntime.runtime} JSON-RPC batch requests must be rejected`,
    ).toBeTruthy();
    expect(
      batchTransport.requests.map(b2EndpointName),
      `${ISSUE}: ${nodeRuntime.runtime} rejected JSON-RPC batch must not execute b2_list_buckets`,
    ).not.toContain("b2_list_buckets");
    expect(
      oversized.status,
      `${ISSUE}: ${nodeRuntime.runtime} oversized JSON-RPC must return the body cap`,
    ).toBe(413);
    assertNoSensitiveMaterial(malformed.body, `${ISSUE}: malformed body rejection`);
    assertNoSensitiveMaterial(oversized.body, `${ISSUE}: oversized body rejection`);
  });

  it.each(serverlessRuntimes)(
    "fails closed on missing and malformed tokens in $name",
    async (rt) => {
      const missing = await rt.fetch(mcpRequest(modernHeaders("tools/list")));
      const malformedFetch = vi.fn();
      vi.stubGlobal("fetch", malformedFetch);
      const malformed = await rt.fetch(
        mcpRequest({ ...modernHeaders("tools/list"), Authorization: "Basic not-a-bearer-token" }),
      );

      expect(missing.status, `${ISSUE}: ${rt.name} missing token must fail closed`).toBe(401);
      expect(malformed.status, `${ISSUE}: ${rt.name} malformed token must fail closed`).toBe(401);
      expect(
        malformedFetch,
        `${ISSUE}: ${rt.name} malformed auth must not reach OAuth dependencies`,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(
    serverlessRuntimes.flatMap((rt) => tokenClaimCases.map((tokenCase) => ({ rt, ...tokenCase }))),
  )("fails closed on $name token claims in $rt.name", async ({ rt, name, claims, status }) => {
    const token = `${rt.name}-${name}-token`;
    const introspection = vi.fn(async () => introspectionResponse(claims));
    vi.stubGlobal("fetch", introspection);

    const response = await rt.fetch(
      mcpRequest({ ...modernHeaders("tools/list"), Authorization: `Bearer ${token}` }),
    );
    const body = await responseBody(response);

    expect(response.status, `${ISSUE}: ${rt.name} ${name} token must fail closed`).toBe(status);
    expect(
      response.headers.get("www-authenticate") ?? "",
      `${ISSUE}: ${rt.name} ${name} token should return a bearer challenge`,
    ).toContain("Bearer");
    expect(
      introspection,
      `${ISSUE}: ${rt.name} ${name} token must use local fake`,
    ).toHaveBeenCalledTimes(1);
    expect(body, `${ISSUE}: ${rt.name} ${name} response must not echo bearer token`).not.toContain(
      token,
    );
  });

  it("rejects Host/Origin bypass attempts with alternate and encoded headers on Node HTTP", async () => {
    await startNode({
      B2_ALLOWED_HOSTS: "mcp.example.com",
      B2_ALLOWED_ORIGINS: "https://mcp.example.com",
    });

    const attempts: Array<{ name: string; headers: Record<string, string> }> = [
      {
        name: "alternate forwarded host",
        headers: {
          host: "evil.example.com",
          origin: "https://mcp.example.com",
          "x-forwarded-host": "mcp.example.com",
          forwarded: "host=mcp.example.com",
        },
      },
      {
        name: "encoded host suffix",
        headers: { host: "mcp.example.com%2eevil.example", origin: "https://mcp.example.com" },
      },
      {
        name: "encoded origin suffix",
        headers: {
          host: "mcp.example.com",
          origin: "https://mcp.example.com%2eevil.example",
        },
      },
    ];

    for (const attempt of attempts) {
      const response = await request(port, "POST", "/mcp", {
        headers: { ...creds, ...modernHeaders("tools/list"), ...attempt.headers },
        body: modernBody("tools/list"),
      });
      expect(
        response.status,
        `${ISSUE}: Host/Origin bypass attempt '${attempt.name}' must be rejected`,
      ).toBe(403);
      expect(response.body).toContain("Host/Origin not allowed");
    }
  });

  it.each(serverlessRuntimes)(
    "rejects unsafe OAuth dependency destinations in $name",
    async (rt) => {
      const oauthFetch = vi.fn();
      vi.stubGlobal("fetch", oauthFetch);

      const response = await rt.fetch(
        mcpRequest({ ...modernHeaders("tools/list"), Authorization: `Bearer ${CANARY_BEARER}` }),
        {
          B2_OAUTH_INTROSPECTION_ENDPOINT: "http://169.254.169.254/latest/meta-data",
        },
      );
      const body = await responseBody(response);

      expect(response.status, `${ISSUE}: ${rt.name} unsafe OAuth endpoint must fail closed`).toBe(
        503,
      );
      expect(
        oauthFetch,
        `${ISSUE}: ${rt.name} unsafe OAuth endpoint must not be fetched`,
      ).not.toHaveBeenCalled();
      assertNoSensitiveMaterial(body, `${ISSUE}: ${rt.name} unsafe OAuth endpoint response`);
    },
  );

  it.each(serverlessRuntimes)(
    "rejects introspection redirects without following them in $name",
    async (rt) => {
      const introspection = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(
          init?.redirect,
          `${ISSUE}: ${rt.name} introspection fetch must reject redirects`,
        ).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/introspect" },
        });
      });
      vi.stubGlobal("fetch", introspection);

      const response = await rt.fetch(
        mcpRequest({ ...modernHeaders("tools/list"), Authorization: `Bearer ${CANARY_BEARER}` }),
      );
      const body = await responseBody(response);

      expect(response.status, `${ISSUE}: ${rt.name} introspection redirect must fail closed`).toBe(
        503,
      );
      expect(
        introspection,
        `${ISSUE}: ${rt.name} introspection redirect uses local fake`,
      ).toHaveBeenCalledTimes(1);
      assertNoSensitiveMaterial(body, `${ISSUE}: ${rt.name} introspection redirect response`);
    },
  );

  it.each(serverlessRuntimes)(
    "rejects JWKS redirects without following them in $name",
    async (rt) => {
      const jwksFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect, `${ISSUE}: ${rt.name} JWKS fetch must reject redirects`).toBe(
          "manual",
        );
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/jwks" },
        });
      });
      vi.stubGlobal("fetch", jwksFetch);

      const response = await rt.fetch(
        mcpRequest({ ...modernHeaders("tools/list"), Authorization: `Bearer ${signedJwt()}` }),
        {
          B2_OAUTH_INTROSPECTION_ENDPOINT: undefined,
          B2_OAUTH_INTROSPECTION_CLIENT_ID: undefined,
          B2_OAUTH_INTROSPECTION_CLIENT_SECRET: undefined,
          B2_OAUTH_JWKS_URI: "https://issuer.example.com/oauth2/jwks",
        },
      );

      expect(response.status, `${ISSUE}: ${rt.name} JWKS redirect must fail closed`).toBe(503);
      expect(jwksFetch, `${ISSUE}: ${rt.name} JWKS redirect uses local fake`).toHaveBeenCalledTimes(
        1,
      );
    },
  );

  it("keeps rate limits and in-flight limits effective for concurrent invalid Node requests", async () => {
    await startNode({
      B2_MAX_SESSIONS: "1",
      B2_MCP_RATE_LIMIT_RPS: "1",
      B2_MCP_RATE_LIMIT_BURST: "1",
    });

    const slow = slowInvalidPost();
    await sleep(50);
    const inFlightLimited = await request(port, "GET", "/mcp");
    slow.destroy();

    expect(
      inFlightLimited.status,
      `${ISSUE}: concurrent invalid Node requests must respect in-flight caps`,
    ).toBe(503);

    await closeHttpServer(handle!);
    handle = null;
    _resetRateLimiter();
    await startNode({ B2_MCP_RATE_LIMIT_RPS: "1", B2_MCP_RATE_LIMIT_BURST: "1" });
    const first = await request(port, "GET", "/mcp");
    const second = await request(port, "GET", "/mcp");

    expect(first.status, `${ISSUE}: first invalid request consumes the rate bucket`).toBe(405);
    expect(second.status, `${ISSUE}: repeated invalid request must be rate limited`).toBe(429);
  });

  it("does not leak credentials, bearer tokens, or request bodies in Node errors or logs", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await startNode({
      B2_HTTP_CREDENTIAL_MODE: "server",
      B2_APPLICATION_KEY_ID: "runtime-app-id",
      B2_APPLICATION_KEY: CANARY_APP_SECRET,
    });

    const response = await request(port, "POST", "/mcp", {
      headers: {
        "x-b2-key-id": "public-id",
        "x-b2-key": CANARY_B2_SECRET,
        authorization: `Bearer ${CANARY_BEARER}`,
        ...modernHeaders("tools/list"),
      },
      body: JSON.stringify({ canary: CANARY_BODY }),
    });

    expect(response.status, `${ISSUE}: public credential headers must fail closed`).toBe(400);
    assertNoSensitiveMaterial(response.body, `${ISSUE}: public credential response`);
    assertNoSensitiveMaterial(JSON.stringify(warn.mock.calls), `${ISSUE}: public credential logs`);
  });

  it("does not let destructive calls bypass confirmation by changing request shape", async () => {
    await startNode({ B2_DESTRUCTIVE_POLICY: "confirm" });
    const s3Send = vi.mocked(S3Client.prototype.send);
    const destructiveBody = destructiveCallBody(
      "s3_delete_object",
      { bucket: "photos", key: "delete-me.jpg", confirm: true },
      1,
    );

    const elicitationRequired = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "s3_delete_object") },
      body: destructiveBody,
    });
    const mismatch = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: destructiveBody,
    });

    expect(elicitationRequired.status, `${ISSUE}: destructive call should remain gated`).toBe(200);
    expect(parseJson(elicitationRequired.body).result?.resultType).toBe("input_required");
    expect(
      mismatch.status,
      `${ISSUE}: header/body shape changes must not bypass destructive gating`,
    ).toBe(400);
    expect(
      s3Send,
      `${ISSUE}: no destructive SDK command should run before approval`,
    ).not.toHaveBeenCalled();
  });
});
