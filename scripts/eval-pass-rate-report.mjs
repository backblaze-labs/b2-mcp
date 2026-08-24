import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROVIDER_SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const EXPECTED_PROVIDER_NAMES = ["Claude", "OpenAI"];
const RESULT_STATUSES = new Set(["passed", "failed", "errored"]);
const PASS_RATE_TOLERANCE = 1e-12;
const REPORT_KEYS = new Set([
  "schemaVersion",
  "generatedAt",
  "caseCount",
  "providers",
  "summary",
  "results",
  "sensitivity",
]);
const PROVIDER_KEYS = new Set(["provider", "model", "passed", "total", "passRate"]);
const FAILED_RESULT_FAILURE = "Case failed validation; raw model and tool payloads omitted.";
const ERRORED_RESULT_ERROR = "Case errored during evaluation; raw model and tool payloads omitted.";
const RESULT_KEYS_BY_STATUS = {
  passed: new Set(["provider", "caseName", "status", "passed"]),
  failed: new Set(["provider", "caseName", "status", "passed", "failure"]),
  errored: new Set(["provider", "caseName", "status", "passed", "error"]),
};
const SENSITIVITY_KEYS = new Set(["secretSafe", "omitted"]);

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

function assertAllowedKeys(value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key} is not allowed`);
  }
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
  assertAllowedKeys(report, REPORT_KEYS, "report");
  if (report.schemaVersion !== 1) fail("report.schemaVersion must be 1");
  assertString(report.generatedAt, "report.generatedAt");
  assertNonNegativeInteger(report.caseCount, "report.caseCount");
  assertString(report.summary, "report.summary");

  if (!Array.isArray(report.providers)) {
    fail("report.providers must be an array");
  }
  if (report.providers.length !== EXPECTED_PROVIDER_NAMES.length) {
    fail("report.providers must contain exactly one Claude and one OpenAI entry");
  }
  const providerCounts = new Map(EXPECTED_PROVIDER_NAMES.map((provider) => [provider, 0]));
  for (const [index, provider] of report.providers.entries()) {
    const path = `report.providers[${index}]`;
    if (!isRecord(provider)) fail(`${path} must be an object`);
    assertAllowedKeys(provider, PROVIDER_KEYS, path);
    assertString(provider.provider, `${path}.provider`);
    if (!providerCounts.has(provider.provider)) {
      fail(`${path}.provider must be Claude or OpenAI`);
    }
    providerCounts.set(provider.provider, providerCounts.get(provider.provider) + 1);
    assertString(provider.model, `${path}.model`);
    assertNonNegativeInteger(provider.passed, `${path}.passed`);
    assertNonNegativeInteger(provider.total, `${path}.total`);
    if (provider.passed > provider.total) fail(`${path}.passed must not exceed total`);
    if (provider.total !== report.caseCount) fail(`${path}.total must equal report.caseCount`);
    assertPassRate(provider.passRate, `${path}.passRate`);
    const expectedPassRate = provider.total === 0 ? 0 : provider.passed / provider.total;
    if (Math.abs(provider.passRate - expectedPassRate) > PASS_RATE_TOLERANCE) {
      fail(`${path}.passRate must equal passed / total`);
    }
  }
  for (const [provider, count] of providerCounts) {
    if (count !== 1) fail(`report.providers must contain exactly one ${provider} entry`);
  }

  if (!Array.isArray(report.results)) fail("report.results must be an array");
  const resultCountsByProvider = new Map(
    EXPECTED_PROVIDER_NAMES.map((provider) => [provider, { passed: 0, total: 0 }]),
  );
  for (const [index, result] of report.results.entries()) {
    const path = `report.results[${index}]`;
    if (!isRecord(result)) fail(`${path} must be an object`);
    assertString(result.provider, `${path}.provider`);
    const providerResultCounts = resultCountsByProvider.get(result.provider);
    if (!providerResultCounts) fail(`${path}.provider must be Claude or OpenAI`);
    assertString(result.caseName, `${path}.caseName`);
    if (!RESULT_STATUSES.has(result.status)) fail(`${path}.status is invalid`);
    assertAllowedKeys(result, RESULT_KEYS_BY_STATUS[result.status], path);
    if (typeof result.passed !== "boolean") fail(`${path}.passed must be boolean`);
    if (result.passed !== (result.status === "passed")) {
      fail(`${path}.passed must equal whether status is passed`);
    }
    providerResultCounts.total += 1;
    if (result.passed) providerResultCounts.passed += 1;
    if (result.status === "failed" && typeof result.failure !== "string") {
      fail(`${path}.failure must be present for failed results`);
    }
    if (result.status === "failed" && result.failure !== FAILED_RESULT_FAILURE) {
      fail(`${path}.failure must be the bounded failed diagnostic`);
    }
    if (result.status === "errored" && typeof result.error !== "string") {
      fail(`${path}.error must be present for errored results`);
    }
    if (result.status === "errored" && result.error !== ERRORED_RESULT_ERROR) {
      fail(`${path}.error must be the bounded errored diagnostic`);
    }
  }
  for (const provider of report.providers) {
    const resultCounts = resultCountsByProvider.get(provider.provider);
    if (resultCounts.total !== provider.total) {
      fail(`report.results total for ${provider.provider} must equal provider.total`);
    }
    if (resultCounts.passed !== provider.passed) {
      fail(`report.results passed count for ${provider.provider} must equal provider.passed`);
    }
  }

  if (!isRecord(report.sensitivity)) fail("report.sensitivity must be an object");
  assertAllowedKeys(report.sensitivity, SENSITIVITY_KEYS, "report.sensitivity");
  if (report.sensitivity.secretSafe !== true) fail("report.sensitivity.secretSafe must be true");
  if (
    !Array.isArray(report.sensitivity.omitted) ||
    report.sensitivity.omitted.length === 0 ||
    !report.sensitivity.omitted.every((value) => typeof value === "string" && value.length > 0)
  ) {
    fail("report.sensitivity.omitted must be a non-empty string array");
  }
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
