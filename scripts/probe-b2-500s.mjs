#!/usr/bin/env node
/**
 * Low-volume diagnostic probe for genuine Backblaze B2 5xx responses.
 *
 * Runs a small, curated set of edge-case requests (one each — NOT load testing)
 * against the live B2 API through the MCP tools, classifies each result using the
 * (now status-aware) error formatter, and separates:
 *   - GENUINE_B2_5XX  → ticket candidates (real server-side failures)
 *   - CLIENT_4XX      → expected client errors (not bugs)
 *   - NO_ERROR        → returned successfully
 *
 * For every ticket candidate it writes a ready-to-review Backblaze ticket draft
 * including the B2 requestId. Output goes to the gitignored probe-output/ dir.
 *
 * Usage (build first, then run with creds):
 *   pnpm run probe:500
 * Requires: B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY (+ B2_APP_KEY_ID/B2_APP_KEY
 * for the S3 probes, which is where the suspected 500s live).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadConfig, createServer, getRegisteredTools } from "../dist/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "probe-output");
const TICKET_DIR = path.join(OUT_DIR, "tickets");

// ── Tool invocation helpers (mirror tests/live/b2.integration.live.test.ts) ────

function getHandler(server, name) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) return null;
  return tool.execute ?? null;
}

async function callTool(server, name, args) {
  const handler = getHandler(server, name);
  if (!handler)
    return { isError: true, content: [{ type: "text", text: `Tool not found: ${name}` }] };
  try {
    return await handler(args, {});
  } catch (err) {
    // A tool that throws instead of returning a structured error.
    return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
  }
}

function textOf(result) {
  return result?.content?.[0]?.text ?? "";
}

function parseResult(result) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pull status/code/message/requestId out of a formatB2Error() string. */
function classify(result) {
  if (!result?.isError) return { class: "NO_ERROR", raw: textOf(result) };
  const text = textOf(result);
  const m = text.match(/^B2 Error \[(.+?)\] \(HTTP (\d+)\): ([\s\S]*?)(?: \(requestId: (.+?)\))?$/);
  if (!m) return { class: "UNCLASSIFIED", raw: text };
  const status = Number(m[2]);
  const klass = status >= 500 ? "GENUINE_B2_5XX" : status >= 400 ? "CLIENT_4XX" : "OTHER";
  return { class: klass, status, code: m[1], message: m[3], requestId: m[4], raw: text };
}

