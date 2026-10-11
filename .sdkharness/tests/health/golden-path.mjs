// Customer golden path through the real built stdio server, driven over MCP:
// authorize, upload, download, list, delete. Run by ../run-health; see ../../README.md.
import { call, startServer } from "../lib/session.mjs";

const bucket = process.env.B2_BUCKET_NAME;
const key = "sdkharness/golden-path.txt";
const body = Buffer.from(`sdkharness golden path ${Date.now()}\n`);

let step = "authorize";
const result = (outcome, reason) =>
  console.log(`SDKHARNESS_RESULT\thealth\tgolden-path\t${outcome}\t${reason}`);

let client;
try {
  client = await startServer("sdkharness-golden-path");
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
  await client?.close().catch(() => undefined);
}
