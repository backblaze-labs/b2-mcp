#!/usr/bin/env node

/* global console, process */

// Control-band detector (Node port of the playbook's detect.py).
// Reads readings (oldest first) from stdin as a JSON list and prints the worst
// tier the newest reading falls in, as JSON. Only the high side matters.
// The baseline is every reading before the newest one.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** In the metric's own units; stops a flat baseline turning every blip into a breach. */
export const MIN_SIGMA = 0.05;
/** Readings needed before the newest one. */
export const MIN_BASELINE = 14;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function countAbove(readings, line, last) {
  return readings.slice(-last).filter((reading) => reading > line).length;
}

/**
 * Classifies the newest reading against the control bands of the earlier ones.
 * @param {number[]} readings - Oldest first.
 */
export function tier(readings) {
  if (
    !Array.isArray(readings) ||
    readings.some((r) => typeof r !== "number" || !Number.isFinite(r))
  ) {
    throw new Error("readings must be a JSON list of finite numbers");
  }
  const baseline = readings.slice(0, -1);
  if (baseline.length < MIN_BASELINE) {
    throw new Error(`need at least ${MIN_BASELINE} readings before the newest one`);
  }
  const m = mean(baseline);
  const sigma = Math.max(stdev(baseline), MIN_SIGMA);
  const reading = readings.at(-1);
  const rules = [
    ["3sigma", "reading above 3 sigma", reading > m + 3 * sigma],
    ["2sigma", "reading above 2 sigma", reading > m + 2 * sigma],
    ["2sigma", "drift: 4 of 5 readings above 1 sigma", countAbove(readings, m + sigma, 5) >= 4],
    ["2sigma", "drift: 8 readings in a row above the mean", countAbove(readings, m, 8) >= 8],
    ["1sigma", "reading above 1 sigma", reading > m + sigma],
  ];
  const stats = {
    reading,
    mean: Math.round(m * 10000) / 10000,
    sigma: Math.round(sigma * 10000) / 10000,
  };
  const hit = rules.find(([, , tripped]) => tripped);
  return hit ? { tier: hit[0], rule: hit[1], ...stats } : { tier: "none", ...stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(tier(JSON.parse(readFileSync(0, "utf8")))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