function isUserWritableBucket(name) {
  const n = String(name).toLowerCase();
  return !n.includes("snapshot") && !n.startsWith("b2-reports") && !n.startsWith("b2-snapshots");
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig(); // exits if creds missing
  const server = createServer(config);
  const hasS3 = !!(process.env.B2_APP_KEY_ID && process.env.B2_APP_KEY);

  // Discover real targets for the probes.
  const b2Buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
  const b2Bucket = (b2Buckets?.buckets ?? []).find((b) => isUserWritableBucket(b.bucketName));
  const b2BucketId = b2Bucket?.bucketId;
  const b2BucketName = b2Bucket?.bucketName;

  let s3Bucket, s3Key, s3KeyBucket;
  if (hasS3) {
    const s3Buckets = parseResult(await callTool(server, "s3_list_buckets", {}));
    const writable = (s3Buckets?.buckets ?? []).filter((b) => isUserWritableBucket(b.Name));
    s3Bucket = writable[0]?.Name;
    // Find any writable bucket that actually contains an object, so the
    // key-dependent probes (range, object ACL) have a real target.
    for (const b of writable) {
      const objs = parseResult(
        await callTool(server, "s3_list_objects_v2", { bucket: b.Name, maxKeys: 1 }),
      );
      if (objs?.objects?.length) {
        s3KeyBucket = b.Name;
        s3Key = objs.objects[0].Key;
        break;
      }
    }
  }

  console.log(
    `Probing — B2 bucket: ${b2BucketId ?? "(none)"}, S3 bucket: ${s3Bucket ?? "(none/skipped)"}`,
  );

  // Curated probe list. Each: { id, tool, args, expect, note, run? }.
  // `run` allows a self-cleaning safe-write sequence and returns the result to classify.
  const probes = [
    // ── B2 native SDK — sanity baselines ──
    {
      id: "b2-bad-file-id",
      tool: "b2_get_file_info",
      args: { fileId: "4_bad_id_000000000000000000000000000" },
      expect: "400 bad_file_id",
    },
    {
      id: "b2-bad-bucket-id",
      tool: "b2_list_file_names",
      args: { bucketId: "bad_bucket_id_000" },
      expect: "400 bad_bucket_id",
    },
    // ── B2 native SDK edge cases ──
    {
      id: "b2-download-by-bad-id",
      tool: "b2_download_file_by_id",
      args: { fileId: "4_bad_id_000000000000000000000000000" },
      expect: "400/404 bad_file_id",
    },
    {
      id: "b2-get-upload-url-bad-bucket",
      tool: "b2_get_upload_url",
      args: { bucketId: "bad_bucket_id_000" },
      expect: "400/404 bad_bucket_id",
    },
    {
      id: "b2-list-versions-bad-bucket",
      tool: "b2_list_file_versions",
      args: { bucketId: "bad_bucket_id_000" },
      expect: "400 bad_bucket_id",
    },
    {
      id: "b2-list-unfinished-bad-bucket",
      tool: "b2_list_unfinished_large_files",
      args: { bucketId: "bad_bucket_id_000" },
      expect: "400 bad_bucket_id",
    },
    {
      id: "b2-cancel-large-file-bad-id",
      tool: "b2_cancel_large_file",
      args: { fileId: "4_bad_id_000000000000000000000000000" },
      expect: "400/404",
    },
    {
      id: "b2-get-upload-part-url-bad-id",
      tool: "b2_get_upload_part_url",
      args: { fileId: "4_bad_id_000000000000000000000000000" },
      expect: "400/404",
    },
    {
      id: "b2-delete-version-bad",
      tool: "b2_delete_file_version",
      args: { fileId: "4_bad_id_000000000000000000000000000", fileName: "nope.xyz" },
      expect: "400 bad_file_id (no mutation)",
    },
    {
      id: "b2-download-auth-bad-bucket",
      tool: "b2_get_download_authorization",
      args: { bucketId: "bad_bucket_id_000", fileNamePrefix: "", validDurationInSeconds: 3600 },
      expect: "400 bad_bucket_id",
    },
  ];

  if (b2BucketName) {
    probes.push({
      id: "b2-download-missing-name",
      tool: "b2_download_file_by_name",
      args: { bucketName: b2BucketName, fileName: "nonexistent-mcp-probe.xyz" },
      expect: "404 not_found",
    });
  }

  if (hasS3 && s3Bucket) {
    probes.push(
      {
        id: "s3-missing-key",
        tool: "s3_get_object",
        args: { bucket: s3Bucket, key: "nonexistent-mcp-probe-key.xyz" },
        expect: "404 NoSuchKey",
      },
      {
        id: "s3-missing-bucket",
        tool: "s3_head_bucket",
        args: { bucket: "nonexistent-mcp-probe-bucket-xyz-99999" },
        expect: "404 NotFound",
      },
      {
        id: "s3-get-bucket-logging",
        tool: "s3_get_bucket_logging",
        args: { bucket: s3Bucket },
        expect: "200 or 4xx (B2 S3 limitation)",
      },
      {
        id: "s3-get-bucket-encryption",
        tool: "s3_get_bucket_encryption",
        args: { bucket: s3Bucket },
        expect: "200 or 4xx (none configured)",
      },
      {
        id: "s3-get-bucket-cors",
        tool: "s3_get_bucket_cors",
        args: { bucket: s3Bucket },
        expect: "200 or 4xx NoSuchCORSConfiguration",
      },
      {
        id: "s3-get-bucket-lifecycle",
        tool: "s3_get_bucket_lifecycle",
        args: { bucket: s3Bucket },
        expect: "200 or 4xx NoSuchLifecycleConfiguration",
      },
      {
        id: "s3-get-object-lock-config",
        tool: "s3_get_object_lock_configuration",
        args: { bucket: s3Bucket },
        expect: "200 or 4xx (lock not enabled)",
      },
      {
        id: "s3-put-acl-missing-key",
        tool: "s3_put_object_acl",
        args: { bucket: s3Bucket, key: "nonexistent-mcp-probe-key.xyz", acl: "private" },
        expect: "404 NoSuchKey (no mutation)",
      },
    );

    // Key-dependent probes — need a bucket that actually contains an object.
    if (s3Key && s3KeyBucket) {
      probes.push(
        {
          id: "s3-malformed-range",
          tool: "s3_get_object",
          args: { bucket: s3KeyBucket, key: s3Key, range: "bytes=invalid" },
          expect: "416/400 (bad range)",
        },
        {
          id: "s3-get-object-acl",
          tool: "s3_get_object_acl",
          args: { bucket: s3KeyBucket, key: s3Key },
          expect: "200 or 4xx",
        },
      );
    }

    // Safe-write: create a multipart upload, attempt a bad upload_part_copy, ALWAYS abort.
    // Does not need an existing object — a likely B2-S3 500 candidate.
    probes.push({
      id: "s3-upload-part-copy-bad-source",
      tool: "s3_upload_part_copy",
      expect: "404 NoSuchBucket/Key (B2 may 500)",
      run: async () => {
        const created = parseResult(
          await callTool(server, "s3_create_multipart_upload", {
            bucket: s3Bucket,
            key: "mcp-probe-mpu.bin",
          }),
        );
        const uploadId = created?.uploadId;
        if (!uploadId)
          return {
            isError: true,
            content: [{ type: "text", text: "could not start multipart upload to probe" }],
          };
        try {
          return await callTool(server, "s3_upload_part_copy", {
            bucket: s3Bucket,
            key: "mcp-probe-mpu.bin",
            uploadId,
            partNumber: 1,
            copySource: "nonexistent-mcp-probe-bucket/nope.bin",
          });
        } finally {
          await callTool(server, "s3_abort_multipart_upload", {
            bucket: s3Bucket,
            key: "mcp-probe-mpu.bin",
            uploadId,
          });
        }
      },
    });
  }

  // Run probes (sequentially, one request each).
  const results = [];
  for (const p of probes) {
    const result = p.run ? await p.run() : await callTool(server, p.tool, p.args);
    const c = classify(result);
    results.push({ ...p, ...c });
    const tag =
      c.class === "GENUINE_B2_5XX"
        ? "🚩"
        : c.class === "CLIENT_4XX"
          ? "·"
          : c.class === "NO_ERROR"
            ? "ok"
            : "?";
    console.log(
      `  ${tag} ${p.id.padEnd(30)} → ${c.class}${c.status ? ` (HTTP ${c.status} ${c.code})` : ""}`,
    );
  }

  writeReport(config, results);
}

