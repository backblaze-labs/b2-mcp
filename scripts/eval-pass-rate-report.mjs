import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROVIDER_SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const RAW_PAYLOAD_KEYS = new Set(["run", "toolCalls", "toolResults", "text"]);
const RESULT_STATUSES = new Set(["passed", "failed", "errored"]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) fail(`${path} must be a non-negative integer`);
}

function assertPassRate(value, path) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be a finite number between 0 and 1`);
  }
}

function findRawPayloadField(value, path = "$") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRawPayloadField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RAW_PAYLOAD_KEYS.has(key)) return childPath;
    const found = findRawPayloadField(child, childPath);
    if (found) return found;
  }
  return null;
}

export function readReportFile(path) {
  const raw = readFileSync(path, "utf8");
  return { raw, report: JSON.parse(raw) };
}

export function providerSecretValuesFromEnv(env = process.env) {
  return PROVIDER_SECRET_ENV_NAMES.map((name) => env[name]).filter(Boolean);
}

export function assertNoProviderSecrets(raw, secretValues) {
  for (const secret of [...new Set(secretValues.filter(Boolean))]) {
    if (raw.includes(secret)) fail("pass-rate report contains a provider secret value");
  }
}

export function validateProviderPassRateReport(report) {
  if (!isRecord(report)) fail("report must be an object");
  if (report.schemaVersion !== 1) fail("report.schemaVersion must be 1");
  assertString(report.generatedAt, "report.generatedAt");
  assertNonNegativeInteger(report.caseCount, "report.caseCount");
  assertString(report.summary, "report.summary");

  if (!Array.isArray(report.providers) || report.providers.length === 0) {
    fail("report.providers must be a non-empty array");
  }
  for (const [index, provider] of report.providers.entries()) {
    const path = `report.providers[${index}]`;
    if (!isRecord(provider)) fail(`${path} must be an object`);
    assertString(provider.provider, `${path}.provider`);
    assertString(provider.model, `${path}.model`);
    assertNonNegativeInteger(provider.passed, `${path}.passed`);
    assertNonNegativeInteger(provider.total, `${path}.total`);
    if (provider.passed > provider.total) fail(`${path}.passed must not exceed total`);
    assertPassRate(provider.passRate, `${path}.passRate`);
  }

  if (!Array.isArray(report.results)) fail("report.results must be an array");
  for (const [index, result] of report.results.entries()) {
    const path = `report.results[${index}]`;
    if (!isRecord(result)) fail(`${path} must be an object`);
    assertString(result.provider, `${path}.provider`);
    assertString(result.caseName, `${path}.caseName`);
    if (!RESULT_STATUSES.has(result.status)) fail(`${path}.status is invalid`);
    if (typeof result.passed !== "boolean") fail(`${path}.passed must be boolean`);
    if (result.status === "failed" && typeof result.failure !== "string") {
      fail(`${path}.failure must be present for failed results`);
    }
    if (result.status === "errored" && typeof result.error !== "string") {
      fail(`${path}.error must be present for errored results`);
    }
  }

  if (!isRecord(report.sensitivity)) fail("report.sensitivity must be an object");
  if (report.sensitivity.secretSafe !== true) fail("report.sensitivity.secretSafe must be true");
  if (
    !Array.isArray(report.sensitivity.omitted) ||
    report.sensitivity.omitted.length === 0 ||
    !report.sensitivity.omitted.every((value) => typeof value === "string" && value.length > 0)
  ) {
    fail("report.sensitivity.omitted must be a non-empty string array");
  }

  const rawField = findRawPayloadField(report);
  if (rawField) fail(`pass-rate report includes raw payload field ${rawField}`);
  return report;
}

export function validateReportFile(path, options = {}) {
  const { raw, report } = readReportFile(path);
  assertNoProviderSecrets(raw, options.secretValues ?? []);
  return validateProviderPassRateReport(report);
}

export function renderPassRateSummaryMarkdown(report) {
  validateProviderPassRateReport(report);
  const lines = [
    "## Claude vs OpenAI pass rates",
    "",
    report.summary,
    "",
    "| Provider | Model | Passed | Total | Pass rate |",
    "| --- | --- | ---: | ---: | ---: |",
    ...report.providers.map((provider) => {
      const pct = `${(provider.passRate * 100).toFixed(1)}%`;
      return `| ${provider.provider} | ${provider.model} | ${provider.passed} | ${provider.total} | ${pct} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

function usage() {
  return "Usage: node scripts/eval-pass-rate-report.mjs <validate|summary> <report.json>";
}

function main(argv = process.argv.slice(2)) {
  const [command, path] = argv;
  if (!command || !path) fail(usage());

  if (command === "validate") {
    validateReportFile(path, { secretValues: providerSecretValuesFromEnv() });
    return;
  }
  if (command === "summary") {
    const { report } = readReportFile(path);
    process.stdout.write(renderPassRateSummaryMarkdown(report));
    return;
  }
  fail(usage());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
