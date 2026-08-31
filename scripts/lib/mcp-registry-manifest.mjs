import { readFileSync } from "node:fs";
import {
  assert,
  canonicalHomepage,
  canonicalMcpName,
  canonicalPackageName,
  canonicalRepositoryId,
  canonicalRepositorySource,
  canonicalRepositoryUrl,
} from "./release-utils.mjs";

export const mcpRegistryApiBaseUrl = "https://registry.modelcontextprotocol.io/v0";
export const mcpRegistrySchemaUrl =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const mcpRegistryTitle = "Backblaze B2 MCP Server";
export const mcpRegistryDescription =
  "Operate Backblaze B2 buckets, files, keys, Object Lock, and S3-compatible storage.";

export const expectedMcpRegistryEnvironmentVariables = Object.freeze([
  Object.freeze({
    description: "Backblaze B2 application key ID for native B2 and S3-compatible tools.",
    format: "string",
    isRequired: true,
    isSecret: true,
    name: "B2_APPLICATION_KEY_ID",
  }),
  Object.freeze({
    description: "Backblaze B2 application key secret.",
    format: "string",
    isRequired: true,
    isSecret: true,
    name: "B2_APPLICATION_KEY",
  }),
  Object.freeze({
    description: "Optional fallback S3-compatible region used before authorization.",
    format: "string",
    isRequired: false,
    isSecret: false,
    name: "B2_REGION",
    placeholder: "us-east-005",
  }),
  Object.freeze({
    description: "Optional master key ID for Partner/Groups API tools.",
    format: "string",
    isRequired: false,
    isSecret: true,
    name: "B2_MASTER_KEY_ID",
  }),
  Object.freeze({
    description: "Optional master key secret for Partner/Groups API tools.",
    format: "string",
    isRequired: false,
    isSecret: true,
    name: "B2_MASTER_KEY",
  }),
]);

const allowedManifestKeys = new Set([
  "$schema",
  "description",
  "name",
  "packages",
  "repository",
  "title",
  "version",
  "websiteUrl",
]);
const allowedRepositoryKeys = new Set(["id", "source", "url"]);
const allowedPackageKeys = new Set([
  "environmentVariables",
  "identifier",
  "registryType",
  "transport",
  "version",
]);
const allowedTransportKeys = new Set(["type"]);

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  assert(isRecord(value), `${label} must be an object`);
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  assert(unexpected.length === 0, `${label} has unexpected keys: ${unexpected.join(", ")}`);
}

