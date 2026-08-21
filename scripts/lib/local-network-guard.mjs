import { createRequire, syncBuiltinESMExports } from "node:module";

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

function isLoopbackIpv4(host) {
  return net.isIP(host) === 4 && host.split(".")[0] === "127";
}

function isMappedLoopbackIpv4(host) {
  const mapped = host.match(/^::ffff:(?<ipv4>.+)$/u)?.groups?.ipv4;
  return mapped ? isLoopbackIpv4(mapped) : false;
}

function isLocalHost(host) {
  const normalized = normalizedHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    isLoopbackIpv4(normalized) ||
    isMappedLoopbackIpv4(normalized)
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

function assertNoCustomLookup(kind, args) {
  for (const value of args) {
    if (value && typeof value === "object" && typeof value.lookup === "function") {
      block(kind, "custom-lookup");
    }
  }
}

function urlHost(value) {
  if (value instanceof URL) return value.hostname;
  if (typeof Request !== "undefined" && value instanceof Request) {
    return new URL(value.url).hostname;
  }
  if (typeof value === "string") return new URL(value).hostname;
  return undefined;
}

function explicitRequestOptionsHost(value) {
  if (!value || typeof value !== "object") return undefined;
  return value.hostname ?? value.host;
}

function requestHost(args) {
  const [first, second] = args;
  const optionOverrideHost = explicitRequestOptionsHost(second);
  if (optionOverrideHost) return optionOverrideHost;
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
    assertNoCustomLookup(`${moduleName}.request`, args);
    assertLocal(`${moduleName}.request`, requestHost(args));
    return originalRequest.apply(this, args);
  };
  module.get = function guardedGet(...args) {
    assertNoCustomLookup(`${moduleName}.get`, args);
    assertLocal(`${moduleName}.get`, requestHost(args));
    return originalGet.apply(this, args);
  };
}

const originalNetConnect = net.connect;
const originalNetCreateConnection = net.createConnection;
const originalNetSocketConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;
const originalTlsSocketConnect = tls.TLSSocket.prototype.connect;
net.connect = function guardedNetConnect(...args) {
  assertNoCustomLookup("net.connect", args);
  assertLocal("net.connect", socketHost(args));
  return originalNetConnect.apply(this, args);
};
net.createConnection = function guardedNetCreateConnection(...args) {
  assertNoCustomLookup("net.createConnection", args);
  assertLocal("net.createConnection", socketHost(args));
  return originalNetCreateConnection.apply(this, args);
};
net.Socket.prototype.connect = function guardedNetSocketConnect(...args) {
  assertNoCustomLookup("net.Socket.connect", args);
  assertLocal("net.Socket.connect", socketHost(args));
  return originalNetSocketConnect.apply(this, args);
};

tls.connect = function guardedTlsConnect(...args) {
  assertNoCustomLookup("tls.connect", args);
  assertLocal("tls.connect", socketHost(args));
  return originalTlsConnect.apply(this, args);
};
tls.TLSSocket.prototype.connect = function guardedTlsSocketConnect(...args) {
  assertNoCustomLookup("tls.TLSSocket.connect", args);
  assertLocal("tls.TLSSocket.connect", socketHost(args));
  return originalTlsSocketConnect.apply(this, args);
};

syncBuiltinESMExports();
