#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));
const configPath = path.join(root, "performance-baseline.json");
const reportsDir = path.join(root, "reports", "performance");
const artifactPath = path.join(reportsDir, "local-baseline.json");
const summaryPath = path.join(reportsDir, "local-baseline-summary.md");
const mcpRevision = "2026-07-28";
const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": mcpRevision,
};
const benchmarkEnv = {
  B2_ALLOWED_HOSTS: "",
  B2_ALLOWED_ORIGINS: "",
  B2_CAPABILITY_CACHE_TTL_MS: "0",
  B2_MAX_SESSIONS: "1000",
  B2_MAX_SESSIONS_PER_KEY: "1000",
  B2_MCP_RATE_LIMIT_BURST: "1000",
  B2_MCP_RATE_LIMIT_RPS: "1000",
  LOG_LEVEL: "fatal",
};

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function budgetLimit(budget) {
  const percent = Number(budget.tolerance?.percent ?? 0);
  const absolute = Number(budget.tolerance?.absolute ?? 0);
  if (budget.direction === "min") {
    return budget.baseline * (1 - percent / 100) - absolute;
  }
  return budget.baseline * (1 + percent / 100) + absolute;
}

export function evaluateMetric(id, value, budget) {
  const limit = budgetLimit(budget);
  const pass = budget.direction === "min" ? value >= limit : value <= limit;
  return {
    id,
    label: budget.label,
    unit: budget.unit,
    value: budget.unit === "bytes" ? Math.round(value) : round(value),
    status: pass ? "pass" : "fail",
    budget: {
      direction: budget.direction,
      baseline: budget.baseline,
      tolerance: budget.tolerance,
      limit: budget.unit === "bytes" ? Math.round(limit) : round(limit),
    },
  };
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
  if (args.has("--help") || args.has("-h")) return { help: true, enforce: false };
  const unknown = argv.filter((arg) => arg !== "--advisory" && arg !== "--enforce");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  return { help: false, enforce: args.has("--enforce") };
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

function saveBenchmarkEnv() {
  const saved = {};
  for (const key of Object.keys(benchmarkEnv)) saved[key] = process.env[key];
  return saved;
}

function applyBenchmarkEnv() {
  for (const [key, value] of Object.entries(benchmarkEnv)) {
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreBenchmarkEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function safeChildEnv(extra) {
  const inheritedNames = [
    "PATH",
    "Path",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
  ];
  const inherited = Object.fromEntries(
    inheritedNames.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  return {
    ...inherited,
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    ...extra,
  };
}

function fakeServerEnv() {
  return safeChildEnv({
    B2_APPLICATION_KEY_ID: "performance-key-id",
    B2_APPLICATION_KEY: "performance-key-secret",
    B2_REGISTER_ALL_TOOLS: "true",
    NODE_OPTIONS: `--import ${pathToFileURL(path.join(root, "scripts/no-network-guard.mjs")).href}`,
  });
}

async function measureStdioStartup() {
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

function modernBody(method, params = {}, id = 1) {
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

async function rawMcpRequest(port, method, id) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      "mcp-method": method,
    },
    body: modernBody(method, {}, id),
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

async function measureToolsList(profile, modules, contract) {
  return withProfileServer(profile, modules, contract, async (port) => {
    const started = performance.now();
    const response = await rawMcpRequest(port, "tools/list", 1);
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

async function measureConcurrentDiscovery(modules, contract, concurrency) {
  return withProfileServer("full", modules, contract, async (port) => {
    const ids = Array.from({ length: concurrency }, (_, index) => index + 1);
    const started = performance.now();
    const latencies = await Promise.all(
      ids.map(async (id) => {
        const requestStarted = performance.now();
        const response = await rawMcpRequest(port, "server/discover", id);
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

async function measureMemoryGrowth(modules, contract, requestCount) {
  return withProfileServer("full", modules, contract, async (port) => {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < requestCount; index++) {
      await rawMcpRequest(port, "tools/list", index + 1);
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

async function runMeasurements(config) {
  assertBuiltArtifacts();
  const contract = readJson(path.join(root, "docs/tool-profile-contract.json"));
  const measurements = [];
  const saved = saveBenchmarkEnv();
  let modules;
  applyBenchmarkEnv();
  try {
    modules = loadDistModules();
    measurements.push(await measureStdioStartup());
    for (const profile of config.reviewedBaseline.toolProfiles) {
      measurements.push(...(await measureToolsList(profile, modules, contract)));
    }
    measurements.push(
      ...(await measureConcurrentDiscovery(
        modules,
        contract,
        config.measurementPlan.modestConcurrency,
      )),
    );
    measurements.push(
      await measureMemoryGrowth(modules, contract, config.measurementPlan.memoryRequestCount),
    );
    measurements.push(...(await measureOAuthJwks(modules)));
  } finally {
    restoreBenchmarkEnv(saved);
    modules?.oauth.resetOAuthVerifierCacheForTests();
  }
  return measurements;
}

function evaluateMeasurements(config, measurements) {
  const byId = new Map(measurements.map((metric) => [metric.id, metric]));
  return Object.entries(config.budgets).map(([id, budget]) => {
    const measured = byId.get(id);
    if (!measured) throw new Error(`Performance budget ${id} has no measurement.`);
    return {
      ...evaluateMetric(id, measured.value, budget),
      ...(measured.details && { details: measured.details }),
    };
  });
}

function renderSummary(config, metrics, enforce) {
  const failures = metrics.filter((metric) => metric.status !== "pass");
  const mode = enforce ? "enforce" : "advisory";
  const rows = metrics.map((metric) =>
    [
      metric.status === "pass" ? "PASS" : "FAIL",
      metric.id,
      `${metric.value} ${metric.unit}`,
      `${metric.budget.direction} ${metric.budget.limit} ${metric.unit}`,
    ].join(" | "),
  );
  return [
    "# Local Performance Baseline",
    "",
    `Mode: ${mode}`,
    `Issue: #${config.issue.number} ${config.issue.url}`,
    `Status: ${failures.length === 0 ? "pass" : `${failures.length} budget violation(s)`}`,
    "",
    "This local baseline uses fake deterministic fixtures and does not measure live Backblaze B2 latency.",
    "",
    "status | metric | measured | budget",
    "--- | --- | --- | ---",
    ...rows,
    "",
    "Runtime applicability:",
    ...Object.entries(config.runtimeApplicability).map(
      ([runtime, decision]) => `- ${runtime}: ${decision.decision} (${decision.budgetSet})`,
    ),
    "",
  ].join("\n");
}

function writeReports(config, metrics, summary, enforce) {
  mkdirSync(reportsDir, { recursive: true });
  rmSync(artifactPath, { force: true });
  rmSync(summaryPath, { force: true });
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    issue: config.issue,
    mode: enforce ? "enforce" : "advisory",
    advisory: !enforce,
    liveB2CredentialsUsed: false,
    liveB2NetworkMeasured: false,
    node: process.version,
    platform: {
      os: os.platform(),
      arch: os.arch(),
    },
    measurementPlan: config.measurementPlan,
    runtimeApplicability: config.runtimeApplicability,
    metrics,
    violations: metrics.filter((metric) => metric.status !== "pass").map((metric) => metric.id),
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(summaryPath, summary);
  return artifact;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const config = readJson(configPath);
  const measurements = await runMeasurements(config);
  const metrics = evaluateMeasurements(config, measurements);
  const summary = renderSummary(config, metrics, options.enforce);
  const artifact = writeReports(config, metrics, summary, options.enforce);
  console.log(summary);
  if (options.enforce && artifact.violations.length > 0) return 1;
  return 0;
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
