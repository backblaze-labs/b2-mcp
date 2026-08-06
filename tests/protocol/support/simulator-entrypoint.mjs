#!/usr/bin/env node

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { B2Client: SdkB2Client } = require("@backblaze-labs/b2-sdk");
const { B2Simulator } = require("@backblaze-labs/b2-sdk/simulator");
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
      const applicationKeyId = applicationKeyIdFromBasicAuth(request.headers?.Authorization);
      if (applicationKeyId.includes("other")) {
        body.apiInfo.storageApi.allowed.capabilities = READ_ONLY_CAPABILITIES;
      }
      return new JsonResponse(response.status, body, Object.fromEntries(response.headers ?? []));
    },
  };
}

const simulators = new Map();

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
