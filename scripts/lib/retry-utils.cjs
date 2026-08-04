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

module.exports = {
  commandLine,
  isTransientNpmFailure,
  sleep,
};
