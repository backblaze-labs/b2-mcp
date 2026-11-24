#!/usr/bin/env node

/* global console, fetch, process */

// Builds daily CI failure rates for pushes to main from the GitHub Actions API.
// Prints a JSON list (oldest first) for detect.mjs. Days without runs are left
// out, and so is the current UTC day, which is still incomplete. Needs
// GITHUB_TOKEN with actions: read and GITHUB_REPOSITORY.

import { pathToFileURL } from "node:url";

/**
 * Groups completed workflow runs by UTC day and returns failure rates, oldest first.
 * Runs from the UTC day of `now` or later are dropped so a partial day is never
 * compared with full-day baselines.
 * @param {Array<{created_at: string, conclusion: string | null}>} runs
 * @param {Date} [now]
 */
export function dailyFailureRates(runs, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const days = new Map();
  for (const run of runs) {
    if (run.conclusion === null || run.conclusion === "cancelled" || run.conclusion === "skipped") {
      continue;
    }
    const day = run.created_at.slice(0, 10);
    if (day >= today) continue;
    const entry = days.get(day) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (run.conclusion !== "success") entry.failed += 1;
    days.set(day, entry);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, { total, failed }]) => Math.round((failed / total) * 10000) / 10000);
}

async function fetchRuns({ repository, token, workflow, days }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const runs = [];
  for (let page = 1; ; page += 1) {
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?branch=main&event=push&status=completed&per_page=100&page=${page}&created=>=${since}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
    const body = await response.json();
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) return runs;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
  if (!token || !repository) {
    console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
    process.exit(1);
  }
  fetchRuns({ repository, token, workflow: "test.yml", days: 90 })
    .then((runs) => console.log(JSON.stringify(dailyFailureRates(runs))))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
