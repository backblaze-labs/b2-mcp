#!/usr/bin/env node

const profile = process.argv[2] ?? "integration";
const liveCommand = profile === "contract" ? "test:contract:live" : "test:integration:live";

console.error(`pnpm run test:${profile} is not a credential-free test layer.`);
console.error(`Use pnpm run ${liveCommand} for live B2 ${profile} tests.`);
process.exit(2);
