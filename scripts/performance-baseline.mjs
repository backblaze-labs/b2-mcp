#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { sanitizedEnv } = require("./lib/sanitized-env.cjs");
const {
  budgetLimit,
  createArtifact,
  displayValue,
  evaluateMeasurements,
  renderSummary,
  round,
} = require("./lib/performance-baseline.cjs");

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));
const configPath = path.join(root, "performance-baseline.json");
const reportsDir = path.join(root, "reports", "performance");
const artifactPath = path.join(reportsDir, "local-baseline.json");
const summaryPath = path.join(reportsDir, "local-baseline-summary.md");
const localNetworkGuardPath = path.join(root, "scripts/lib/local-network-guard.mjs");
const noNetworkGuardPath = path.join(root, "scripts/no-network-guard.mjs");
const workerEnvFlag = "B2_MCP_PERFORMANCE_BASELINE_WORKER";
const probeOnlyFlag = "B2_MCP_PERFORMANCE_BASELINE_PROBE_ONLY";
const forceFailurePhaseFlag = "B2_MCP_PERFORMANCE_BASELINE_FORCE_FAILURE_PHASE";
const forceBudgetViolationFlag = "B2_MCP_PERFORMANCE_BASELINE_FORCE_BUDGET_VIOLATION";
const parentSecretSentinel = "sentinel-parent-secret";
const workerTimeoutMs = 120_000;

const benchmarkWorkerEnv = {
  B2_ALLOWED_HOSTS: "",
  B2_ALLOWED_ORIGINS: "",
  B2_APPLICATION_KEY_ID: "performance-key-id",
  B2_APPLICATION_KEY: "performance-key-secret",
  B2_CAPABILITY_CACHE_TTL_MS: "0",
  B2_MAX_SESSIONS: "1000",
  B2_MAX_SESSIONS_PER_KEY: "1000",
  B2_MCP_RATE_LIMIT_BURST: "1000",
  B2_MCP_RATE_LIMIT_RPS: "1000",
  B2_REGISTER_ALL_TOOLS: "true",
  B2_SECRET_SINK: "off",
  LOG_LEVEL: "fatal",
  NODE_ENV: "test",
  NODE_OPTIONS: `--import ${pathToFileURL(localNetworkGuardPath).href}`,
  [workerEnvFlag]: "1",
};

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function usage() {
  return [
    "Usage: node --expose-gc scripts/performance-baseline.mjs [--enforce]",
    "",
    "Runs the advisory local performance baseline for issue #199.",
    "Artifacts:",
    `  ${path.relative(root, artifactPath)}`,
    `  ${path.relative(root, summaryPath)}`,
    "",
    "Options:",
    "  --advisory  Record failures but exit zero (default).",
    "  --enforce   Exit nonzero when a budget is exceeded.",
    "  --help      Show this help text.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    return {
      help: true,
      enforce: false,
      worker: false,
      selfTestEnvSanitizer: false,
      selfTestMeasurementFailure: false,
      selfTestBudgetViolation: false,
    };
  }
  const worker = args.has("--worker");
  const selfTestEnvSanitizer = args.has("--self-test-env-sanitizer");
  const selfTestMeasurementFailure = args.has("--self-test-measurement-failure");
  const selfTestBudgetViolation = args.has("--self-test-budget-violation");
  const allowed = new Set([
    "--advisory",
    "--enforce",
    "--worker",
    "--self-test-env-sanitizer",
    "--self-test-measurement-failure",
    "--self-test-budget-violation",
  ]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  return {
    help: false,
    enforce: args.has("--enforce"),
    worker,
    selfTestEnvSanitizer,
    selfTestMeasurementFailure,
    selfTestBudgetViolation,
  };
}

function assertBuiltArtifacts() {
  const missing = [
    "dist/index.js",
    "dist/http-server.js",
    "dist/oauth-resource-server.js",
    "dist/tool-contract.js",
  ].filter((relativePath) => !existsSync(path.join(root, relativePath)));
  if (missing.length > 0) {
    throw new Error(
      `Missing built artifact(s): ${missing.join(
        ", ",
      )}. Run pnpm run build before the performance baseline.`,
    );
  }
}

function createWorkerEnv(extra = {}, sourceEnv = process.env) {
  const merged = {
    ...benchmarkWorkerEnv,
    ...extra,
  };
  return sanitizedEnv(merged, {
    sourceEnv,
    nonSecretEnvNames: Object.keys(merged),
  });
}

