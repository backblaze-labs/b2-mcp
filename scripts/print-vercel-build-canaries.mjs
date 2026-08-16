#!/usr/bin/env node
import { vercelBuildKnownSecretCanaries } from "./b2-credential-env.mjs";

for (const [name, value] of Object.entries(vercelBuildKnownSecretCanaries)) {
  console.log(`${name}=${value}`);
}
