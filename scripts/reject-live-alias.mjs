#!/usr/bin/env node

const profile = process.argv[2] ?? "integration";
const liveCommand = profile === "contract" ? "test:live:b2-contract" : "test:live:b2-integration";
const deprecatedAlias = `test:${profile}:live`;

console.error(`pnpm run ${deprecatedAlias} is a deprecated live-test alias.`);
console.error(`Use pnpm run ${liveCommand} for live B2 ${profile} tests.`);
process.exit(2);
