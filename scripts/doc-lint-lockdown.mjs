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
  return () => {
    throw new Error(`doc-lint lockdown blocked ${name}`);
  };
}

globalThis.fetch = blocked("fetch network egress");

const net = require("node:net");
net.connect = blocked("net.connect network egress");
net.createConnection = blocked("net.createConnection network egress");
net.createServer = blocked("net.createServer listener");

const tls = require("node:tls");
tls.connect = blocked("tls.connect network egress");
tls.createServer = blocked("tls.createServer listener");

const http = require("node:http");
http.get = blocked("http.get network egress");
http.request = blocked("http.request network egress");
http.createServer = blocked("http.createServer listener");

const https = require("node:https");
https.get = blocked("https.get network egress");
https.request = blocked("https.request network egress");
https.createServer = blocked("https.createServer listener");

const http2 = require("node:http2");
http2.connect = blocked("http2.connect network egress");
http2.createServer = blocked("http2.createServer listener");
http2.createSecureServer = blocked("http2.createSecureServer listener");

const dgram = require("node:dgram");
dgram.createSocket = blocked("dgram.createSocket network egress");

const dns = require("node:dns");
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  dns[name] = blocked(`dns.${name} network lookup`);
}

const childProcess = require("node:child_process");
for (const name of ["exec", "execFile", "fork", "spawn", "execSync", "execFileSync", "spawnSync"]) {
  childProcess[name] = blocked(`child_process.${name}`);
}

const workerThreads = require("node:worker_threads");
workerThreads.Worker = blocked("worker_threads.Worker");

syncBuiltinESMExports();
