import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const SIGNAL = "B2_MCP_LOCAL_NETWORK_GUARD_BLOCKED";

function normalizedHost(host) {
  return String(host ?? "localhost")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function isLocalHost(host) {
  const normalized = normalizedHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function block(kind, host) {
  const label = normalizedHost(host);
  process.stderr.write(`${SIGNAL}:${kind}:${label}\n`);
  throw new Error(`Non-local network access blocked during performance baseline: ${kind}`);
}

function assertLocal(kind, host) {
  if (!isLocalHost(host)) block(kind, host);
}

function urlHost(value) {
  if (value instanceof URL) return value.hostname;
  if (typeof Request !== "undefined" && value instanceof Request) {
    return new URL(value.url).hostname;
  }
  if (typeof value === "string") return new URL(value).hostname;
  return undefined;
}

function requestHost(args) {
  const [first, second] = args;
  const directUrlHost = urlHost(first);
  if (directUrlHost) return directUrlHost;
  if (first && typeof first === "object") {
    return first.hostname ?? first.host ?? "localhost";
  }
  if (second && typeof second === "object") {
    return second.hostname ?? second.host ?? "localhost";
  }
  if (typeof second === "string") return second;
  return "localhost";
}

function socketHost(args) {
  const [first, second] = args;
  if (first && typeof first === "object") {
    if (first.path) return "localhost";
    return first.host ?? first.hostname ?? "localhost";
  }
  if (second && typeof second === "object") {
    if (second.path) return "localhost";
    return second.host ?? second.hostname ?? "localhost";
  }
  if (typeof second === "string") return second;
  return "localhost";
}

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = (input, init) => {
    assertLocal("fetch", urlHost(input) ?? "localhost");
    return originalFetch(input, init);
  };
}

for (const [moduleName, module] of [
  ["http", http],
  ["https", https],
]) {
  const originalRequest = module.request;
  const originalGet = module.get;
  module.request = function guardedRequest(...args) {
    assertLocal(`${moduleName}.request`, requestHost(args));
    return originalRequest.apply(this, args);
  };
  module.get = function guardedGet(...args) {
    assertLocal(`${moduleName}.get`, requestHost(args));
    return originalGet.apply(this, args);
  };
}

const originalNetConnect = net.connect;
const originalNetCreateConnection = net.createConnection;
net.connect = function guardedNetConnect(...args) {
  assertLocal("net.connect", socketHost(args));
  return originalNetConnect.apply(this, args);
};
net.createConnection = function guardedNetCreateConnection(...args) {
  assertLocal("net.createConnection", socketHost(args));
  return originalNetCreateConnection.apply(this, args);
};

const originalTlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
  assertLocal("tls.connect", socketHost(args));
  return originalTlsConnect.apply(this, args);
};
