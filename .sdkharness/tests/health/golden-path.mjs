// Customer golden path through the real built stdio server, driven over MCP:
// authorize, upload, download, list, delete. Run by ../run-health; see ../../README.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bucket = process.env.B2_BUCKET_NAME;
const key = "sdkharness/golden-path.txt";
const body = Buffer.from(`sdkharness golden path ${Date.now()}\n`);

let step = "authorize";
const result = (outcome, reason) =>
  console.log(`SDKHARNESS_RESULT\thealth\tgolden-path\t${outcome}\t${reason}`);

async function call(client, name, args) {
  const out = await client.callTool({ name, arguments: args });
  const text = out.content.map((part) => part.text ?? "").join("");
  if (out.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

// Only the simulator's fixed test credential and the test-only endpoint reach the server.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--require",
    join(ROOT, "test-support/loopback-dns-preload.cjs"),
    join(ROOT, "dist/index.js"),
  ],
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    NODE_EXTRA_CA_CERTS: process.env.SDKHARNESS_SIMULATOR_CA,
    B2_TEST_REALM: process.env.SDKHARNESS_REALM,
    B2_TEST_LOOPBACK_HOST: process.env.SDKHARNESS_FIXTURE_HOST,
    B2_APPLICATION_KEY_ID: "test-key-id",
    B2_APPLICATION_KEY: "test-key",
    B2_REGION: "us-west-004",
    B2_SECRET_SINK: "off",
  },
  stderr: "inherit",
});
const client = new Client({ name: "sdkharness-golden-path", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const tool of ["s3_put_object", "s3_get_object", "s3_list_objects_v2", "s3_delete_object"]) {
    if (!names.has(tool)) throw new Error(`${tool} is not registered for the test key`);
  }

  step = "upload";
  await call(client, "s3_put_object", {
    bucket,
    key,
    content: body.toString("base64"),
    contentType: "text/plain",
  });

  step = "download";
  const got = await call(client, "s3_get_object", { bucket, key });
  if (!Buffer.from(got.content, "base64").equals(body)) throw new Error("downloaded bytes differ");

  step = "list";
  const listed = await call(client, "s3_list_objects_v2", { bucket });
  if (!listed.objects.some((object) => object.Key === key)) throw new Error(`${key} is not listed`);

  // By version: the simulator keeps delete markers, so a key-only delete leaves the bucket non-empty.
  step = "delete";
  await call(client, "s3_delete_object", { bucket, key, versionId: got.versionId, confirm: true });
  const after = await call(client, "s3_list_object_versions", { bucket, prefix: key });
  if (after.versions?.length || after.deleteMarkers?.length)
    throw new Error(`${key} is still present`);

  result("PASS", "-");
} catch (error) {
  const why = String(error?.message ?? error).replace(/\s+/g, " ");
  result("FAIL", `${step} -- ${why.slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
