import { spawnSync } from "child_process";
import { join } from "path";
import { createRequire } from "module";
import type { JsonCompatible } from "../../src/utils/result-serializer";

const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { sanitizedEnv } = nodeRequire("../../scripts/lib/sanitized-env.cjs") as {
  sanitizedEnv: (
    extra?: Record<string, string>,
    options?: { sourceEnv?: NodeJS.ProcessEnv },
  ) => NodeJS.ProcessEnv;
};

export const TOON_DECODER_BLOCKED_ENV = [
  "AWS_SECRET_ACCESS_KEY",
  "B2_APPLICATION_KEY",
  "B2_MASTER_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "B2_MCP_CANARY_TOKEN",
  "B2_MCP_CANARY_SECRET",
  "B2_MCP_CANARY_PASSWORD",
];

export async function decodeToon(text: string): Promise<JsonCompatible> {
  const script = `
const fs = require("node:fs");
const blocked = ${JSON.stringify(TOON_DECODER_BLOCKED_ENV)};
function assertSanitized(phase) {
  for (const name of blocked) {
    if (process.env[name]) throw new Error(\`TOON decoder env leak during \${phase}: \${name}\`);
  }
}
(async () => {
  assertSanitized("pre-import");
  const { decode } = await import("@toon-format/toon");
  assertSanitized("post-import");
  const text = fs.readFileSync(0, "utf8");
  process.stdout.write(JSON.stringify(decode(text)));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env: sanitizedEnv({}, { sourceEnv: process.env }),
    input: text,
  });

  if (result.status !== 0) {
    throw new Error(
      `TOON decoder failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }

  return JSON.parse(result.stdout) as JsonCompatible;
}
