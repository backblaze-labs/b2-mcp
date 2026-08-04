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
 *   Phase 2 (b2_largest_files, b2_unfinished_uploads) — live, per-bucket native
 *     listing. Works on any account; no index required.
 *
 * Everything is read-only and scoped by the caller's credential: HTTP builds a
 * fresh B2Client after per-request credential resolution, so a partner
 * key sees its sub-accounts (one report row each) and a customer key sees only
 * itself — scope is automatic and fail-closed.
 */
import type { ToolRegistrar } from "../mcp.js";
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
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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
  b2Client: B2Client,
  bucketName: string,
  sinceDate: string,
): Promise<ReportRow[] | null> {
  const keyRe = /^\d{4}-\d{2}-\d{2}\/.+\.csv$/;
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await b2Client.listReportObjectKeys(bucketName, {
        // StartAfter skips every key before the window (keys are date-prefixed
        // and sort lexically), so a long-lived report bucket isn't fully scanned.
        // StartAfter applies to the first page only; ContinuationToken drives the rest.
        startAfter: sinceDate,
        continuationToken: token,
      });
      for (const k of page.keys) {
        if (keyRe.test(k) && k.slice(0, 10) >= sinceDate) keys.push(k);
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchBucket" || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }

  // Download the day CSVs concurrently — a partner bucket can hold a month of
  // files, and a sequential fetch blows past MCP client timeouts (~60s).
  const texts = await mapLimit(selectUsageKeys(keys), 16, async (key) => {
    return b2Client.downloadReportObjectText(bucketName, key);
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

const gb = (bytes: number | null) =>
  bytes == null ? null : Math.round((bytes / GB) * 1000) / 1000;

function dateFromTimestamp(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

// ── Snapshot growth (point-in-time stored_gb at two dates) ──────────────────
// Per Backblaze's Usage Report spec, stored_gb is "bytes stored in gigabytes
// (at the end of the day)" — a point-in-time snapshot — so growth is the
// difference between the latest snapshot and the snapshot one period earlier.
// We fetch ONLY those two boundary days (Prefix/StartAfter-scoped listings),
// never the whole report bucket.

type Period = "month" | "quarter" | "year";

/** Date one period before `from` (UTC), day-clamped for short months
 *  (e.g. Mar 31 minus one month → Feb 28/29, not Mar 3). */
export function periodStartDate(period: Period, from: Date): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const day = from.getUTCDate();
  let ty = y;
  let tm = m;
  if (period === "month") tm = m - 1;
  else if (period === "quarter") tm = m - 3;
  else ty = y - 1;
  const target = new Date(Date.UTC(ty, tm, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function snapshotDateOf(key: string): string | null {
  const m = key.match(/^(\d{4}-\d{2}-\d{2})\//);
  return m ? m[1] : null;
}

function is404(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "NoSuchBucket" || err.$metadata?.httpStatusCode === 404;
}

/** Date of the nearest available daily snapshot at or after `target`.
 *  `{ bucketMissing: true }` ⇒ reports bucket absent (not enabled). */
async function nearestSnapshotDate(
  b2Client: B2Client,
  bucketName: string,
  target: string,
): Promise<{ date: string | null; bucketMissing: boolean }> {
  try {
    const page = await b2Client.listReportObjectKeys(bucketName, {
      startAfter: target,
      maxKeys: 1,
    });
    return { date: snapshotDateOf(page.keys[0] ?? ""), bucketMissing: false };
  } catch (e) {
    if (is404(e)) return { date: null, bucketMissing: true };
    throw e;
  }
}

/** Date of the latest available snapshot (most recent day on or before today).
 *  Lists only recent days via StartAfter, widening if reporting is stale. */
export async function latestSnapshotDate(
  b2Client: B2Client,
  bucketName: string,
  today: Date,
): Promise<{ date: string | null; bucketMissing: boolean }> {
  for (const lookback of [10, 45, 180]) {
    const after = new Date(today.getTime() - lookback * 86400_000).toISOString().slice(0, 10);
    let token: string | undefined;
    let max: string | null = null;
    try {
      do {
        const page = await b2Client.listReportObjectKeys(bucketName, {
          startAfter: after,
          continuationToken: token,
        });
        for (const key of page.keys) {
          const d = snapshotDateOf(key);
          if (d && (max === null || d > max)) max = d;
        }
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
    } catch (e) {
      if (is404(e)) return { date: null, bucketMissing: true };
      throw e;
    }
    if (max) return { date: max, bucketMissing: false };
  }
  return { date: null, bucketMissing: false };
}

/** All usage rows for a single day folder (summed across that day's region files). */
export async function loadDayRows(
  b2Client: B2Client,
  bucketName: string,
  dayDate: string,
): Promise<ReportRow[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await b2Client.listReportObjectKeys(bucketName, {
      prefix: `${dayDate}/`,
      continuationToken: token,
    });
    for (const k of page.keys) {
      if (/\.csv$/i.test(k)) keys.push(k);
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  const texts = await mapLimit(selectUsageKeys(keys), 16, async (key) => {
    return b2Client.downloadReportObjectText(bucketName, key);
  });
  const rows: ReportRow[] = [];
  for (const text of texts)
    for (const raw of parseCsv(text)) {
      const mapped = mapRow(raw);
      if (mapped) rows.push(mapped);
    }
  return rows;
}

/** Sum stored bytes per account from a snapshot's rows (skip null storage). */
function storedByAccount(rows: ReportRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.storageBytes == null) continue;
    m.set(r.accountId, (m.get(r.accountId) ?? 0) + r.storageBytes);
  }
  return m;
}

export interface SnapshotGrowth {
  accountId: string;
  firstBytes: number;
  lastBytes: number;
  growthBytes: number;
  growthPct: number | null;
  isNew: boolean;
}

/** Per-account stored-data growth between two snapshots. Accounts present only
 *  in `now` are new (no % baseline); present only in `then` shrank toward zero. */
export function computeSnapshotGrowth(
  thenRows: ReportRow[],
  nowRows: ReportRow[],
): SnapshotGrowth[] {
  const then = storedByAccount(thenRows);
  const now = storedByAccount(nowRows);
  const out: SnapshotGrowth[] = [];
  for (const a of new Set([...then.keys(), ...now.keys()])) {
    const had = then.has(a);
    const firstBytes = then.get(a) ?? 0;
    const lastBytes = now.get(a) ?? 0;
    out.push({
      accountId: a,
      firstBytes,
      lastBytes,
      growthBytes: lastBytes - firstBytes,
      growthPct: had && firstBytes > 0 ? ((lastBytes - firstBytes) / firstBytes) * 100 : null,
      isNew: !had,
    });
  }
  return out.sort((x, y) => y.growthBytes - x.growthBytes);
}

// ── Phase 2 helpers ─────────────────────────────────────────────────────────

/** Resolve a bucket name/id pair from a name-or-bucketId input. */
async function resolveBucketName(
  b2Client: B2Client,
  input: string,
): Promise<{ name?: string; id?: string; candidates?: string[] }> {
  const result = await b2Client.listBuckets();
  const buckets = result.buckets ?? [];
  const exact = buckets.find((b) => b.bucketName === input || b.bucketId === input);
  if (exact?.bucketName && exact.bucketId) return { name: exact.bucketName, id: exact.bucketId };
  const subs = buckets.filter((b) => b.bucketName?.includes(input));
  if (subs.length === 1 && subs[0].bucketName && subs[0].bucketId) {
    return { name: subs[0].bucketName, id: subs[0].bucketId };
  }
  if (subs.length > 1) return { candidates: subs.map((b) => b.bucketName!).filter(Boolean) };
  return {};
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerInsightTools(
  server: ToolRegistrar,
  b2Client: B2Client,
  auth: B2AuthManager,
): void {
  // ── b2_usage_growth ───────────────────────────────────────────────────────
  server.registerTool(
    "b2_usage_growth",
    {
      description:
        "Rank accounts by how much STORED data grew or shrank between two points in time, from the daily B2 usage reports (uses stored_gb, the end-of-day snapshot). For 'which customers grew the most/least', 'who's moving data off'. Compares the latest snapshot against one month/quarter/year earlier and fetches only those two days, so it stays fast even on large report buckets. Returns the two dates compared and per-account start vs current GB and % growth (new accounts flagged). Scope follows the caller's key (a partner key sees all its sub-accounts). Needs Usage Reports enabled.",
      inputSchema: {
        period: z
          .enum(["month", "quarter", "year"])
          .optional()
          .default("month")
          .describe(
            "Compare the latest snapshot against one month, quarter, or year ago. Default month.",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            "Custom trailing window in days that overrides `period` (e.g. 7 for week-over-week).",
          ),
        order: z
          .enum(["most_grown", "least_grown", "shrinking"])
          .optional()
          .default("most_grown")
          .describe("Ranking. Default most_grown."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe("Max accounts (default 50)."),
      },
    },
    async (args) => {
      try {
        const bucket = await reportsBucketName(auth);
        const today = new Date();
        const targetThen =
          args.days != null ? daysAgo(args.days) : periodStartDate(args.period, today);

        const latest = await latestSnapshotDate(b2Client, bucket, today);
        if (latest.bucketMissing) return toolJson(NOT_ENABLED);
        if (!latest.date)
          return toolJson({ reports_enabled: true, note: "No usage-report snapshots found yet." });

        const then = await nearestSnapshotDate(b2Client, bucket, targetThen);
        if (then.bucketMissing) return toolJson(NOT_ENABLED);
        if (!then.date || then.date >= latest.date)
          return toolJson({
            reports_enabled: true,
            note:
              `Not enough report history to compare: latest snapshot is ${latest.date}, with no ` +
              `earlier snapshot at or after the requested ${targetThen}.`,
            latest_snapshot: latest.date,
          });

        const [thenRows, nowRows] = await Promise.all([
          loadDayRows(b2Client, bucket, then.date),
          loadDayRows(b2Client, bucket, latest.date),
        ]);

        let accounts = computeSnapshotGrowth(thenRows, nowRows);
        if (args.order === "least_grown") accounts = [...accounts].reverse();
        else if (args.order === "shrinking") accounts = accounts.filter((a) => a.growthBytes < 0);
        accounts = accounts.slice(0, args.limit);

        return toolJson({
          comparison:
            args.days != null ? `last ${args.days} days` : `${args.period}-over-${args.period}`,
          from_date: then.date,
          to_date: latest.date,
          account_count: accounts.length,
          accounts: accounts.map((a) => ({
            account: a.accountId,
            start_gb: gb(a.firstBytes),
            current_gb: gb(a.lastBytes),
            growth_gb: gb(a.growthBytes),
            growth_pct: a.growthPct == null ? null : Math.round(a.growthPct * 10) / 10,
            ...(a.isNew ? { new: true } : {}),
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── b2_egress_leaders ─────────────────────────────────────────────────────
  server.registerTool(
    "b2_egress_leaders",
    {
      description:
        "Rank top egress (downloaded bytes) by account or bucket over a period — default month-to-date. For 'who's downloading the most', 'where is egress concentrated'. Returns leaders with each one's share of total egress, from the daily usage reports. Scope follows the caller's key. Needs Usage Reports enabled.",
      inputSchema: {
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
    },
    async (args) => {
      try {
        const since = args.days != null ? daysAgo(args.days) : startOfMonthUTC();
        const rows = await loadReportRows(b2Client, await reportsBucketName(auth), since);
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
  server.registerTool(
    "b2_largest_files",
    {
      description:
        "List a bucket's largest objects by size via a live listing. For 'largest files', 'what's taking up space in <bucket>'. Give the bucket by name or bucketId; optional path prefix. Sorting by size requires a full listing, so on very large buckets the scan is bounded by max_scan and a time budget — it then returns the largest among the objects scanned with truncated=true; pass a prefix to focus on a subtree for a complete ranking. Returns name, size, and upload time — never contents.",
      inputSchema: {
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
        max_scan: z
          .number()
          .int()
          .min(1000)
          .max(500_000)
          .optional()
          .default(50_000)
          .describe(
            "Safety cap on objects scanned (default 50,000, max 500,000). Buckets with millions of files cannot be fully sorted by size in one live call; the scan stops at this cap (or a time budget) and returns truncated=true. Narrow with prefix for an exhaustive ranking of a subtree.",
          ),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveBucketName(b2Client, args.bucket);
        if (!resolved.name)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: resolved.candidates ?? [],
            note: resolved.candidates?.length
              ? "Multiple buckets match; pass an exact name or bucketId."
              : `No bucket matches '${args.bucket}'.`,
          });
        if (!resolved.id)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: [],
            note: `No bucket ID could be resolved for '${args.bucket}'.`,
          });

        // Bounded top-N by size — never accumulate every object. Sorting by size
        // also requires a full listing, so bound the WORK too: stop at max_scan
        // objects or a wall-clock budget, whichever comes first. Without this a
        // bucket with millions of files means thousands of sequential (billable,
        // rate-limited) LIST calls that run for minutes and time out. On a bound
        // hit we return what we have with truncated=true so the caller knows the
        // ranking covers only the objects scanned.
        const TIME_BUDGET_MS = 12_000;
        const startedAt = Date.now();
        const top: Array<{ name: string; size: number; uploaded?: Date }> = [];
        let smallest = -Infinity;
        let token: string | undefined;
        let scanned = 0;
        let truncated = false;
        let stopReason: "complete" | "max_scan" | "time_budget" = "complete";
        do {
          const page = await b2Client.listFileNames({
            bucketId: resolved.id,
            prefix: args.prefix,
            startFileName: token,
            maxFileCount: Math.min(Math.max(args.limit, 1000), 10_000),
          });
          for (const file of page.files ?? []) {
            const listed = b2Client.toListedFile(file);
            scanned++;
            const size = listed.size;
            if (top.length < args.limit || size > smallest) {
              top.push({ name: listed.name, size, uploaded: listed.uploadedAt });
              top.sort((a, b) => b.size - a.size);
              if (top.length > args.limit) top.pop();
              smallest = top[top.length - 1].size;
            }
          }
          token = page.nextFileName ?? undefined;
          if (token && scanned >= args.max_scan) {
            truncated = true;
            stopReason = "max_scan";
            break;
          }
          if (token && Date.now() - startedAt > TIME_BUDGET_MS) {
            truncated = true;
            stopReason = "time_budget";
            break;
          }
        } while (token);

        return toolJson({
          bucket: resolved.name,
          scanned,
          truncated,
          returned: top.length,
          ...(truncated
            ? {
                note:
                  stopReason === "max_scan"
                    ? `Stopped at the max_scan cap of ${args.max_scan.toLocaleString()} objects — these are the largest among those scanned, not the whole bucket. Pass a narrower prefix (or raise max_scan) for a more complete ranking.`
                    : `Stopped after a ${TIME_BUDGET_MS / 1000}s time budget (${scanned.toLocaleString()} objects scanned) — these are the largest among those scanned, not the whole bucket. Pass a narrower prefix to focus the scan.`,
              }
            : {}),
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
  server.registerTool(
    "b2_unfinished_uploads",
    {
      description:
        "Find abandoned multipart uploads that silently consume storage in a bucket. For 'bucket bloat', 'stuck/incomplete uploads', 'wasted storage'. Returns count, oldest upload age, and wasted bytes. Give the bucket by name or bucketId. Live listing, bounded by max_uploads and an internal time budget — on a very bloated bucket it returns a truncated result (and wasted_gb may be a lower bound) and recommends a lifecycle rule.",
      inputSchema: {
        bucket: z.string().describe("Bucket name or bucketId to inspect."),
        older_than_days: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only count uploads started more than this many days ago (optional)."),
        max_uploads: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .default(1000)
          .describe(
            "Safety cap on how many unfinished uploads to scan (default 1000, max 10,000). A bucket bloated with abandoned uploads would otherwise trigger an unbounded walk plus a per-upload parts fan-out that times out. If the cap or an internal time budget is hit, the result is truncated and wasted_gb may be a lower bound — add a lifecycle rule to auto-cancel unfinished large files.",
          ),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveBucketName(b2Client, args.bucket);
        if (!resolved.name)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: resolved.candidates ?? [],
            note: resolved.candidates?.length
              ? "Multiple buckets match; pass an exact name or bucketId."
              : `No bucket matches '${args.bucket}'.`,
          });
        if (!resolved.id)
          return toolJson({
            error: "bucket_not_uniquely_resolved",
            candidates: [],
            note: `No bucket ID could be resolved for '${args.bucket}'.`,
          });

        const cutoff =
          args.older_than_days != null ? Date.now() - args.older_than_days * 86400_000 : null;

        // Bound the work. A bucket bloated with abandoned uploads — exactly what
        // this tool hunts for — otherwise means an unbounded upload walk plus a
        // per-upload ListParts fan-out (O(uploads × parts)) of sequential,
        // rate-limited calls that hang and time out. Cap the uploads walked and
        // put an overall wall-clock budget over the parts summation; report
        // truncated / lower-bound results instead of failing.
        const TIME_BUDGET_MS = 12_000;
        const startedAt = Date.now();
        const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

        const uploads: Array<{ fileId: string; fileName: string; initiated?: Date }> = [];
        let fileIdMarker: string | undefined;
        let truncated = false;
        let stopReason: "complete" | "max_uploads" | "time_budget" = "complete";
        do {
          const page = await b2Client.listUnfinishedLargeFiles({
            bucketId: resolved.id,
            startFileId: fileIdMarker,
            maxFileCount: 100,
          });
          for (const file of page.files ?? []) {
            const listed = b2Client.toListedUnfinishedUpload(file);
            const initiated = dateFromTimestamp(listed.uploadTimestamp);
            if (cutoff != null && initiated && initiated.getTime() > cutoff) continue;
            uploads.push({ fileId: listed.fileId, fileName: listed.fileName, initiated });
          }
          fileIdMarker = page.nextFileId ?? undefined;
          if (fileIdMarker && uploads.length >= args.max_uploads) {
            truncated = true;
            stopReason = "max_uploads";
            break;
          }
          if (fileIdMarker && overBudget()) {
            truncated = true;
            stopReason = "time_budget";
            break;
          }
        } while (fileIdMarker);

        if (!uploads.length)
          return toolJson({
            bucket: resolved.name,
            unfinished_count: 0,
            note: "No abandoned multipart uploads found.",
          });

        // Sum already-uploaded part bytes for wasted storage; find the oldest.
        // The ListParts fan-out is the heaviest part, so stop summing once the
        // budget is hit and report wasted_gb as a lower bound (oldest stays exact
        // — finding it needs only the cheap upload list).
        let wasted = 0;
        let oldest = uploads[0];
        let wastedIsLowerBound = false;
        let sizedUploads = 0;
        for (const u of uploads) {
          if ((u.initiated?.getTime() ?? Infinity) < (oldest.initiated?.getTime() ?? Infinity))
            oldest = u;
          if (wastedIsLowerBound) continue; // budget hit — keep scanning for oldest only
          let partMarker: number | undefined;
          do {
            const parts = await b2Client.listParts({
              fileId: u.fileId,
              startPartNumber: partMarker,
              maxPartCount: 1000,
            });
            for (const p of parts.parts ?? []) wasted += b2Client.toListedPart(p).size;
            partMarker = parts.nextPartNumber ?? undefined;
          } while (partMarker != null);
          sizedUploads++;
          if (overBudget()) wastedIsLowerBound = true;
        }

        const lifecycleTip =
          "Add a lifecycle rule to auto-cancel unfinished large uploads (daysFromStartingToCancelingUnfinishedLargeFiles).";
        const lowerBoundTip = wastedIsLowerBound
          ? ` wasted_gb is a lower bound — stopped summing parts after a ${TIME_BUDGET_MS / 1000}s budget (sized ${sizedUploads} of ${uploads.length} uploads).`
          : "";
        const note = truncated
          ? stopReason === "max_uploads"
            ? `Stopped at the max_uploads cap of ${args.max_uploads.toLocaleString()} — the bucket has more abandoned uploads than shown.${lowerBoundTip} ${lifecycleTip}`
            : `Stopped after a ${TIME_BUDGET_MS / 1000}s time budget (${uploads.length.toLocaleString()} uploads found).${lowerBoundTip} ${lifecycleTip}`
          : wastedIsLowerBound
            ? `${lowerBoundTip.trim()} ${lifecycleTip}`
            : `Consider a lifecycle rule to auto-cancel unfinished large uploads (daysFromStartingToCancelingUnfinishedLargeFiles).`;

        return toolJson({
          bucket: resolved.name,
          unfinished_count: uploads.length,
          truncated,
          wasted_gb: gb(wasted),
          ...(wastedIsLowerBound
            ? { wasted_is_lower_bound: true, sized_uploads: sizedUploads }
            : {}),
          oldest_started_at: oldest.initiated,
          oldest_file: oldest.fileName,
          note,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