function secretLikeB2EnvironmentVariable(name) {
  return name.startsWith("B2_") && /(CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/.test(name);
}

function assertEnvironmentVariableContract(environmentVariables) {
  assert(Array.isArray(environmentVariables), "server.json environmentVariables must be an array");

  const byName = new Map();
  const expectedByName = new Map(
    expectedMcpRegistryEnvironmentVariables.map((variable) => [variable.name, variable]),
  );
  for (const variable of environmentVariables) {
    assertRecord(variable, "server.json environment variable");
    const name = variable.name;
    assert(
      typeof name === "string" && name.length > 0,
      "server.json environment variable needs a name",
    );
    if (secretLikeB2EnvironmentVariable(name)) {
      assert(variable.isSecret === true, `server.json environment variable ${name} must be secret`);
    }
    assert(!byName.has(name), `server.json environment variable ${name} is duplicated`);
    byName.set(name, variable);
    assert(
      expectedByName.has(name),
      `server.json environment variable ${name} is not in the approved allowlist`,
    );
  }
  assert(
    environmentVariables.length === expectedMcpRegistryEnvironmentVariables.length,
    `server.json environmentVariables must contain exactly ${expectedMcpRegistryEnvironmentVariables.length} entries`,
  );

  for (const expected of expectedMcpRegistryEnvironmentVariables) {
    const actual = byName.get(expected.name);
    assert(!!actual, `server.json environment variable ${expected.name} is missing`);
    assertOnlyKeys(
      actual,
      new Set(Object.keys(expected)),
      `server.json environment variable ${expected.name}`,
    );
    for (const [field, expectedValue] of Object.entries(expected)) {
      assert(
        actual[field] === expectedValue,
        `server.json environment variable ${expected.name}.${field} must be ${JSON.stringify(expectedValue)}`,
      );
    }
  }
}

export function assertMcpRegistryManifestContract(manifest, options = {}) {
  const expectedVersion = options.expectedVersion ?? manifest?.version;

  assertRecord(manifest, "server.json");
  assertOnlyKeys(manifest, allowedManifestKeys, "server.json");
  assert(manifest.$schema === mcpRegistrySchemaUrl, "server.json schema URL is not canonical");
  assert(manifest.name === canonicalMcpName, "server.json name is not canonical");
  assert(manifest.title === mcpRegistryTitle, "server.json title is not canonical");
  assert(
    manifest.description === mcpRegistryDescription,
    "server.json description is not canonical",
  );
  assert(manifest.websiteUrl === canonicalHomepage, "server.json website URL is not canonical");
  assert(
    manifest.version === expectedVersion,
    `server.json version ${manifest.version} does not match ${expectedVersion}`,
  );

  assertRecord(manifest.repository, "server.json repository");
  assertOnlyKeys(manifest.repository, allowedRepositoryKeys, "server.json repository");
  assert(
    manifest.repository.url === canonicalRepositoryUrl,
    "server.json repository URL is not canonical",
  );
  assert(
    manifest.repository.source === canonicalRepositorySource,
    "server.json repository source is not canonical",
  );
  assert(
    manifest.repository.id === canonicalRepositoryId,
    "server.json repository id is not canonical",
  );

  assert(Array.isArray(manifest.packages), "server.json packages must be an array");
  assert(manifest.packages.length === 1, "server.json packages must contain exactly one entry");
  const packageEntry = manifest.packages[0];
  assertRecord(packageEntry, "server.json npm package");
  assertOnlyKeys(packageEntry, allowedPackageKeys, "server.json npm package");
  assert(packageEntry.registryType === "npm", "server.json package registryType must be npm");
  assert(
    packageEntry.identifier === canonicalPackageName,
    `server.json package identifier must be ${canonicalPackageName}`,
  );
  assert(
    packageEntry.version === expectedVersion,
    `server.json package version ${packageEntry.version} does not match ${expectedVersion}`,
  );
  assertRecord(packageEntry.transport, "server.json package transport");
  assertOnlyKeys(packageEntry.transport, allowedTransportKeys, "server.json package transport");
  assert(packageEntry.transport.type === "stdio", "server.json package transport must be stdio");
  assertEnvironmentVariableContract(packageEntry.environmentVariables);

  return normalizedMcpRegistryManifest(manifest);
}

export function assertMcpRegistryPackageJsonContract(packageJson, options = {}) {
  const expectedVersion = options.expectedVersion ?? packageJson?.version;

  assertRecord(packageJson, "package.json");
  assert(packageJson.name === canonicalPackageName, `unexpected package name ${packageJson.name}`);
  assert(packageJson.mcpName === canonicalMcpName, "package mcpName is not canonical");
  assert(
    packageJson.version === expectedVersion,
    `package.json version ${packageJson.version} does not match ${expectedVersion}`,
  );
}

export function verifyMcpRegistryManifestFiles({
  serverJsonPath,
  packageJsonPath,
  expectedVersion,
}) {
  const manifest = readJsonFile(serverJsonPath);
  const packageJson = readJsonFile(packageJsonPath);
  assertMcpRegistryPackageJsonContract(packageJson, { expectedVersion });
  const normalized = assertMcpRegistryManifestContract(manifest, { expectedVersion });
  assert(
    packageJson.mcpName === manifest.name,
    "package.json mcpName does not match server.json name",
  );
  return { manifest, normalized, packageJson };
}

export function normalizedMcpRegistryManifest(manifest) {
  const packageEntry = manifest.packages[0];
  return {
    $schema: manifest.$schema,
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    websiteUrl: manifest.websiteUrl,
    repository: {
      url: manifest.repository.url,
      source: manifest.repository.source,
      id: manifest.repository.id,
    },
    version: manifest.version,
    packages: [
      {
        registryType: packageEntry.registryType,
        identifier: packageEntry.identifier,
        version: packageEntry.version,
        transport: { type: packageEntry.transport.type },
        environmentVariables: expectedMcpRegistryEnvironmentVariables.map((expected) => {
          const actual = packageEntry.environmentVariables.find(
            (variable) => variable.name === expected.name,
          );
          return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
        }),
      },
    ],
  };
}

export function registryServerFromResponse(responseJson) {
  return responseJson?.server ?? responseJson;
}

export function assertRegistryResponseMatchesManifest(responseJson, manifest) {
  const expected = assertMcpRegistryManifestContract(manifest);
  const fetchedServer = registryServerFromResponse(responseJson);
  let actual;
  try {
    actual = assertMcpRegistryManifestContract(fetchedServer, {
      expectedVersion: manifest.version,
    });
  } catch (error) {
    throw new Error(
      `MCP Registry version does not match local server.json: ${
        error instanceof Error ? error.message : String(error)
      }\nfetched=${JSON.stringify(fetchedServer)}`,
    );
  }
  const expectedJson = JSON.stringify(expected);
  const actualJson = JSON.stringify(actual);
  assert(
    actualJson === expectedJson,
    `MCP Registry version does not match local server.json\nexpected=${expectedJson}\nactual=${actualJson}`,
  );
}

export function mcpRegistryVersionUrl(manifest, baseUrl = mcpRegistryApiBaseUrl) {
  assertRecord(manifest, "server.json");
  assert(
    typeof manifest.name === "string" && manifest.name.length > 0,
    "server.json name is required",
  );
  assert(
    typeof manifest.version === "string" && manifest.version.length > 0,
    "server.json version is required",
  );
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/servers/${encodeURIComponent(manifest.name)}/versions/${encodeURIComponent(manifest.version)}`;
}

export function isPrereleaseVersion(version) {
  return String(version).includes("-");
}
