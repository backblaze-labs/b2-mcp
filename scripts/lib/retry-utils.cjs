const { spawnSync } = require("node:child_process");

const transientNpmFailurePattern =
  /(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|fetch failed|network socket|network timeout|registry|rate limit|429|503|504)/i;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function isTransientNpmFailure(result, extraError = null) {
  if (result.error?.code === "ETIMEDOUT") return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${extraError?.message ?? ""}`;
  return transientNpmFailurePattern.test(output);
}

function runNpmCommandWithRetries(args, options = {}) {
  const attempts = options.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got ${attempts}`);
  }

  const label = options.retryLabel ?? commandLine("npm", args);
  const delayMs = options.retryDelayMs ?? 1_000;
  const shouldRetry = options.shouldRetry ?? ((result) => isTransientNpmFailure(result));
  const retryMessage =
    options.retryMessage ??
    (({ attempt, attempts: totalAttempts }) =>
      `npm: retrying ${label} after transient registry failure (${attempt}/${totalAttempts})`);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("npm", args, options.spawnOptions ?? {});
    if (attempt < attempts && shouldRetry(result, attempt)) {
      console.warn(retryMessage({ label, attempt, attempts, result }));
      sleep(delayMs * attempt);
      continue;
    }
    return result;
  }

  throw new Error(`${label} failed without a result`);
}

module.exports = {
  commandLine,
  isTransientNpmFailure,
  runNpmCommandWithRetries,
  sleep,
};
