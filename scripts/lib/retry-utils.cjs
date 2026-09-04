const { spawnSync } = require("node:child_process");

const transientNpmFailurePattern =
  /(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|fetch failed|network socket|network timeout|registry|rate limit|429|503|504)/i;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function npmInvocation(args = []) {
  if (process.platform === "win32")
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  return { command: "npm", args };
}

function commandInvocation(command, args = []) {
  switch (command) {
    case "npm":
      return npmInvocation(args);
    case "node":
      return { command: process.platform === "win32" ? "node.exe" : "node", args };
    case "pnpm":
      if (process.platform === "win32") {
        return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...args] };
      }
      return { command: "pnpm", args };
    default:
      throw new Error(`Unsupported retry command: ${command}`);
  }
}

function isTransientNpmFailure(result, extraError = null) {
  if (result.error?.code === "ETIMEDOUT") return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${extraError?.message ?? ""}`;
  return transientNpmFailurePattern.test(output);
}

function runCommandWithRetries(command, args, options = {}) {
  const attempts = options.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got ${attempts}`);
  }

  const label = options.retryLabel ?? commandLine(command, args);
  const invocation = commandInvocation(command, args);
  const delayMs = options.retryDelayMs ?? 1_000;
  const shouldRetry = options.shouldRetry ?? ((result) => isTransientNpmFailure(result));
  const retryMessage =
    options.retryMessage ??
    (({ attempt, attempts: totalAttempts }) =>
      `${command}: retrying ${label} after transient registry failure (${attempt}/${totalAttempts})`);

  // Exponential backoff with jitter, capped, so a brief registry/DNS blip has a
  // wider window to clear before the attempts are exhausted (a plain linear
  // 1s/2s backoff was too shallow for real npm-registry timeouts). Still fully
  // fail-closed: a persistent failure after every attempt is returned to the
  // caller unchanged.
  const maxDelayMs = options.maxRetryDelayMs ?? 30_000;
  // Injectable seams so unit tests can exercise the backoff/jitter math
  // deterministically; production callers get the real spawn/sleep/random.
  const spawn = options.spawn ?? spawnSync;
  const sleepFor = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawn(invocation.command, invocation.args, options.spawnOptions ?? {});
    if (attempt < attempts && shouldRetry(result, attempt)) {
      console.warn(retryMessage({ label, attempt, attempts, result }));
      const backoff = delayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(random() * 1_000);
      // Cap the final jittered delay so the total sleep never exceeds
      // maxRetryDelayMs (jitter must not push it past the caller's ceiling).
      sleepFor(Math.min(backoff + jitter, maxDelayMs));
      continue;
    }
    return result;
  }

  throw new Error(`${label} failed without a result`);
}

function runNpmCommandWithRetries(args, options = {}) {
  return runCommandWithRetries("npm", args, options);
}

module.exports = {
  commandInvocation,
  commandLine,
  isTransientNpmFailure,
  npmInvocation,
  runCommandWithRetries,
  runNpmCommandWithRetries,
  sleep,
};
