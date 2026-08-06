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
      "bucket=mcp-contract-123-1-n22.3.0-integration-abcd",
      "https://example.s3.us-west-004.backblazeb2.com/key?X-Amz-Signature=abc123",
    ].join(" ");

    const redacted = redactB2CredentialValues(text, {});

    expect(redacted).not.toContain("acct-123");
    expect(redacted).not.toContain("created-secret");
    expect(redacted).not.toContain("auth-token");
    expect(redacted).not.toContain("mcp-contract-123");
    expect(redacted).not.toContain("X-Amz-Signature");
    expect(redacted).toContain("[REDACTED_B2_RESOURCE]");
    expect(redacted).toContain("[REDACTED_B2_PRESIGNED_URL]");
  });
});
