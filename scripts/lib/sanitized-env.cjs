const secretNamePattern = /(?:^AWS_|^B2_|^GITHUB_|^NPM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)/i;
const defaultKeepEnvNames = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
];
const defaultNonSecretEnvNames = [];

function sanitizedEnv(extra = {}, options = {}) {
  const sourceEnv = options.sourceEnv ?? process.env;
  const keep = new Set(options.keepEnvNames ?? defaultKeepEnvNames);
  const nonSecretEnvNames = new Set([
    ...defaultNonSecretEnvNames,
    ...(options.nonSecretEnvNames ?? []),
  ]);
  const env = {};

  for (const name of keep) {
    if (sourceEnv[name]) env[name] = sourceEnv[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (secretNamePattern.test(name) && !nonSecretEnvNames.has(name)) continue;
    env[name] = value;
  }

  return env;
}

module.exports = {
  defaultKeepEnvNames,
  defaultNonSecretEnvNames,
  sanitizedEnv,
  secretNamePattern,
};
