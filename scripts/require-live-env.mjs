#!/usr/bin/env node

/* global console, process */

import { b2CredentialPolicy } from "./b2-credential-env.mjs";

const profile = process.argv[2] ?? "integration";
const required = b2CredentialPolicy.liveRequired;
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  const command =
    profile === "contract" ? "pnpm run test:live:b2-contract" : "pnpm run test:live:b2-integration";
  console.error(`${command} requires live Backblaze B2 credentials.`);
  console.error(`Missing: ${missing.join(", ")}`);
  console.error("Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY, then rerun the live command.");
  process.exit(2);
}
