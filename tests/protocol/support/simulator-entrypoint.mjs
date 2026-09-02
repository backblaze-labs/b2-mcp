#!/usr/bin/env node

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { B2Client: SdkB2Client } = require("@backblaze-labs/b2-sdk");
const { B2Simulator } = require("@backblaze-labs/b2-sdk/simulator");
const { S3Client } = require("@aws-sdk/client-s3");
const { createMcpHttpTransport, setB2SdkClientFactoryForTests } = require("../../../dist/auth.js");

const API_TIMEOUT_MS = 30_000;
const READ_ONLY_CAPABILITIES = ["listBuckets", "listFiles", "readFiles"];

class JsonResponse {
  body = null;

  constructor(status, payload, headers = {}) {
    this.status = status;
    this.payload = payload;
    this.headers = new Headers(headers);
  }

  async json() {
    return this.payload;
  }

  async text() {
    return typeof this.payload === "string" ? this.payload : JSON.stringify(this.payload);
  }

  async arrayBuffer() {
    return new TextEncoder().encode(await this.text()).buffer;
  }
}

function applicationKeyIdFromBasicAuth(value) {
  if (typeof value !== "string" || !value.startsWith("Basic ")) return "";
  const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? decoded : decoded.slice(0, separator);
}

function credentialScopedTransport(inner) {
  return {
    async send(request) {
      const response = await inner.send(request);
      if (!request.url.includes("b2_authorize_account")) return response;
      const body = await response.json();
      const storageApi = body?.apiInfo?.storageApi;
      if (storageApi) {
        // The simulator returns the API host as s3ApiUrl; the server now rejects
        // an authorized S3 endpoint outside the trusted B2 host set instead of
        // masking it with the configured-region fallback. Hand it a realistic
        // s3.<region>.backblazeb2.com URL so the S3 client builds as in production.
        storageApi.s3ApiUrl = "https://s3.us-west-004.backblazeb2.com";
        const applicationKeyId = applicationKeyIdFromBasicAuth(request.headers?.Authorization);
        if (applicationKeyId.includes("invalid")) {
          return new JsonResponse(
            401,
            { status: 401, code: "unauthorized", message: "denied" },
            Object.fromEntries(response.headers ?? []),
          );
        }
        if (applicationKeyId.includes("other")) {
          storageApi.allowed.capabilities = READ_ONLY_CAPABILITIES;
        }
      }
      return new JsonResponse(response.status, body, Object.fromEntries(response.headers ?? []));
    },
  };
}

const simulators = new Map();

S3Client.prototype.send = async (command, options = {}) => {
  if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error("aborted");
  switch (command?.constructor?.name) {
    case "ListObjectsV2Command":
      return {
        Contents: [],
        CommonPrefixes: [],
        IsTruncated: false,
        KeyCount: 0,
      };
    case "ListObjectVersionsCommand":
      return {
        Versions: [],
        DeleteMarkers: [],
        CommonPrefixes: [],
        IsTruncated: false,
      };
    case "GetBucketLocationCommand":
      return { LocationConstraint: "us-west-004" };
    default:
      return {};
  }
};

setB2SdkClientFactoryForTests((config) => {
  const cacheKey = `${config.applicationKeyId}\0${config.applicationKey}`;
  let simulator = simulators.get(cacheKey);
  if (!simulator) {
    simulator = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 });
    simulators.set(cacheKey, simulator);
  }
  const retry = {
    maxRetries: 0,
    initialRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    requestTimeoutMs: API_TIMEOUT_MS,
  };
  return {
    client: new SdkB2Client({
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      transport: createMcpHttpTransport(credentialScopedTransport(simulator.transport()), retry),
      retry,
    }),
  };
});

const mode = process.argv[2];
if (mode === "stdio") {
  const { startStdio } = require("../../../dist/index.js");
  await startStdio();
} else if (mode === "http") {
  const { buildHttpServer, getPort } = require("../../../dist/http-server.js");
  const port = getPort();
  const { server, drain } = buildHttpServer();
  server.listen(port);
  const shutdown = () => {
    drain();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  throw new Error(`Unknown protocol simulator entrypoint mode: ${mode}`);
}