function fakeServerEnv() {
  const extra = {
    B2_APPLICATION_KEY_ID: "performance-key-id",
    B2_APPLICATION_KEY: "performance-key-secret",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_SECRET_SINK: "off",
    LOG_LEVEL: "fatal",
    NODE_ENV: "test",
    NODE_OPTIONS: `--import ${pathToFileURL(noNetworkGuardPath).href}`,
  };
  return sanitizedEnv(extra, {
    sourceEnv: process.env,
    nonSecretEnvNames: Object.keys(extra),
  });
}

function jsonHeaders(mcpRevision) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": mcpRevision,
  };
}

async function measureStdioStartup(mcpRevision) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: root,
    env: fakeServerEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4096);
  });
  const client = new Client(
    { name: "b2-mcp-performance-baseline", version: "1.0.0" },
    {
      versionNegotiation: { mode: { pin: mcpRevision } },
      defaultCacheTtlMs: 0,
    },
  );
  const started = performance.now();
  let elapsed;
  try {
    await client.connect(transport, { timeoutMs: 10_000 });
    elapsed = performance.now() - started;
    const server = client.getServerVersion();
    if (server?.name !== "backblaze-b2") {
      throw new Error(`Unexpected stdio server name: ${server?.name ?? "missing"}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  if (stderr.includes("MCP_CLIENT_SMOKE_NETWORK_BLOCKED")) {
    throw new Error("Local stdio startup attempted network access under the no-network guard.");
  }
  return { id: "node-stdio.startupReadyMs", value: elapsed };
}

function loadDistModules() {
  return {
    httpServer: require(path.join(root, "dist/http-server.js")),
    oauth: require(path.join(root, "dist/oauth-resource-server.js")),
    toolContract: require(path.join(root, "dist/tool-contract.js")),
  };
}

function profileProvider(profile, contractTestConfig) {
  return {
    name: `performance-${profile}`,
    validateConfiguration() {
      return undefined;
    },
    resolve() {
      return {
        config: {
          ...contractTestConfig,
          applicationKeyId: `performance-${profile}-key-id`,
          applicationKey: `performance-${profile}-key-secret`,
          appKeyId: `performance-${profile}-key-id`,
          appKey: `performance-${profile}-key-secret`,
          masterKeyId: `performance-${profile}-key-id`,
          masterKey: `performance-${profile}-key-secret`,
        },
        cacheKey: `performance:${profile}`,
        capabilityCacheKey: `performance:${profile}`,
      };
    },
  };
}

async function listen(handle) {
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      handle.server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      handle.server.off("error", onError);
      resolve();
    };
    handle.server.once("error", onError);
    handle.server.once("listening", onListening);
    handle.server.listen(0, "127.0.0.1");
  });
  const address = handle.server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP benchmark server did not bind");
  return address.port;
}

async function closeHandle(handle) {
  handle.drain();
  await new Promise((resolve) => handle.server.close(() => resolve()));
  await new Promise((resolve) => setImmediate(resolve));
}

async function withProfileServer(profile, modules, contract, run) {
  const handle = modules.httpServer.buildHttpServer({
    credentialProvider: profileProvider(profile, modules.toolContract.CONTRACT_TEST_CONFIG),
    fetchCapabilities: async () => contract.profiles[profile].capabilities,
    idleSweepMode: "request",
  });
  const port = await listen(handle);
  try {
    return await run(port);
  } finally {
    await closeHandle(handle);
  }
}

function modernBody(method, mcpRevision, params = {}, id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": mcpRevision,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "b2-mcp-performance-baseline",
          version: "1.0.0",
        },
      },
    },
  });
}

async function rawMcpRequest(port, method, id, mcpRevision) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...jsonHeaders(mcpRevision),
      "mcp-method": method,
    },
    body: modernBody(method, mcpRevision, {}, id),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error) {
    throw new Error(`${method} returned JSON-RPC error: ${parsed.error.message}`);
  }
  return { text, result: parsed.result };
}

async function measureToolsList(profile, modules, contract, mcpRevision) {
  return withProfileServer(profile, modules, contract, async (port) => {
    const started = performance.now();
    const response = await rawMcpRequest(port, "tools/list", 1, mcpRevision);
    const elapsed = performance.now() - started;
    const bytes = Buffer.byteLength(response.text, "utf8");
    const expectedCount = contract.profiles[profile].counts.total;
    const actualCount = response.result?.tools?.length;
    if (actualCount !== expectedCount) {
      throw new Error(
        `tools/list for ${profile} returned ${actualCount ?? "unknown"} tools, expected ${expectedCount}`,
      );
    }
    return [
      { id: `node-http.${profile}.toolsListMs`, value: elapsed },
      { id: `node-http.${profile}.toolsListBytes`, value: bytes },
    ];
  });
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function measureConcurrentDiscovery(modules, contract, concurrency, mcpRevision) {
  return withProfileServer("full", modules, contract, async (port) => {
    const ids = Array.from({ length: concurrency }, (_, index) => index + 1);
    const started = performance.now();
    const latencies = await Promise.all(
      ids.map(async (id) => {
        const requestStarted = performance.now();
        const response = await rawMcpRequest(port, "server/discover", id, mcpRevision);
        if (!response.result?.supportedVersions?.includes(mcpRevision)) {
          throw new Error("server/discover did not advertise the target MCP revision");
        }
        return performance.now() - requestStarted;
      }),
    );
    const totalMs = performance.now() - started;
    return [
      {
        id: "node-http.discovery.concurrentP95Ms",
        value: percentile(latencies, 95),
      },
      {
        id: "node-http.discovery.throughputRps",
        value: (concurrency / totalMs) * 1000,
      },
    ];
  });
}

async function measureMemoryGrowth(modules, contract, requestCount, mcpRevision) {
  return withProfileServer("full", modules, contract, async (port) => {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < requestCount; index++) {
      await rawMcpRequest(port, "tools/list", index + 1, mcpRevision);
    }
    globalThis.gc?.();
    const after = process.memoryUsage().heapUsed;
    return {
      id: "node-http.memory.repeatedToolsListGrowthMiB",
      value: Math.max(0, after - before) / 1024 / 1024,
      details: {
        requestCount,
        gcAvailable: typeof globalThis.gc === "function",
        heapBeforeMiB: round(before / 1024 / 1024),
        heapAfterMiB: round(after / 1024 / 1024),
      },
    };
  });
}

function oauthConfig() {
  const issuer = "http://localhost:9000";
  const resource = "http://localhost:9000/mcp";
  return {
    issuer,
    resource,
    audience: resource,
    publicUrl: resource,
    authorizationEndpoint: `${issuer}/oauth2/authorize`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    requiredScopes: ["b2:read"],
    allowedSubjects: ["performance-subject"],
    allowedTokenTypes: ["bearer"],
    allowedAlgorithms: ["RS256"],
    allowedJwtAlgorithms: ["RS256"],
    allowedJwtTypes: ["at+jwt"],
    dangerouslyAllowInsecureIssuerUrl: true,
    dangerouslyAllowUnauthenticatedIntrospection: false,
    tokenCacheMaxEntries: 1000,
    tokenCacheTtlSeconds: 300,
    tokenCacheSkewSeconds: 30,
    jwksUri: `${issuer}/oauth2/jwks`,
    jwksCacheTtlSeconds: 300,
    jwksCacheMinTtlSeconds: 30,
    jwksTimeoutMs: 1000,
    jwksMaxRetries: 0,
    jwksRetryDelayMs: 0,
    jwksCircuitFailures: 5,
    jwksCircuitOpenMs: 30000,
    jwksRefreshCooldownMs: 30000,
    jwtClockSkewSeconds: 60,
  };
}

async function signToken(privateKey, jti, nowSeconds, config) {
  const { SignJWT } = await import("jose");
  return new SignJWT({
    aud: config.audience,
    resource: config.resource,
    scope: "b2:read",
    token_type: "bearer",
    jti,
  })
    .setProtectedHeader({ alg: "RS256", kid: "performance-key", typ: "at+jwt" })
    .setIssuer(config.issuer)
    .setSubject("performance-subject")
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds - 1)
    .setExpirationTime(nowSeconds + 300)
    .sign(privateKey);
}

async function assertOAuthSuccess(result) {
  if (!(result instanceof Response)) return result;
  const text = await result.text();
  throw new Error(`OAuth fake-path verification returned HTTP ${result.status}: ${text}`);
}

async function measureOAuthJwks(modules) {
  const { exportJWK, generateKeyPair } = await import("jose");
  const config = oauthConfig();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: "performance-key",
    alg: "RS256",
    use: "sig",
  };
  const tokens = await Promise.all([
    signToken(privateKey, "cold", nowSeconds, config),
    signToken(privateKey, "warm", nowSeconds, config),
  ]);
  let jwksFetches = 0;
  const fetchImpl = async (url) => {
    if (String(url) !== config.jwksUri) {
      throw new Error(`Unexpected OAuth benchmark fetch URL: ${url}`);
    }
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "max-age=60",
      },
    });
  };
  const requestFor = (token) =>
    new Request("http://localhost:9000/mcp", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

  modules.oauth.resetOAuthVerifierCacheForTests();
  const coldStarted = performance.now();
  await assertOAuthSuccess(
    await modules.oauth.authenticateOAuthRequest(requestFor(tokens[0]), config, {
      fetch: fetchImpl,
      nowSeconds: () => nowSeconds,
    }),
  );
  const coldMs = performance.now() - coldStarted;

  const warmStarted = performance.now();
  await assertOAuthSuccess(
    await modules.oauth.authenticateOAuthRequest(requestFor(tokens[1]), config, {
      fetch: fetchImpl,
      nowSeconds: () => nowSeconds,
    }),
  );
  const warmMs = performance.now() - warmStarted;
  if (jwksFetches !== 1) {
    throw new Error(`Expected one JWKS fetch across cold/warm checks, observed ${jwksFetches}`);
  }
  return [
    { id: "oauth-jwks.coldVerifyMs", value: coldMs, details: { jwksFetches: 1 } },
    { id: "oauth-jwks.warmVerifyMs", value: warmMs, details: { jwksFetches: 0 } },
  ];
}

function serializeError(error, phase, partialMeasurements) {
  return {
    phase,
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    ...(partialMeasurements && {
      partialMetricIds: partialMeasurements.map((metric) => metric.id),
    }),
  };
}

async function recordPhase(measurements, phase, run) {
  try {
    const result = await run();
    const entries = Array.isArray(result) ? result : [result];
    measurements.push(...entries);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.name = error instanceof Error ? error.name : "Error";
    wrapped.phase = phase;
    wrapped.partialMeasurements = [...measurements];
    throw wrapped;
  }
}

async function runMeasurements(config) {
  if (process.env[forceBudgetViolationFlag] === "1") {
    return syntheticBudgetViolationMeasurements(config);
  }
  if (process.env[forceFailurePhaseFlag]) {
    const error = new Error("Forced measurement failure for performance artifact self-test.");
    error.phase = process.env[forceFailurePhaseFlag];
    error.partialMeasurements = [];
    throw error;
  }
  assertBuiltArtifacts();
  const contract = readJson(path.join(root, "docs/tool-profile-contract.json"));
  const mcpRevision = contract.mcpRevision;
  const modules = loadDistModules();
  const measurements = [];

  try {
    await recordPhase(measurements, "node-stdio.startupReadyMs", () =>
      measureStdioStartup(mcpRevision),
    );
    for (const profile of config.reviewedBaseline.toolProfiles) {
      await recordPhase(measurements, `node-http.${profile}.toolsList`, () =>
        measureToolsList(profile, modules, contract, mcpRevision),
      );
    }
    await recordPhase(measurements, "node-http.discovery", () =>
      measureConcurrentDiscovery(
        modules,
        contract,
        config.measurementPlan.modestConcurrency,
        mcpRevision,
      ),
    );
    await recordPhase(measurements, "node-http.memory.repeatedToolsListGrowthMiB", () =>
      measureMemoryGrowth(
        modules,
        contract,
        config.measurementPlan.memoryRequestCount,
        mcpRevision,
      ),
    );
    await recordPhase(measurements, "oauth-jwks", () => measureOAuthJwks(modules));
  } finally {
    modules.oauth.resetOAuthVerifierCacheForTests();
  }
  return measurements;
}

function syntheticBudgetViolationMeasurements(config) {
  const maxViolationId = "node-http.full.toolsListBytes";
  const minViolationId = "node-http.discovery.throughputRps";
  return Object.entries(config.budgets).map(([id, budget]) => {
    const displayedLimit = displayValue(budgetLimit(budget), budget.unit);
    if (id === maxViolationId) {
      return { id, value: displayedLimit + (budget.unit === "bytes" ? 1 : 0.01) };
    }
    if (id === minViolationId) {
      return { id, value: displayedLimit - (budget.unit === "bytes" ? 1 : 0.01) };
    }
    return { id, value: budget.baseline };
  });
}

async function runEnvProbe() {
  const { SignJWT } = await import("jose");
  const http = require("node:http");
  const net = require("node:net");
  const tls = require("node:tls");
  const { connect: esmNetConnect, Socket: EsmSocket } = await import("node:net");
  const stdioEnv = fakeServerEnv();
  const observedSentinelNames = Object.entries(process.env)
    .filter(([, value]) => String(value).includes(parentSecretSentinel))
    .map(([name]) => name)
    .sort();
  const isBlocked = (error) =>
    /Non-local network access blocked/.test(error instanceof Error ? error.message : String(error));
  const blockedNetworkCall = (call) => {
    try {
      const handle = call();
      handle?.destroy?.();
      return false;
    } catch (error) {
      return isBlocked(error);
    }
  };
  let nonLocalFetchBlocked = false;
  try {
    await fetch("https://example.com");
  } catch (error) {
    nonLocalFetchBlocked = isBlocked(error);
  }
  const requestOptionsOverrideBlocked = blockedNetworkCall(() =>
    http.request("http://127.0.0.1", { hostname: "example.com" }),
  );
  const netSocketConnectBlocked = blockedNetworkCall(() =>
    new net.Socket().connect({ host: "example.com", port: 443 }),
  );
  const tlsSocketConnectBlocked = blockedNetworkCall(() =>
    new tls.TLSSocket(new net.Socket()).connect({ host: "example.com", port: 443 }),
  );
  const esmNetConnectBlocked = blockedNetworkCall(() =>
    esmNetConnect({ host: "example.com", port: 443 }),
  );
  const esmSocketConnectBlocked = blockedNetworkCall(() =>
    new EsmSocket().connect({ host: "example.com", port: 443 }),
  );
  const malformedLoopbackBlocked = blockedNetworkCall(() =>
    new net.Socket().connect({ host: "127.999.999.999", port: 443 }),
  );
  const zeroPaddedLoopbackBlocked = blockedNetworkCall(() =>
    new net.Socket().connect({ host: "127.000.000.001", port: 443 }),
  );
  const customLookupBlocked = blockedNetworkCall(() =>
    net.connect({
      host: "localhost",
      port: 443,
      lookup: (_host, _options, callback) => callback(null, "1.1.1.1", 4),
    }),
  );
  const stdioGuardProbe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import net, { connect, Socket } from "node:net";',
        'import tls from "node:tls";',
        "const blocked = (call) => {",
        "  try {",
        "    const handle = call();",
        "    handle?.destroy?.();",
        "    return false;",
        "  } catch {",
        "    return true;",
        "  }",
        "};",
        "const results = {",
        '  netSocket: blocked(() => new net.Socket().connect({ host: "example.com", port: 443 })),',
        '  tlsSocket: blocked(() => new tls.TLSSocket(new net.Socket()).connect({ host: "example.com", port: 443 })),',
        '  esmConnect: blocked(() => connect({ host: "example.com", port: 443 })),',
        '  esmSocket: blocked(() => new Socket().connect({ host: "example.com", port: 443 })),',
        "};",
        "console.log(JSON.stringify(results));",
        "process.exitCode = Object.values(results).every(Boolean) ? 0 : 1;",
      ].join("\n"),
    ],
    {
      cwd: root,
      env: stdioEnv,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const stdioGuardProbeBlocked =
    stdioGuardProbe.status === 0 &&
    Object.values(JSON.parse(stdioGuardProbe.stdout.trim().split(/\r?\n/).at(-1) ?? "{}")).every(
      Boolean,
    );
  return {
    importedDependency: typeof SignJWT === "function",
    observedSentinelNames,
    sentinelValueVisible: observedSentinelNames.length > 0,
    benchmarkCredentialIsFake: process.env.B2_APPLICATION_KEY === "performance-key-secret",
    benchmarkSecretSinkIsOff: process.env.B2_SECRET_SINK === "off",
    stdioSecretSinkIsOff: stdioEnv.B2_SECRET_SINK === "off",
    stdioSecretSinkFileUnset: stdioEnv.B2_SECRET_SINK_FILE === undefined,
    nonLocalFetchBlocked,
    requestOptionsOverrideBlocked,
    netSocketConnectBlocked,
    tlsSocketConnectBlocked,
    esmNetConnectBlocked,
    esmSocketConnectBlocked,
    malformedLoopbackBlocked,
    zeroPaddedLoopbackBlocked,
    customLookupBlocked,
    stdioGuardProbeBlocked,
  };
}

async function workerMain() {
  if (process.env[probeOnlyFlag] === "1") {
    return { ok: true, probe: await runEnvProbe() };
  }
  const config = readJson(configPath);
  try {
    return { ok: true, measurements: await runMeasurements(config) };
  } catch (error) {
    return {
      ok: false,
      error: serializeError(error, error?.phase ?? "measurement", error?.partialMeasurements),
      partialMeasurements: error?.partialMeasurements ?? [],
    };
  }
}

function parseWorkerPayload(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("Performance worker wrote no JSON payload.");
  return JSON.parse(line);
}

function runWorkerProcess(extraEnv = {}) {
  const result = spawnSync(process.execPath, ["--expose-gc", scriptPath, "--worker"], {
    cwd: root,
    env: createWorkerEnv(extraEnv),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: workerTimeoutMs,
  });
  let payload = null;
  try {
    payload = result.stdout ? parseWorkerPayload(result.stdout) : null;
  } catch {
    payload = null;
  }
  if (result.error) {
    return {
      ok: false,
      error: {
        phase: "worker",
        message:
          result.error.code === "ETIMEDOUT"
            ? `Performance worker timed out after ${workerTimeoutMs} ms`
            : result.error.message,
        name: result.error.name,
      },
      partialMeasurements: payload?.partialMeasurements ?? [],
    };
  }
  if (payload?.ok === true && result.status === 0) return payload;
  return {
    ok: false,
    error: payload?.error ?? {
      phase: "worker",
      message:
        result.stderr?.trim().split(/\r?\n/).at(-1) ||
        `Performance worker exited with status ${result.status ?? "unknown"}`,
      name: "WorkerError",
    },
    partialMeasurements: payload?.partialMeasurements ?? [],
  };
}

function writeReports(config, metrics, measurements, enforce, failure = null) {
  mkdirSync(reportsDir, { recursive: true });
  rmSync(artifactPath, { force: true });
  rmSync(summaryPath, { force: true });
  const summary = renderSummary(config, metrics, { enforce, failure });
  const artifact = createArtifact({
    config,
    metrics,
    measurements,
    enforce,
    failure,
  });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(summaryPath, summary);
  return { artifact, summary };
}

function runSelfTestEnvSanitizer() {
  const payload = runWorkerProcess({ [probeOnlyFlag]: "1" });
  if (!payload.ok) {
    console.error(payload.error?.message ?? "Environment sanitizer self-test failed");
    return 1;
  }
  console.log(JSON.stringify(payload.probe));
  return payload.probe.sentinelValueVisible ||
    !payload.probe.nonLocalFetchBlocked ||
    !payload.probe.requestOptionsOverrideBlocked ||
    !payload.probe.netSocketConnectBlocked ||
    !payload.probe.tlsSocketConnectBlocked ||
    !payload.probe.esmNetConnectBlocked ||
    !payload.probe.esmSocketConnectBlocked ||
    !payload.probe.malformedLoopbackBlocked ||
    !payload.probe.zeroPaddedLoopbackBlocked ||
    !payload.probe.customLookupBlocked ||
    !payload.probe.stdioGuardProbeBlocked
    ? 1
    : 0;
}

function runParent(enforce, workerExtraEnv = {}) {
  const config = readJson(configPath);
  const payload = runWorkerProcess(workerExtraEnv);
  if (!payload.ok) {
    const measurements = payload.partialMeasurements ?? [];
    const metrics = evaluateMeasurements(config, measurements, { requireAll: false });
    const failure = payload.error ?? {
      phase: "worker",
      message: "Performance worker failed before returning an error payload.",
    };
    const { summary } = writeReports(config, metrics, measurements, enforce, failure);
    console.log(summary);
    return enforce ? 1 : 0;
  }

  const measurements = payload.measurements ?? [];
  const metrics = evaluateMeasurements(config, measurements);
  const { artifact, summary } = writeReports(config, metrics, measurements, enforce);
  console.log(summary);
  if (enforce && artifact.violations.length > 0) return 1;
  return 0;
}

function runSelfTestMeasurementFailure() {
  return runParent(true, { [forceFailurePhaseFlag]: "self-test-measurement" });
}

function runSelfTestBudgetViolation() {
  return runParent(true, { [forceBudgetViolationFlag]: "1" });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.worker) {
    if (process.env[workerEnvFlag] !== "1") {
      console.error("Performance baseline worker mode requires a sanitized launcher.");
      return 1;
    }
    const payload = await workerMain();
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return payload.ok ? 0 : 1;
  }
  if (options.selfTestEnvSanitizer) return runSelfTestEnvSanitizer();
  if (options.selfTestMeasurementFailure) return runSelfTestMeasurementFailure();
  if (options.selfTestBudgetViolation) return runSelfTestBudgetViolation();
  return runParent(options.enforce);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
