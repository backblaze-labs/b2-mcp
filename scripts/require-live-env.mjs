#!/usr/bin/env node

const profile = process.argv[2] ?? "integration";
const required = ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  const command =
    profile === "contract" ? "npm run test:contract:live" : "npm run test:integration:live";
  console.error(`${command} requires live Backblaze B2 credentials.`);
  console.error(`Missing: ${missing.join(", ")}`);
  console.error("Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY, then rerun the live command.");
  process.exit(2);
}

if (profile === "integration" && (!process.env.B2_APP_KEY_ID || !process.env.B2_APP_KEY)) {
  console.error(
    "Note: B2_APP_KEY_ID/B2_APP_KEY are unset, so S3-specific live cases will be skipped.",
  );
}
