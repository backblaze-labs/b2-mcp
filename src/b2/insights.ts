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
 *
 * @packageDocumentation
 */
import type { ToolRegistrar } from "../mcp.js";
import { z } from "zod";
import {
  B2Client,
  type FileVersionResult,
  type ListFileNamesResult,
  type ListPartsResult,
  type ListUnfinishedLargeFilesResult,
  type PartInfoResult,
  type UnfinishedLargeFileResult,
} from "./client.js";
import { B2ReportClient, type ReportObjectClient } from "./report-client.js";
import { B2AuthManager } from "../auth.js";
import { toolJson, toolError } from "../utils/errors.js";
import { dateFromTimestamp } from "../utils/date.js";
import { abortError, timeoutError } from "../utils/named-error.js";
import { currentMcpRequestSignal, runWithMcpRequestSignal } from "../request-context.js";

const GB = 1e9; // report columns are GB = 1e9 bytes

// ── CSV parsing ─────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180 parser: handles quoted fields, embedded commas, and "" escapes.
 *
 * @param text - CSV text with a header row.
 *
 * @returns Parsed data rows keyed by CSV header names.
 */
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
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

/**
 * Normalize a report date to YYYY-MM-DD (the partner CSV sometimes uses M/D/YY).
 *
 * @param raw - Raw report date string.
 *
 * @returns The normalized date, or null when the value cannot be parsed.
 */
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

/** Normalized row from a Backblaze usage report CSV. */
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

/**
 * Convert a raw CSV object into a normalized usage report row.
 *
 * @param raw - Header-keyed CSV row from {@link parseCsv}.
 *
 * @returns Normalized row, or `null` when required account/date fields are absent.
 */
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

/**
 * Compute stored-data growth by account across all supplied report rows.
 *
 * @remarks
 * This helper is retained for compatibility with earlier insight behavior. New
 * usage-growth tooling prefers snapshot boundary comparisons so point-in-time
 * `stored_gb` values are not summed across days.
 *
 * @param rows - Normalized usage report rows.
 *
 * @returns Growth rows sorted by descending stored-byte growth.
 */
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

/**
 * Aggregate egress bytes by account or bucket.
 *
 * @param rows - Normalized usage report rows.
 * @param by - Grouping dimension for the aggregate.
 *
 * @returns Egress totals sorted descending.
 */
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

const REPORT_SCAN_LIMITS = {
  maxPages: 100,
  maxCandidateKeys: 5_000,
  maxSelectedKeys: 1_000,
  maxDownloadedBytes: 25 * 1024 * 1024,
  maxRows: 100_000,
  maxElapsedMs: 12_000,
  maxKeysPerPage: 1000,
  // Keep downloads serial so the global maxDownloadedBytes budget is strict.
  concurrency: 1,
};

/** Counters captured while scanning and downloading usage reports. */
interface ReportLoadStats {
  /** Report list pages visited. */
  pages: number;
  /** Object keys listed from the report bucket. */
  listed_keys: number;
  /** Keys matching the report prefix/date filters. */
  candidate_keys: number;
  /** Candidate keys selected for download. */
  selected_keys: number;
  /** Report objects downloaded. */
  downloaded_keys: number;
  /** Raw report bytes downloaded. */
  downloaded_bytes: number;
  /** CSV rows parsed from downloaded reports. */
  parsed_rows: number;
  /** Reason scanning stopped before exhausting all candidates. */
  stop_reason?: string;
}

interface ReportRowsResult {
  rows: ReportRow[];
  truncated: boolean;
  stats: ReportLoadStats;
}

/** Mutable scan budget shared by report-key listing and CSV downloads. */
interface ReportScanBudget {
  /** Scan start time in epoch milliseconds. */
  startedAt: number;
  /** Mutable counters for the current scan. */
  stats: ReportLoadStats;
}

function newReportStats(): ReportLoadStats {
  return {
    pages: 0,
    listed_keys: 0,
    candidate_keys: 0,
    selected_keys: 0,
    downloaded_keys: 0,
    downloaded_bytes: 0,
    parsed_rows: 0,
  };
}

function stopReportScan(stats: ReportLoadStats, reason: string): void {
  stats.stop_reason ??= reason;
}

