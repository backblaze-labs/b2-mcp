const os = require("node:os");

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function displayValue(value, unit) {
  return unit === "bytes" ? Math.round(value) : round(value);
}

function budgetLimit(budget) {
  const percent = Number(budget.tolerance?.percent ?? 0);
  const absolute = Number(budget.tolerance?.absolute ?? 0);
  if (budget.direction === "min") {
    return budget.baseline * (1 - percent / 100) - absolute;
  }
  return budget.baseline * (1 + percent / 100) + absolute;
}

function evaluateMetric(id, value, budget) {
  const rawLimit = budgetLimit(budget);
  const reportedValue = displayValue(value, budget.unit);
  const reportedLimit = displayValue(rawLimit, budget.unit);
  const pass =
    budget.direction === "min" ? reportedValue >= reportedLimit : reportedValue <= reportedLimit;
  return {
    id,
    label: budget.label,
    unit: budget.unit,
    value: reportedValue,
    status: pass ? "pass" : "fail",
    budget: {
      direction: budget.direction,
      baseline: budget.baseline,
      tolerance: budget.tolerance,
      limit: reportedLimit,
      rawLimit,
    },
    rawValue: value,
  };
}

function evaluateMeasurements(config, measurements, { requireAll = true } = {}) {
  const byId = new Map(measurements.map((metric) => [metric.id, metric]));
  return Object.entries(config.budgets).flatMap(([id, budget]) => {
    const measured = byId.get(id);
    if (!measured) {
      if (!requireAll) return [];
      throw new Error(`Performance budget ${id} has no measurement.`);
    }
    return [
      {
        ...evaluateMetric(id, measured.value, budget),
        ...(measured.details && { details: measured.details }),
      },
    ];
  });
}

function renderSummary(config, metrics, { enforce = false, failure = null } = {}) {
  const failures = metrics.filter((metric) => metric.status !== "pass");
  const mode = enforce ? "enforce" : "advisory";
  const rows = metrics.map((metric) =>
    [
      metric.status === "pass" ? "PASS" : "FAIL",
      metric.id,
      `${metric.value} ${metric.unit}`,
      `${metric.budget.direction} ${metric.budget.limit} ${metric.unit}`,
    ].join(" | "),
  );
  return [
    "# Local Performance Baseline",
    "",
    `Mode: ${mode}`,
    `Issue: #${config.issue.number} ${config.issue.url}`,
    failure
      ? `Status: measurement failed (${failure.phase ?? failure.metricId ?? "unknown phase"})`
      : `Status: ${failures.length === 0 ? "pass" : `${failures.length} budget violation(s)`}`,
    ...(failure ? [`Error: ${failure.message}`] : []),
    "",
    "This local baseline uses fake deterministic fixtures and does not measure live Backblaze B2 latency.",
    "",
    "status | metric | measured | budget",
    "--- | --- | --- | ---",
    ...(rows.length > 0 ? rows : ["NO DATA | partial metrics | none | n/a"]),
    "",
    "Runtime applicability:",
    ...Object.entries(config.runtimeApplicability).map(
      ([runtime, decision]) => `- ${runtime}: ${decision.decision} (${decision.budgetSet})`,
    ),
    "",
  ].join("\n");
}

function createArtifact({
  config,
  metrics,
  measurements = [],
  enforce = false,
  failure = null,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: 1,
    generatedAt,
    issue: config.issue,
    mode: enforce ? "enforce" : "advisory",
    advisory: !enforce,
    liveB2CredentialsUsed: false,
    liveB2NetworkMeasured: false,
    node: process.version,
    platform: {
      os: os.platform(),
      arch: os.arch(),
    },
    measurementPlan: config.measurementPlan,
    runtimeApplicability: config.runtimeApplicability,
    metrics,
    partialMeasurements: measurements,
    violations: metrics.filter((metric) => metric.status !== "pass").map((metric) => metric.id),
    ...(failure && { failure }),
  };
}

module.exports = {
  budgetLimit,
  createArtifact,
  displayValue,
  evaluateMeasurements,
  evaluateMetric,
  renderSummary,
  round,
};
