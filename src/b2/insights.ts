/**
 * Storage-activity ("insights") tools — read-only usage questions answered from
 * data B2 already provides. No new backend.
 *
 *   Phase 1 (b2_usage_growth, b2_egress_leaders) — read the caller's daily Usage
 *     Report CSVs from the reserved `b2-reports-<accountId>` bucket. These reports
 *     are NOT universal: they must be enabled by Backblaze (Partner/Enterprise/
 *     Groups) — so the tools feature-detect the bucket and return a clean
 *     "not enabled" message when it is absent. Reports are region-scoped (only
 *     Group members in the same data region as the Group account).
 *   Phase 2 (b2_largest_files, b2_unfinished_uploads) — live, per-bucket S3
 *     listing. Works on any account; no index required.
 *
 * Everything is read-only and scoped by the caller's credential: each session
 * builds its own B2Client/S3Client from the request headers, so a partner key
 * sees its sub-accounts (one report row each) and a customer key sees only
 * itself — scope is automatic and fail-closed.
 *
 * The original handoff spec named native list tools (b2_list_file_names,
 * b2_list_unfinished_large_files, b2_list_parts) that were removed in the
 * S3-first refactor; these handlers use the S3 client instead.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { B2Client } from "./client.js";
import { B2AuthManager } from "../auth.js";
import { toolJson, toolError } from "../utils/errors.js";

const GB = 1e9; // report columns are GB = 1e9 bytes

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Minimal RFC-4180 parser: handles quoted fields, embedded commas, and "" escapes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    return obj;
  });
}

/** Normalize a report date to YYYY-MM-DD (the partner CSV sometimes uses M/D/YY). */
export function normalizeDate(raw: string): string | null {
  const s = (raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mo, d, y] = m;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export interface ReportRow {
  accountId: string;
  _date: string;
  bucketId?: string;
  bucketName?: string;
  storageBytes: number | null;
  egressBytes: number;
  uploadBytes: number;
  classCTxn: number;
}

function num(raw: string | undefined): number {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) ? n : 0;
}

export function mapRow(raw: Record<string, string>): ReportRow | null {
  const accountId = raw.account_id?.trim();
  const _date = normalizeDate(raw.date);
  if (!accountId || !_date) return null;
  const storedRaw = raw.stored_gb?.trim();
  return {
    accountId,
    _date,
    bucketId: raw.bucket_id?.trim() || undefined,
    bucketName: raw.bucket_name?.trim() || undefined,
    storageBytes: storedRaw === "" || storedRaw === undefined ? null : num(storedRaw) * GB,
    egressBytes: num(raw.downloaded_gb) * GB,
    uploadBytes: num(raw.uploaded_gb) * GB,
    classCTxn: num(raw.api_txn_class_c),
  };
}

// ── Pure aggregation (portable, from the handoff spec) ──────────────────────

export function computeAccountGrowth(rows: ReportRow[]) {
  const daily = new Map<string, Map<string, number>>();
  const tot = new Map<string, { egress: number }>();
  for (const r of rows || []) {
    const a = r.accountId,
      d = r._date;
    if (!a || !d) continue;
    if (!daily.has(a)) daily.set(a, new Map());
    if (r.storageBytes != null) {
      const m = daily.get(a)!;
      m.set(d, (m.get(d) || 0) + r.storageBytes);
    }
    if (!tot.has(a)) tot.set(a, { egress: 0 });
    tot.get(a)!.egress += r.egressBytes || 0;
  }
  const out = [];
  for (const [a, m] of daily) {
    const ds = [...m.keys()].sort();
    if (!ds.length) continue;
    const f = m.get(ds[0])!,
      l = m.get(ds[ds.length - 1])!;
    out.push({
      accountId: a,
      firstBytes: f,
      lastBytes: l,
      growthBytes: l - f,
      growthPct: f > 0 ? ((l - f) / f) * 100 : null,
      egressBytes: tot.get(a)!.egress,
    });
  }
  return out.sort((x, y) => y.growthBytes - x.growthBytes);
}