function createReportScanBudget(): ReportScanBudget {
  return { startedAt: Date.now(), stats: newReportStats() };
}

function reportScanTimedOut(budget: ReportScanBudget): boolean {
  return Date.now() - budget.startedAt >= REPORT_SCAN_LIMITS.maxElapsedMs;
}

function reportScanRemainingMs(budget: ReportScanBudget): number {
  return Math.max(1, REPORT_SCAN_LIMITS.maxElapsedMs - (Date.now() - budget.startedAt));
}

function ensureReportPageBudget(budget: ReportScanBudget): boolean {
  if (reportScanTimedOut(budget)) {
    stopReportScan(budget.stats, "time_budget");
    return false;
  }
  if (budget.stats.pages >= REPORT_SCAN_LIMITS.maxPages) {
    stopReportScan(budget.stats, "max_pages");
    return false;
  }
  return true;
}

function reportScanMetadataFromStats(stats: ReportLoadStats): Record<string, unknown> {
  return {
    ...(stats.stop_reason ? { truncated: true, partial: true } : {}),
    report_scan: {
      pages: stats.pages,
      listed_keys: stats.listed_keys,
      candidate_keys: stats.candidate_keys,
      selected_keys: stats.selected_keys,
      downloaded_keys: stats.downloaded_keys,
      downloaded_mb: Math.round((stats.downloaded_bytes / 1024 / 1024) * 10) / 10,
      parsed_rows: stats.parsed_rows,
      ...(stats.stop_reason ? { stop_reasons: [stats.stop_reason] } : {}),
    },
  };
}

function reportScanMetadata(...loads: ReportRowsResult[]): Record<string, unknown> {
  const totals = loads.reduce((acc, load) => {
    acc.pages += load.stats.pages;
    acc.listed_keys += load.stats.listed_keys;
    acc.candidate_keys += load.stats.candidate_keys;
    acc.selected_keys += load.stats.selected_keys;
    acc.downloaded_keys += load.stats.downloaded_keys;
    acc.downloaded_bytes += load.stats.downloaded_bytes;
    acc.parsed_rows += load.stats.parsed_rows;
    if (load.stats.stop_reason) acc.stop_reason ??= load.stats.stop_reason;
    return acc;
  }, newReportStats());
  return reportScanMetadataFromStats(totals);
}

/**
 * The reserved daily-report bucket name for the caller: `b2-reports-<accountId>`.
 * This bucket is "Restricted" and B2 HIDES it from b2_list_buckets even for
 * full-capability, account-wide keys — so we construct the name directly rather
 * than try to discover it by listing. Existence is then probed by the S3 read in
 * loadReportRows (a 404 on the bucket → Usage Reports not enabled).
 *
 * @returns The reserved usage-report bucket name for the authorized account.
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
 *
 * @param keys - Candidate report object keys.
 *
 * @returns The report object keys that should be treated as usage data.
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

/**
 * List + download the Usage CSVs within the window and return mapped rows.
 * Returns null when the bucket does not exist (reports not enabled).
 *
 * @returns The mapped report rows, or null when reports are not enabled.
 */
