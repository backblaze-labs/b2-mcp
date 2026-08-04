#!/usr/bin/env node

/* global console, process */

import { b2CredentialPolicy } from "./b2-credential-env.mjs";

const profile = process.argv[2] ?? "integration";
const required = b2CredentialPolicy.liveRequired;
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  const command =
    profile === "contract" ? "npm run test:contract:live" : "npm run test:integration:live";
  console.error(`${command} requires live Backblaze B2 credentials.`);
  console.error(`Missing: ${missing.join(", ")}`);
  console.error("Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY, then rerun the live command.");
  process.exit(2);
}

const [optionalAppKeyId, optionalAppKey] = b2CredentialPolicy.integrationOptional;
if (profile === "integration" && (!process.env[optionalAppKeyId] || !process.env[optionalAppKey])) {
  console.error(
    "Note: B2_APP_KEY_ID/B2_APP_KEY are unset, so S3-specific live cases will be skipped.",
  );
}
