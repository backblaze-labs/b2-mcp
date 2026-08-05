import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const { secretLikeEnvNames } = require("./lib/doc-lint-policy.cjs");

const leakedEnv = secretLikeEnvNames(process.env);
if (leakedEnv.length) {
  throw new Error(
    `Refusing to run doc lint with secret-like environment variables: ${leakedEnv.join(", ")}`,
  );
}

function blocked(name) {
  return function blockedDocLintApi() {
    throw new Error(`doc-lint lockdown blocked ${name}`);
  };
}

function blockMethods(target, names, label) {
  for (const name of names) {
    if (typeof target?.[name] === "function") {
      target[name] = blocked(`${label}.${name}`);
    }
  }
}

// This is a best-effort denylist for Node API surfaces that can perform
// network egress, open listeners, or execute code while ESLint plugins load.
// Keep this list in sync with Node runtime upgrades and extend it whenever a
// new built-in API exposes those capabilities. OS-level network policy remains
// the only complete sandbox boundary.
globalThis.fetch = blocked("fetch network egress");

const net = require("node:net");
net.connect = blocked("net.connect network egress");
net.createConnection = blocked("net.createConnection network egress");
net.createServer = blocked("net.createServer listener");
net.Socket.prototype.connect = blocked("net.Socket.connect network egress");

const tls = require("node:tls");
tls.connect = blocked("tls.connect network egress");
tls.createServer = blocked("tls.createServer listener");
tls.TLSSocket.prototype.connect = blocked("tls.TLSSocket.connect network egress");
tls.TLSSocket = blocked("tls.TLSSocket network egress");

const http = require("node:http");
http.get = blocked("http.get network egress");
http.request = blocked("http.request network egress");
http.createServer = blocked("http.createServer listener");
http.ClientRequest = blocked("http.ClientRequest network egress");
http.Agent.prototype.createConnection = blocked("http.Agent.createConnection network egress");

const https = require("node:https");
https.get = blocked("https.get network egress");
https.request = blocked("https.request network egress");
https.createServer = blocked("https.createServer listener");
https.Agent.prototype.createConnection = blocked("https.Agent.createConnection network egress");

const http2 = require("node:http2");
http2.connect = blocked("http2.connect network egress");
http2.createServer = blocked("http2.createServer listener");
http2.createSecureServer = blocked("http2.createSecureServer listener");

const dgram = require("node:dgram");
dgram.createSocket = blocked("dgram.createSocket network egress");

const dns = require("node:dns");
const dnsLookupMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
blockMethods(dns, dnsLookupMethods, "dns");
blockMethods(dns.promises, dnsLookupMethods, "dns.promises");

const dnsPromises = require("node:dns/promises");
blockMethods(dnsPromises, dnsLookupMethods, "dns/promises");

const childProcess = require("node:child_process");
for (const name of ["exec", "execFile", "fork", "spawn", "execSync", "execFileSync", "spawnSync"]) {
  childProcess[name] = blocked(`child_process.${name}`);
}

const workerThreads = require("node:worker_threads");
workerThreads.Worker = blocked("worker_threads.Worker");

const inspector = require("node:inspector");
inspector.open = blocked("inspector.open listener");

syncBuiltinESMExports();