async function loadReportRows(
  reportClient: ReportObjectClient,
  bucketName: string,
  sinceDate: string,
  budget: ReportScanBudget = createReportScanBudget(),
): Promise<ReportRowsResult | null> {
  const keyRe = /^\d{4}-\d{2}-\d{2}\/.+\.csv$/;
  const keys: string[] = [];
  let token: string | undefined;
  const { stats } = budget;
  try {
    do {
      if (!ensureReportPageBudget(budget)) break;
      const page = await reportClient.listReportObjectKeys(bucketName, {
        // StartAfter skips every key before the window (keys are date-prefixed
        // and sort lexically), so a long-lived report bucket isn't fully scanned.
        // StartAfter applies to the first page only; ContinuationToken drives the rest.
        startAfter: sinceDate,
        continuationToken: token,
        maxKeys: REPORT_SCAN_LIMITS.maxKeysPerPage,
        timeoutMs: reportScanRemainingMs(budget),
      });
      stats.pages++;
      stats.listed_keys += page.keys.length;
      for (const k of page.keys) {
        if (!keyRe.test(k) || k.slice(0, 10) < sinceDate) continue;
        if (keys.length >= REPORT_SCAN_LIMITS.maxCandidateKeys) {
          stopReportScan(stats, "max_candidate_keys");
          break;
        }
        keys.push(k);
      }
      stats.candidate_keys = keys.length;
      token = page.isTruncated ? page.nextContinuationToken : undefined;
      if (stats.stop_reason) break;
    } while (token);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchBucket" || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }

  return loadRowsFromReportKeys(reportClient, bucketName, keys, budget);
}

async function loadRowsFromReportKeys(
  reportClient: ReportObjectClient,
  bucketName: string,
  keys: string[],
  budget: ReportScanBudget,
): Promise<ReportRowsResult> {
  const { stats } = budget;
  const selectedKeys = selectUsageKeys(keys);
  const boundedKeys = selectedKeys.slice(0, REPORT_SCAN_LIMITS.maxSelectedKeys);
  const selectedKeysWereCapped = selectedKeys.length > boundedKeys.length;
  stats.selected_keys = boundedKeys.length;

  const rows: ReportRow[] = [];
  let next = 0;
  let stopDownloads = stats.stop_reason === "time_budget";

  const worker = async () => {
    while (next < boundedKeys.length && !stopDownloads) {
      if (reportScanTimedOut(budget)) {
        stopReportScan(stats, "time_budget");
        stopDownloads = true;
        return;
      }
      const key = boundedKeys[next++];
      const remainingBytes = REPORT_SCAN_LIMITS.maxDownloadedBytes - stats.downloaded_bytes;
      if (remainingBytes <= 0) {
        stopReportScan(stats, "max_downloaded_bytes");
        stopDownloads = true;
        return;
      }
      const download = await reportClient.downloadReportObjectText(bucketName, key, {
        maxBytes: remainingBytes,
        timeoutMs: reportScanRemainingMs(budget),
      });
      const { text, bytes, truncated } = download;
      stats.downloaded_keys++;
      stats.downloaded_bytes += bytes;
      if (truncated || stats.downloaded_bytes > REPORT_SCAN_LIMITS.maxDownloadedBytes) {
        stopReportScan(stats, "max_downloaded_bytes");
        stopDownloads = true;
        return;
      }
      for (const raw of parseCsv(text)) {
        const mapped = mapRow(raw);
        if (!mapped) continue;
        if (rows.length >= REPORT_SCAN_LIMITS.maxRows) {
          stopReportScan(stats, "max_rows");
          stopDownloads = true;
          return;
        }
        rows.push(mapped);
        stats.parsed_rows++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REPORT_SCAN_LIMITS.concurrency, boundedKeys.length) }, worker),
  );
  if (selectedKeysWereCapped && !stats.stop_reason) stopReportScan(stats, "max_selected_keys");

  return {
    rows,
    truncated: stats.stop_reason !== undefined,
    stats,
  };
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

// ── Snapshot growth (point-in-time stored_gb at two dates) ──────────────────
// Per Backblaze's Usage Report spec, stored_gb is "bytes stored in gigabytes
// (at the end of the day)" — a point-in-time snapshot — so growth is the
// difference between the latest snapshot and the snapshot one period earlier.
// We fetch ONLY those two boundary days (Prefix/StartAfter-scoped listings),
// never the whole report bucket.

/** Snapshot comparison period accepted by usage-growth helpers. */
export type Period = "month" | "quarter" | "year";

/**
 * Date one period before `from` (UTC), day-clamped for short months
 *  (e.g. Mar 31 minus one month → Feb 28/29, not Mar 3).
 *
 * @param period - Lookback period to subtract.
 * @param from - UTC anchor date for the comparison.
 *
 * @returns The period start date in YYYY-MM-DD format.
 */
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

/**
 * Date of the nearest available daily snapshot at or after `target`.
 *  `{ bucketMissing: true }` ⇒ reports bucket absent (not enabled).
 *
 * @returns The matching snapshot date and whether the reports bucket is missing.
 */
async function nearestSnapshotDate(
  reportClient: ReportObjectClient,
  bucketName: string,
  target: string,
  budget: ReportScanBudget = createReportScanBudget(),
): Promise<{ date: string | null; bucketMissing: boolean }> {
  try {
    if (!ensureReportPageBudget(budget)) return { date: null, bucketMissing: false };
    const page = await reportClient.listReportObjectKeys(bucketName, {
      startAfter: target,
      maxKeys: 1,
      timeoutMs: reportScanRemainingMs(budget),
    });
    budget.stats.pages++;
    budget.stats.listed_keys += page.keys.length;
    return { date: snapshotDateOf(page.keys[0] ?? ""), bucketMissing: false };
  } catch (e) {
    if (is404(e)) return { date: null, bucketMissing: true };
    throw e;
  }
}

/**
 * Date of the latest available snapshot (most recent day on or before today).
 *  Lists only recent days via StartAfter, widening if reporting is stale.
 *
 * @param reportClient - Client capable of listing report object keys.
 * @param bucketName - B2 reports bucket name.
 * @param today - Date used as the current-day search anchor.
 * @param budget - Optional scan budget for tests and bounded runtime.
 *
 * @returns The latest snapshot date and whether the reports bucket is missing.
 *
 * @internal
 */
export async function latestSnapshotDate(
  reportClient: ReportObjectClient,
  bucketName: string,
  today: Date,
  budget: ReportScanBudget = createReportScanBudget(),
): Promise<{ date: string | null; bucketMissing: boolean }> {
  for (const lookback of [10, 45, 180]) {
    const after = new Date(today.getTime() - lookback * 86400_000).toISOString().slice(0, 10);
    let token: string | undefined;
    let max: string | null = null;
    try {
      do {
        if (!ensureReportPageBudget(budget)) break;
        const page = await reportClient.listReportObjectKeys(bucketName, {
          startAfter: after,
          continuationToken: token,
          maxKeys: REPORT_SCAN_LIMITS.maxKeysPerPage,
          timeoutMs: reportScanRemainingMs(budget),
        });
        budget.stats.pages++;
        budget.stats.listed_keys += page.keys.length;
        for (const key of page.keys) {
          const d = snapshotDateOf(key);
          if (d && (max === null || d > max)) max = d;
        }
        token = page.isTruncated ? page.nextContinuationToken : undefined;
        if (budget.stats.stop_reason) break;
      } while (token);
    } catch (e) {
      if (is404(e)) return { date: null, bucketMissing: true };
      throw e;
    }
    if (max) return { date: max, bucketMissing: false };
    if (budget.stats.stop_reason) break;
  }
  return { date: null, bucketMissing: false };
}

/**
 * All usage rows for a single day folder (summed across that day's region files).
 *
 * @param reportClient - Client capable of listing and downloading report objects.
 * @param bucketName - B2 reports bucket name.
 * @param dayDate - Day folder to read in YYYY-MM-DD format.
 *
 * @returns The mapped usage rows for that day.
 */
export async function loadDayRows(
  reportClient: ReportObjectClient,
  bucketName: string,
  dayDate: string,
): Promise<ReportRow[]> {
  return (await loadDayRowsBounded(reportClient, bucketName, dayDate)).rows;
}

async function loadDayRowsBounded(
  reportClient: ReportObjectClient,
  bucketName: string,
  dayDate: string,
  budget: ReportScanBudget = createReportScanBudget(),
): Promise<ReportRowsResult> {
  const keys: string[] = [];
  let token: string | undefined;
  const { stats } = budget;
  do {
    if (!ensureReportPageBudget(budget)) break;
    const page = await reportClient.listReportObjectKeys(bucketName, {
      prefix: `${dayDate}/`,
      continuationToken: token,
      maxKeys: REPORT_SCAN_LIMITS.maxKeysPerPage,
      timeoutMs: reportScanRemainingMs(budget),
    });
    stats.pages++;
    stats.listed_keys += page.keys.length;
    for (const k of page.keys) {
      if (!/\.csv$/i.test(k)) continue;
      if (keys.length >= REPORT_SCAN_LIMITS.maxCandidateKeys) {
        stopReportScan(stats, "max_candidate_keys");
        break;
      }
      keys.push(k);
    }
    stats.candidate_keys = keys.length;
    token = page.isTruncated ? page.nextContinuationToken : undefined;
    if (stats.stop_reason) break;
  } while (token);
  return loadRowsFromReportKeys(reportClient, bucketName, keys, budget);
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

/** Stored-data growth for one account between two daily snapshots. */
export interface SnapshotGrowth {
  accountId: string;
  firstBytes: number;
  lastBytes: number;
  growthBytes: number;
  growthPct: number | null;
  isNew: boolean;
}

/**
 * Per-account stored-data growth between two snapshots. Accounts present only
 *  in `now` are new (no % baseline); present only in `then` shrank toward zero.
 *
 * @param thenRows - Earlier snapshot rows.
 * @param nowRows - Later snapshot rows.
 *
 * @returns Growth rows sorted by descending stored-byte growth.
 */
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

/**
 * Resolve a bucket from the authorize response's `allowedBuckets` scope. A
 * bucket-scoped key cannot call the unfiltered `listBuckets()` (no `listBuckets`
 * capability, so B2 answers 401), but its id (and usually name) is in scope.
 * Returns null for unrestricted keys so the caller falls back to a live listing.
 *
 * The scope is read from `B2AuthManager`'s ~23h cache, so a rename can briefly
 * miss by new name or display a stale name by id. This self-heals within the
 * token TTL and never targets the wrong bucket (object ops use the resolved id).
 *
 * Matching mirrors `resolveBucketName()`: exact name/id, else substring. It never
 * echoes the whole scope on a miss, since a `server`/`principal` HTTP caller does
 * not hold the key and could otherwise enumerate its full bucket namespace.
 *
 * @returns The resolved bucket, in-scope candidates, or null for unrestricted keys.
 */
async function resolveFromAuthorizedScope(
  auth: B2AuthManager,
  input: string,
): Promise<{ name?: string; id?: string; candidates?: string[]; outOfScope?: boolean } | null> {
  const { allowedBuckets } = await auth.getAuth();
  if (!allowedBuckets || allowedBuckets.length === 0) return null;
  // Blank input substring-matches every bucket; treat it as a miss so
  // `includes("")` cannot enumerate the scope (schemas also reject empty input).
  if (input.trim() === "") return { outOfScope: true };
  const exact = allowedBuckets.find((b) => b.name === input || b.id === input);
  // A name-restricted key may report a null name; matched by id, display the input.
  if (exact) return { name: exact.name ?? input, id: exact.id };
  // No exact hit: surface only partially-matching names, never the full scope. A
  // fully-unrelated input flags outOfScope so the error says so without leaking names.
  const subs = allowedBuckets.filter((b) => b.name?.includes(input));
  if (subs.length === 1 && subs[0].name) return { name: subs[0].name, id: subs[0].id };
  if (subs.length > 1) {
    return { candidates: subs.map((b) => b.name).filter((n): n is string => Boolean(n)) };
  }
  return { outOfScope: true };
}

/** Resolve a bucket name/id pair from a name-or-bucketId input. */
async function resolveBucketName(
  b2Client: B2Client,
  auth: B2AuthManager,
  input: string,
): Promise<{ name?: string; id?: string; candidates?: string[]; outOfScope?: boolean }> {
  const scoped = await resolveFromAuthorizedScope(auth, input);
  if (scoped) return scoped;
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

function bucketResolutionError(
  input: string,
  resolved: { name?: string; id?: string; candidates?: string[]; outOfScope?: boolean },
): Record<string, unknown> | null {
  if (!resolved.name) {
    return {
      error: "bucket_not_uniquely_resolved",
      candidates: resolved.candidates ?? [],
      note: resolved.candidates?.length
        ? "Multiple buckets match; pass an exact name or bucketId."
        : resolved.outOfScope
          ? `Bucket '${input}' is not in the key's authorized scope (or does not exist).`
          : `No bucket matches '${input}'.`,
    };
  }
  if (!resolved.id) {
    return {
      error: "bucket_id_unavailable",
      candidates: [],
      note: `No bucket ID could be resolved for '${input}'.`,
    };
  }
  return null;
}

function toListedFile(file: FileVersionResult): { name: string; size: number; uploadedAt?: Date } {
  return {
    name: file.fileName,
    size: file.contentLength,
    uploadedAt: dateFromTimestamp(file.uploadTimestamp),
  };
}

function toListedUnfinishedUpload(file: UnfinishedLargeFileResult): {
  fileId: string;
  fileName: string;
  uploadTimestamp?: number;
} {
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    uploadTimestamp: file.uploadTimestamp,
  };
}

function toListedPart(part: PartInfoResult): { partNumber: number; size: number } {
  return {
    partNumber: part.partNumber,
    size: part.contentLength,
  };
}

function matchingUnfinishedUploads(
  files: readonly UnfinishedLargeFileResult[],
  cutoff: number | null,
): Array<{ fileId: string; fileName: string; initiated?: Date }> {
  const matches: Array<{ fileId: string; fileName: string; initiated?: Date }> = [];
  for (const file of files) {
    const listed = toListedUnfinishedUpload(file);
    const initiated = dateFromTimestamp(listed.uploadTimestamp);
    if (cutoff != null && initiated && initiated.getTime() > cutoff) continue;
    matches.push({ fileId: listed.fileId, fileName: listed.fileName, initiated });
  }
  return matches;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: unknown }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

function isInsightDeadlineError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
  );
}