function writeReport(config, results) {
  fs.mkdirSync(TICKET_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const candidates = results.filter((r) => r.class === "GENUINE_B2_5XX");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const sdkVer = pkg.dependencies?.["@aws-sdk/client-s3"] ?? "unknown";

  // ── Summary report ──
  const lines = [];
  lines.push(
    `# B2 500-error probe report`,
    ``,
    `- Run: ${ts}`,
    `- Region: ${config.region}`,
    `- @aws-sdk/client-s3: ${sdkVer}`,
    ``,
  );
  lines.push(`## Ticket candidates (genuine HTTP 5xx) — ${candidates.length}`, ``);
  if (!candidates.length) lines.push(`_None observed in this run._`, ``);
  for (const r of candidates) {
    lines.push(`### ${r.id} — \`${r.tool}\``);
    lines.push(`- HTTP **${r.status}** \`${r.code}\` — ${r.message}`);
    lines.push(`- requestId: \`${r.requestId ?? "(none returned)"}\``);
    lines.push(`- expected: ${r.expect}`, ``);
  }
  const others = results.filter((r) => r.class !== "GENUINE_B2_5XX");
  lines.push(
    `## Other results`,
    ``,
    `| probe | tool | class | status | code |`,
    `|---|---|---|---|---|`,
  );
  for (const r of others) {
    lines.push(`| ${r.id} | ${r.tool} | ${r.class} | ${r.status ?? "-"} | ${r.code ?? "-"} |`);
  }
  const reportPath = path.join(OUT_DIR, `report-${ts.replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(reportPath, lines.join("\n") + "\n");

  // ── Per-candidate ticket drafts ──
  for (const r of candidates) {
    const ticket = [
      `# [B2 API] ${r.tool} returns HTTP ${r.status} ${r.code}`,
      ``,
      `## Summary`,
      `Calling \`${r.tool}\` returns **HTTP ${r.status} ${r.code}** where a ${r.expect.split("(")[0].trim()} is expected.`,
      ``,
      `## Environment`,
      `- Region: ${config.region}`,
      `- Endpoint: S3-compatible (AWS SDK v3 ${sdkVer})`,
      `- Date: ${ts}`,
      ``,
      `## Steps to reproduce`,
      `1. Authenticate with a standard application key.`,
      `2. Invoke \`${r.tool}\` with arguments:`,
      "```json",
      JSON.stringify(
        r.args ?? "(multi-step safe-write sequence; see probe id " + r.id + ")",
        null,
        2,
      ),
      "```",
      ``,
      `## Expected`,
      `${r.expect}`,
      ``,
      `## Actual`,
      `\`HTTP ${r.status} ${r.code}\`: ${r.message}`,
      ``,
      `## Diagnostics (for B2 engineering)`,
      `- requestId: \`${r.requestId ?? "(none returned — please advise how to capture)"}\``,
      `- timestamp: ${ts}`,
      ``,
      `_Generated by scripts/probe-b2-500s.mjs. Review before filing._`,
    ];
    fs.writeFileSync(path.join(TICKET_DIR, `${r.id}.md`), ticket.join("\n") + "\n");
  }

  console.log(``);
  console.log(`Report:  ${path.relative(ROOT, reportPath)}`);
  console.log(`Tickets: ${candidates.length} draft(s) in ${path.relative(ROOT, TICKET_DIR)}/`);
  if (!candidates.length)
    console.log(
      `No genuine 5xx observed — nothing to file. (Re-run later; B2 5xx can be intermittent.)`,
    );
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