export function computeEgressLeaders(rows: ReportRow[], by: "account" | "bucket" = "account") {
  const g = new Map<
    string,
    { key: string; accountId: string; bucketName?: string; egress: number }
  >();
  for (const r of rows || []) {
    const k = by === "bucket" ? r.bucketId || r.bucketName : r.accountId;
    if (!k) continue;
    if (!g.has(k))
      g.set(k, { key: k, accountId: r.accountId, bucketName: r.bucketName, egress: 0 });
    g.get(k)!.egress += r.egressBytes || 0;
  }
  return [...g.values()].sort((a, b) => b.egress - a.egress);
}

// ── Report-bucket access ────────────────────────────────────────────────────

const NOT_ENABLED = {
  reports_enabled: false,
  note:
    "No b2-reports-<accountId> bucket found. Usage Reports are not automatic — they must be " +
    "enabled by Backblaze Support / your account representative (Partner, Enterprise, or Groups). " +
    "Once enabled, B2 backfills the previous 7 days.",
};

/**
 * The reserved daily-report bucket name for the caller: `b2-reports-<accountId>`.
 * This bucket is "Restricted" and B2 HIDES it from b2_list_buckets even for
 * full-capability, account-wide keys — so we construct the name directly rather
 * than try to discover it by listing. Existence is then probed by the S3 read in
 * loadReportRows (a 404 on the bucket → Usage Reports not enabled).
 */
async function reportsBucketName(auth: B2AuthManager): Promise<string> {
  const { accountId } = await auth.getAuth();
  return `b2-reports-${accountId}`;
}

/**
 * Pick the per-day "Usage" CSVs and drop the "Audit" mirror. B2 names them
 * `usage.account-<acct>.csv` and `usage.audit-account-<acct>.csv` — BOTH contain
 * "usage", so the discriminator is the absence of "audit". Including the audit
 * file would double-count every metric. Falls back to all non-audit CSVs if a
 * different account type names its files differently (Groups/Locations rows lack
 * account_id/date and are dropped by mapRow anyway).
 */
export function selectUsageKeys(keys: string[]): string[] {
  // Data files: usage.account-<acct>.csv and usage.group-<id>.<region>.csv.
  // Exclude:
  //   *audit*            — minimal mirror of usage (would double-count)
  //   *reportingLocations* — an INDEX file (lists report paths; no usage rows),
  //                          so fetching it is pure waste at partner scale.
  const isData = (k: string) =>
    /usage/i.test(k) && !/audit/i.test(k) && !/reportinglocations/i.test(k);
  const usage = keys.filter(isData);
  return usage.length ? usage : keys.filter((k) => !/audit/i.test(k));
}

/** Run `fn` over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * List + download the Usage CSVs within the window and return mapped rows.
 * Returns null when the bucket does not exist (reports not enabled).
 */
async function loadReportRows(
  s3: S3Client,
  bucketName: string,
  sinceDate: string,
): Promise<ReportRow[] | null> {
  const keyRe = /^\d{4}-\d{2}-\d{2}\/.+\.csv$/;
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        const k = o.Key ?? "";
        if (keyRe.test(k) && k.slice(0, 10) >= sinceDate) keys.push(k);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchBucket" || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }

  // Download the day CSVs concurrently — a partner bucket can hold a month of
  // files, and a sequential fetch blows past MCP client timeouts (~60s).
  const texts = await mapLimit(selectUsageKeys(keys), 16, async (key) => {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return obj.Body!.transformToString("utf-8");
  });

  const rows: ReportRow[] = [];
  for (const text of texts) {
    for (const raw of parseCsv(text)) {
      const mapped = mapRow(raw);
      if (mapped) rows.push(mapped);
    }
  }
  return rows;
}

function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function startOfMonthUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const gb = (bytes: number | null) => (bytes == null ? null : Math.round((bytes / GB) * 1000) / 1000);

// ── Phase 2 helpers ─────────────────────────────────────────────────────────