async function withNativeInsightDeadline<T>(
  startedAt: number,
  budgetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const remaining = budgetMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw timeoutError("B2 insight scan timed out");
  }

  const parent = currentMcpRequestSignal();
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent?.reason ?? abortError());
  };
  const timer = setTimeout(() => {
    controller.abort(timeoutError("B2 insight scan timed out"));
  }, remaining);
  unrefTimer(timer);

  if (parent?.aborted === true) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await runWithMcpRequestSignal(controller.signal, fn);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abortFromParent);
  }
}

// ── Tool registration ───────────────────────────────────────────────────────

/**
 * Register read-only storage-activity insight tools.
 *
 * @remarks
 * Usage growth and egress leaders read preexisting B2 usage-report CSVs when
 * available; largest-file and unfinished-upload tools use bounded live listings.
 * All work remains scoped to the caller's configured credentials.
 *
 * @param server - Tool registrar receiving insight tools.
 * @param b2Client - B2 native client for bucket resolution and live listings.
 * @param auth - B2 auth manager used to derive the reports bucket.
 * @param reportClient - Optional report client override for tests.
 *
 * @example
 * ```ts
 * registerInsightTools(registrar, b2Client, auth, reportClient);
 * ```
 */
export function registerInsightTools(
  server: ToolRegistrar,
  b2Client: B2Client,
  auth: B2AuthManager,
  reportClient: ReportObjectClient = new B2ReportClient(auth),
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
        const reportBudget = createReportScanBudget();
        const today = new Date();
        const targetThen =
          args.days != null ? daysAgo(args.days) : periodStartDate(args.period, today);

        const latest = await latestSnapshotDate(reportClient, bucket, today, reportBudget);
        if (latest.bucketMissing) return toolJson(NOT_ENABLED);
        if (!latest.date)
          return toolJson({
            reports_enabled: true,
            note: "No usage-report snapshots found yet.",
            ...reportScanMetadataFromStats(reportBudget.stats),
          });

        const then = await nearestSnapshotDate(reportClient, bucket, targetThen, reportBudget);
        if (then.bucketMissing) return toolJson(NOT_ENABLED);
        if (!then.date || then.date >= latest.date)
          return toolJson({
            reports_enabled: true,
            note:
              `Not enough report history to compare: latest snapshot is ${latest.date}, with no ` +
              `earlier snapshot at or after the requested ${targetThen}.`,
            latest_snapshot: latest.date,
            ...reportScanMetadataFromStats(reportBudget.stats),
          });

        const thenRows = await loadDayRowsBounded(reportClient, bucket, then.date, reportBudget);
        const nowRows = await loadDayRowsBounded(reportClient, bucket, latest.date, reportBudget);

        let accounts = computeSnapshotGrowth(thenRows.rows, nowRows.rows);
        if (args.order === "least_grown") accounts = [...accounts].reverse();
        else if (args.order === "shrinking") accounts = accounts.filter((a) => a.growthBytes < 0);
        accounts = accounts.slice(0, args.limit);

        return toolJson({
          comparison:
            args.days != null ? `last ${args.days} days` : `${args.period}-over-${args.period}`,
          from_date: then.date,
          to_date: latest.date,
          account_count: accounts.length,
          ...reportScanMetadataFromStats(reportBudget.stats),
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
        const loaded = await loadReportRows(reportClient, await reportsBucketName(auth), since);
        if (loaded === null) return toolJson(NOT_ENABLED);
        const leaders = computeEgressLeaders(loaded.rows, args.by);
        const total = leaders.reduce((s, l) => s + l.egress, 0);
        const top = leaders.slice(0, args.limit);
        return toolJson({
          period: args.days != null ? `last ${args.days} days` : "current month to date",
          rank_by: args.by,
          total_egress_gb: gb(total),
          ...reportScanMetadata(loaded),
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
        bucket: z.string().min(1).describe("Bucket name or bucketId to inspect."),
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
        const resolved = await resolveBucketName(b2Client, auth, args.bucket);
        const resolutionError = bucketResolutionError(args.bucket, resolved);
        if (resolutionError) return toolJson(resolutionError);
        const resolvedBucketName = resolved.name!;
        const resolvedBucketId = resolved.id!;

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
          let page: ListFileNamesResult;
          try {
            page = await withNativeInsightDeadline(startedAt, TIME_BUDGET_MS, () =>
              b2Client.listFileNames({
                bucketId: resolvedBucketId,
                prefix: args.prefix,
                startFileName: token,
                maxFileCount: Math.min(Math.max(args.limit, 1000), 10_000),
              }),
            );
          } catch (err) {
            if (!isInsightDeadlineError(err)) throw err;
            truncated = true;
            stopReason = "time_budget";
            break;
          }
          const files = page.files ?? [];
          let pageExhausted = true;
          for (const file of files) {
            if (scanned >= args.max_scan) {
              truncated = true;
              stopReason = "max_scan";
              pageExhausted = false;
              break;
            }
            const listed = toListedFile(file);
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
          if (scanned >= args.max_scan && (token || !pageExhausted)) {
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
          bucket: resolvedBucketName,
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
        bucket: z.string().min(1).describe("Bucket name or bucketId to inspect."),
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
        const resolved = await resolveBucketName(b2Client, auth, args.bucket);
        const resolutionError = bucketResolutionError(args.bucket, resolved);
        if (resolutionError) return toolJson(resolutionError);
        const resolvedBucketName = resolved.name!;
        const resolvedBucketId = resolved.id!;

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
          let page: ListUnfinishedLargeFilesResult;
          try {
            page = await withNativeInsightDeadline(startedAt, TIME_BUDGET_MS, () =>
              b2Client.listUnfinishedLargeFiles({
                bucketId: resolvedBucketId,
                startFileId: fileIdMarker,
                maxFileCount: 100,
              }),
            );
          } catch (err) {
            if (!isInsightDeadlineError(err)) throw err;
            truncated = true;
            stopReason = "time_budget";
            break;
          }
          const matchingUploads = matchingUnfinishedUploads(page.files ?? [], cutoff);
          const availableSlots = Math.max(0, args.max_uploads - uploads.length);
          uploads.push(...matchingUploads.slice(0, availableSlots));
          fileIdMarker = page.nextFileId ?? undefined;
          const hitUploadCap =
            matchingUploads.length > availableSlots ||
            (fileIdMarker !== undefined && uploads.length >= args.max_uploads);
          if (hitUploadCap) {
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
            bucket: resolvedBucketName,
            unfinished_count: 0,
            truncated,
            note: truncated
              ? `Stopped after a ${TIME_BUDGET_MS / 1000}s time budget before abandoned multipart uploads could be fully scanned.`
              : "No abandoned multipart uploads found.",
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
          let completedPartScan = true;
          do {
            let parts: ListPartsResult;
            try {
              parts = await withNativeInsightDeadline(startedAt, TIME_BUDGET_MS, () =>
                b2Client.listParts({
                  fileId: u.fileId,
                  startPartNumber: partMarker,
                  maxPartCount: 1000,
                }),
              );
            } catch (err) {
              if (!isInsightDeadlineError(err)) throw err;
              wastedIsLowerBound = true;
              completedPartScan = false;
              break;
            }
            for (const p of parts.parts ?? []) wasted += toListedPart(p).size;
            partMarker = parts.nextPartNumber ?? undefined;
          } while (partMarker != null);
          if (completedPartScan) sizedUploads++;
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
          bucket: resolvedBucketName,
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
