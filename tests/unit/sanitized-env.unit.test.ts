import { createRequire } from "module";
import { join } from "path";
import { pathToFileURL } from "url";

const nodeRequire = createRequire(__filename);
const { sanitizedEnv } = nodeRequire("../../scripts/lib/sanitized-env.cjs") as {
  sanitizedEnv: (
    extra?: Record<string, string>,
    options?: { nonSecretEnvNames?: string[]; sourceEnv?: Record<string, string> },
  ) => Record<string, string>;
};

describe("sanitized child-process env", () => {
  it("strips B2-prefixed values by default", () => {
    expect(sanitizedEnv({ B2_REGISTER_ALL_TOOLS: "true" }, { sourceEnv: {} })).not.toHaveProperty(
      "B2_REGISTER_ALL_TOOLS",
    );
  });

  it("allows caller-scoped non-secret exceptions", () => {
    expect(
      sanitizedEnv(
        { B2_REGISTER_ALL_TOOLS: "true" },
        { sourceEnv: {}, nonSecretEnvNames: ["B2_REGISTER_ALL_TOOLS"] },
      ).B2_REGISTER_ALL_TOOLS,
    ).toBe("true");
  });
});

describe("B2 log redaction", () => {
  it("redacts account ids, generated live resources, tokens, and presigned URLs", async () => {
    const { redactB2CredentialValues } = (await import(
      pathToFileURL(join(__dirname, "../../scripts/b2-credential-env.mjs")).href
    )) as {
      redactB2CredentialValues: (text: string, env?: Record<string, string>) => string;
    };
    const text = [
      'accountId="acct-123"',
      '"applicationKey":"created-secret"',
      '"authorizationToken":"auth-token"',
      "upload_authorization_token=upload-token",
      "bucket=mcp-contract-123-1-n22-23-1-integration-abcd",
      "https://example.s3.us-west-004.backblazeb2.com/key?X-Amz-Signature=abc123",
      "https://f004.backblazeb2.com/file/bucket/key.txt?Authorization=b2-native-token",
    ].join(" ");

    const redacted = redactB2CredentialValues(text, {});

    expect(redacted).not.toContain("acct-123");
    expect(redacted).not.toContain("created-secret");
    expect(redacted).not.toContain("auth-token");
    expect(redacted).not.toContain("upload-token");
    expect(redacted).not.toContain("mcp-contract-123");
    expect(redacted).not.toContain("X-Amz-Signature");
    expect(redacted).not.toContain("b2-native-token");
    expect(redacted).toContain('"applicationKey":"[REDACTED_B2_CREDENTIAL]"');
    expect(redacted).toContain("[REDACTED_B2_RESOURCE]");
    expect(redacted).toContain("[REDACTED_B2_PRESIGNED_URL]");
  });
});

describe("Vercel build env policy", () => {
  it("classifies sensitive and forbidden env names from one shared helper", async () => {
    const {
      isVercelBuildForbiddenEnvName,
      isVercelBuildKnownSecretCanary,
      isVercelBuildSensitiveEnvName,
      sanitizedVercelBuildEnv,
      vercelBuildForbiddenEnvNames,
      vercelBuildKnownSecretCanaries,
    } = (await import(
      pathToFileURL(join(__dirname, "../../scripts/b2-credential-env.mjs")).href
    )) as {
      isVercelBuildForbiddenEnvName: (name: string) => boolean;
      isVercelBuildKnownSecretCanary: (name: string, value: string) => boolean;
      isVercelBuildSensitiveEnvName: (name: string) => boolean;
      sanitizedVercelBuildEnv: (env: Record<string, string>) => Record<string, string>;
      vercelBuildForbiddenEnvNames: (env: Record<string, string>) => string[];
      vercelBuildKnownSecretCanaries: Record<string, string>;
    };
    const sourceEnv = {
      B2_APPLICATION_KEY: "b2-secret",
      LIVE_B2_APPLICATION_KEY: "live-b2-secret",
      OAUTH_CLIENT_SECRET: "oauth-secret",
      VERCEL_TOKEN: "vercel-token",
      NEXT_PUBLIC_MCP_URL: "https://example.invalid",
      B2_REGISTER_ALL_TOOLS: "true",
      PATH: "/usr/bin",
    };

    expect(isVercelBuildSensitiveEnvName("LIVE_B2_APPLICATION_KEY")).toBe(true);
    expect(isVercelBuildSensitiveEnvName("OAUTH_CLIENT_SECRET")).toBe(true);
    expect(isVercelBuildSensitiveEnvName("VERCEL_TOKEN")).toBe(true);
    expect(isVercelBuildSensitiveEnvName("NEXT_PUBLIC_MCP_URL")).toBe(false);
    expect(isVercelBuildForbiddenEnvName("NEXT_PUBLIC_MCP_URL")).toBe(true);
    expect(vercelBuildForbiddenEnvNames(sourceEnv)).toEqual([
      "B2_APPLICATION_KEY",
      "LIVE_B2_APPLICATION_KEY",
      "NEXT_PUBLIC_MCP_URL",
      "OAUTH_CLIENT_SECRET",
      "VERCEL_TOKEN",
    ]);
    expect(sanitizedVercelBuildEnv(sourceEnv)).toMatchObject({
      B2_REGISTER_ALL_TOOLS: "true",
      PATH: "/usr/bin",
      VERCEL_TELEMETRY_DISABLED: "1",
      VERCEL_TOKEN: "",
    });
    expect(sanitizedVercelBuildEnv(sourceEnv)).not.toHaveProperty("OAUTH_CLIENT_SECRET");
    expect(sanitizedVercelBuildEnv(sourceEnv)).not.toHaveProperty("NEXT_PUBLIC_MCP_URL");

    const canaryEnv = {
      ...vercelBuildKnownSecretCanaries,
      PATH: "/usr/bin",
    };
    expect(isVercelBuildKnownSecretCanary("B2_APPLICATION_KEY", "real-secret")).toBe(false);
    expect(
      isVercelBuildKnownSecretCanary(
        "B2_APPLICATION_KEY",
        vercelBuildKnownSecretCanaries.B2_APPLICATION_KEY,
      ),
    ).toBe(true);
    expect(vercelBuildForbiddenEnvNames(canaryEnv)).toEqual([]);
    expect(sanitizedVercelBuildEnv(canaryEnv)).toMatchObject(canaryEnv);
  });
});