/** Resolve a bucket NAME from a name-or-bucketId input (S3 ops address by name). */
async function resolveBucketName(
  b2Client: B2Client,
  auth: B2AuthManager,
  input: string,
): Promise<{ name?: string; candidates?: string[] }> {
  const { accountId } = await auth.getAuth();
  const result = (await b2Client.call("b2_list_buckets", { accountId })) as {
    buckets?: Array<{ bucketName?: string; bucketId?: string }>;
  };
  const buckets = result.buckets ?? [];
  const exact = buckets.find((b) => b.bucketName === input || b.bucketId === input);
  if (exact?.bucketName) return { name: exact.bucketName };
  const subs = buckets.filter((b) => b.bucketName?.includes(input));
  if (subs.length === 1 && subs[0].bucketName) return { name: subs[0].bucketName };
  if (subs.length > 1)
    return { candidates: subs.map((b) => b.bucketName!).filter(Boolean) };
  return {};
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerInsightTools(
  server: McpServer,
  b2Client: B2Client,
  s3: S3Client,
  auth: B2AuthManager,
): void {
  // ── b2_usage_growth ───────────────────────────────────────────────────────
  server.tool(
    "b2_usage_growth",
    "Rank accounts by how much STORED data grew or shrank over a window, from the daily B2 usage reports. For 'which customers grew the most/least', 'who's moving data off'. Returns per-account start vs current GB and % growth. Scope follows the caller's key (a partner key sees all its sub-accounts). Needs Usage Reports enabled.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .default(30)
        .describe("Window length in days (1–90). Default 30."),
      order: z
        .enum(["most_grown", "least_grown", "shrinking"])
        .optional()
        .default("most_grown")
        .describe("Ranking. Default most_grown."),
      limit: z.number().int().min(1).optional().default(50).describe("Max accounts (default 50)."),
    },
    async (args) => {
      try {
        const rows = await loadReportRows(s3, await reportsBucketName(auth), daysAgo(args.days));
        if (rows === null) return toolJson(NOT_ENABLED);
        let accounts = computeAccountGrowth(rows);
        if (args.order === "least_grown") accounts = [...accounts].reverse();
        else if (args.order === "shrinking") accounts = accounts.filter((a) => a.growthBytes < 0);
        accounts = accounts.slice(0, args.limit);
        return toolJson({
          window_days: args.days,
          account_count: accounts.length,
          accounts: accounts.map((a) => ({
            account: a.accountId,
            start_gb: gb(a.firstBytes),
            current_gb: gb(a.lastBytes),
            growth_gb: gb(a.growthBytes),
            growth_pct: a.growthPct == null ? null : Math.round(a.growthPct * 10) / 10,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_egress_leaders ─────────────────────────────────────────────────────
  server.tool(
    "b2_egress_leaders",
    "Rank top egress (downloaded bytes) by account or bucket over a period — default month-to-date. For 'who's downloading the most', 'where is egress concentrated'. Returns leaders with each one's share of total egress, from the daily usage reports. Scope follows the caller's key. Needs Usage Reports enabled.",
    {
      by: z
        .enum(["account", "bucket"])
        .optional()
        .default("account")
        .describe("Rank by 'account' (default) or 'bucket'."),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Rolling window in days (1–90). Omit for current month to date."),
      limit: z.number().int().min(1).optional().default(15).describe("Leaders to return (15)."),
    },
    async (args) => {
      try {
        const since = args.days != null ? daysAgo(args.days) : startOfMonthUTC();
        const rows = await loadReportRows(s3, await reportsBucketName(auth), since);
        if (rows === null) return toolJson(NOT_ENABLED);
        const leaders = computeEgressLeaders(rows, args.by);
        const total = leaders.reduce((s, l) => s + l.egress, 0);
        const top = leaders.slice(0, args.limit);
        return toolJson({
          period: args.days != null ? `last ${args.days} days` : "current month to date",
          rank_by: args.by,
          total_egress_gb: gb(total),
          leaders: top.map((l) => ({
            [args.by]: args.by === "bucket" ? l.bucketName || l.key : l.key,
            egress_gb: gb(l.egress),
            share_pct: total > 0 ? Math.round((l.egress / total) * 1000) / 10 : 0,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_largest_files ──────────────────────────────────────────────────────
  server.tool(
    "b2_largest_files",
    "List a bucket's largest objects by size via a live listing. For 'largest files', 'what's taking up space in <bucket>'. Give the bucket by name or bucketId; optional path prefix. Returns name, size, and upload time — never contents.",
    {
      bucket: z.string().describe("Bucket name or bucketId to inspect."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("How many of the largest files to return (default 10, max 100)."),
      prefix: z.string().optional().describe('Optional path prefix, e.g. "checkpoints/".'),
    },
    async (args) => {
      try {
        const resolved = await resolveBucketName(b2Client, auth, args.bucket);
        if (!resolved.name)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: resolved.candidates ?? [],
            note: resolved.candidates?.length
              ? "Multiple buckets match; pass an exact name or bucketId."
              : `No bucket matches '${args.bucket}'.`,
          });

        // Bounded top-N by size — never accumulate every object.
        const top: Array<{ name: string; size: number; uploaded?: Date }> = [];
        let smallest = -Infinity;
        let token: string | undefined;
        let scanned = 0;
        do {
          const page = await s3.send(
            new ListObjectsV2Command({
              Bucket: resolved.name,
              Prefix: args.prefix,
              ContinuationToken: token,
            }),
          );
          for (const o of page.Contents ?? []) {
            scanned++;
            const size = o.Size ?? 0;
            if (top.length < args.limit || size > smallest) {
              top.push({ name: o.Key ?? "", size, uploaded: o.LastModified });
              top.sort((a, b) => b.size - a.size);
              if (top.length > args.limit) top.pop();
              smallest = top[top.length - 1].size;
            }
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);

        return toolJson({
          bucket: resolved.name,
          scanned,
          returned: top.length,
          files: top.map((f) => ({
            name: f.name,
            size_bytes: f.size,
            size_gb: gb(f.size),
            uploaded_at: f.uploaded,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_unfinished_uploads ─────────────────────────────────────────────────
  server.tool(
    "b2_unfinished_uploads",
    "Find abandoned multipart uploads that silently consume storage in a bucket. For 'bucket bloat', 'stuck/incomplete uploads', 'wasted storage'. Returns count, oldest upload age, and wasted bytes. Give the bucket by name or bucketId. Live listing.",
    {
      bucket: z.string().describe("Bucket name or bucketId to inspect."),
      older_than_days: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Only count uploads started more than this many days ago (optional)."),
    },
    async (args) => {
      try {
        const resolved = await resolveBucketName(b2Client, auth, args.bucket);
        if (!resolved.name)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: resolved.candidates ?? [],
            note: resolved.candidates?.length
              ? "Multiple buckets match; pass an exact name or bucketId."
              : `No bucket matches '${args.bucket}'.`,
          });

        const cutoff =
          args.older_than_days != null ? Date.now() - args.older_than_days * 86400_000 : null;

        const uploads: Array<{ key: string; uploadId: string; initiated?: Date }> = [];
        let keyMarker: string | undefined;
        let idMarker: string | undefined;
        do {
          const page = await s3.send(
            new ListMultipartUploadsCommand({
              Bucket: resolved.name,
              KeyMarker: keyMarker,
              UploadIdMarker: idMarker,
            }),
          );
          for (const u of page.Uploads ?? []) {
            const initiated = u.Initiated;
            if (cutoff != null && initiated && initiated.getTime() > cutoff) continue;
            uploads.push({ key: u.Key ?? "", uploadId: u.UploadId ?? "", initiated });
          }
          if (page.IsTruncated) {
            keyMarker = page.NextKeyMarker;
            idMarker = page.NextUploadIdMarker;
          } else {
            keyMarker = undefined;
            idMarker = undefined;
          }
        } while (keyMarker || idMarker);

        if (!uploads.length)
          return toolJson({
            bucket: resolved.name,
            unfinished_count: 0,
            note: "No abandoned multipart uploads found.",
          });

        // Sum already-uploaded part bytes for wasted storage; find the oldest.
        let wasted = 0;
        let oldest = uploads[0];
        for (const u of uploads) {
          if ((u.initiated?.getTime() ?? Infinity) < (oldest.initiated?.getTime() ?? Infinity))
            oldest = u;
          let partMarker: number | undefined;
          do {
            const parts = await s3.send(
              new ListPartsCommand({
                Bucket: resolved.name,
                Key: u.key,
                UploadId: u.uploadId,
                PartNumberMarker: partMarker != null ? String(partMarker) : undefined,
              }),
            );
            for (const p of parts.Parts ?? []) wasted += p.Size ?? 0;
            partMarker = parts.IsTruncated ? Number(parts.NextPartNumberMarker) : undefined;
          } while (partMarker != null);
        }

        return toolJson({
          bucket: resolved.name,
          unfinished_count: uploads.length,
          wasted_gb: gb(wasted),
          oldest_started_at: oldest.initiated,
          oldest_file: oldest.key,
          note:
            "Consider a lifecycle rule to auto-cancel unfinished large uploads " +
            "(daysFromStartingToCancelingUnfinishedLargeFiles).",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
