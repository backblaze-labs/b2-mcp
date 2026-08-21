import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const SIGNAL = "MCP_CLIENT_SMOKE_NETWORK_BLOCKED";

function block(kind) {
  return () => {
    process.stderr.write(`${SIGNAL}:${kind}\n`);
    throw new Error(`Network access blocked during MCP client smoke: ${kind}`);
  };
}

globalThis.fetch = block("fetch");
http.request = block("http.request");
http.get = block("http.get");
https.request = block("https.request");
https.get = block("https.get");
net.connect = block("net.connect");
net.createConnection = block("net.createConnection");
net.Socket.prototype.connect = block("net.Socket.connect");
tls.connect = block("tls.connect");
tls.TLSSocket.prototype.connect = block("tls.TLSSocket.connect");

syncBuiltinESMExports();
