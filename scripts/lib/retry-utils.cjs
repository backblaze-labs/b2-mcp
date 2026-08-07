const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const transientNpmFailurePattern =
  /(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|fetch failed|network socket|network timeout|registry|rate limit|429|503|504)/i;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function npmInvocation(args = []) {
  if (process.platform !== "win32") return { command: "npm", args };
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...args] };
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", "npm", ...args],
  };
}

function commandInvocation(command, args = []) {
  return command === "npm" ? npmInvocation(args) : { command, args };
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

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(invocation.command, invocation.args, options.spawnOptions ?? {});
    if (attempt < attempts && shouldRetry(result, attempt)) {
      console.warn(retryMessage({ label, attempt, attempts, result }));
      sleep(delayMs * attempt);
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
