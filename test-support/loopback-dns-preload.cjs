"use strict";
// Test-only preload (`node --require`): resolves the single host named by
// B2_TEST_LOOPBACK_HOST to 127.0.0.1 so a spawned server can reach a local
// HTTPS fake without touching DNS. Every other name resolves normally.
const dns = require("node:dns");

const host = process.env.B2_TEST_LOOPBACK_HOST;
if (process.env.NODE_ENV === "test" && host) {
  const originalLookup = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (hostname !== host) return originalLookup.call(dns, hostname, options, callback);
    const opts = typeof options === "number" ? { family: options } : options || {};
    if (opts.all) return process.nextTick(callback, null, [{ address: "127.0.0.1", family: 4 }]);
    return process.nextTick(callback, null, "127.0.0.1", 4);
  };
}
