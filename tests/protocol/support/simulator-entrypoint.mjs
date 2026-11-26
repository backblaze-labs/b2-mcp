#!/usr/bin/env node

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { B2Client: SdkB2Client } = require("@backblaze-labs/b2-sdk");
const { S3Client } = require("@aws-sdk/client-s3");
const { createMcpHttpTransport, setB2SdkClientFactoryForTests } = require("../../../dist/auth.js");
const { resolveSimulatorServeScript, startStandaloneSimulator } = await import(
  "../../../test-support/standalone-simulator.mjs"
);

// Fail at start, with the discovery message on stderr, when B2_SIMULATOR_DIR
// does not name a b2-simulator checkout.
resolveSimulatorServeScript();

const API_TIMEOUT_MS = 30_000;
const READ_ONLY_CAPABILITIES = ["listBuckets", "listFiles", "readFiles"];
// Capability set of the committed `read-only` tool profile
// (src/tool-contract.ts PROFILE_CAPABILITIES["read-only"]).
const READ_ONLY_PROFILE_CAPABILITIES = [
  "listBuckets",
  "listFiles",
  "listKeys",
  "readBucketNotifications",
  "readFiles",
];

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
        if (applicationKeyId.includes("read-only-profile")) {
          storageApi.allowed.capabilities = READ_ONLY_PROFILE_CAPABILITIES;
        }
      }
      return new JsonResponse(response.status, body, Object.fromEntries(response.headers ?? []));
    },
  };
}

// One standalone simulator per credential pair, started on first use, as the
// SDK's in-process simulators were: each pair sees its own empty store. Each
// server exits with this process (test-support/exit-with-owner.mjs).
const simulators = new Map();

function simulatorTransport(cacheKey) {
  return {
    async send(request) {
      let simulator = simulators.get(cacheKey);
      if (!simulator) {
        simulator = startStandaloneSimulator({
          extraArgs: ["--min-part-size", "1024", "--recommended-part-size", "1024"],
        }).then((started) => started.transport());
        simulators.set(cacheKey, simulator);
      }
      return (await simulator).send(request);
    },
  };
}

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
      transport: createMcpHttpTransport(
        credentialScopedTransport(simulatorTransport(cacheKey)),
        retry,
      ),
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
