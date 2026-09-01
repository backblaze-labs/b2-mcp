import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server";
import { callTool, testConfig } from "../support/deterministic-fakes";

// createServer(config, null, { credentialsMissing: true }) is the credential-less
// stdio discovery mode: the full tool surface is registered so directory services
// can read tools/list, but every tool call short-circuits with a clear
// missing_credentials error instead of attempting a doomed provider call.
describe("credential-less discovery mode", () => {
  it("registers the full surface but refuses tool calls with missing_credentials", async () => {
    const server = createServer(testConfig, null, { credentialsMissing: true });

    for (const name of ["b2_list_buckets", "s3_head_bucket", "b2_usage_growth"]) {
      const result = await callTool(server, name, {});
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("missing_credentials");
      expect(text).toContain("HTTP 401");
      expect(text).toContain("B2_APPLICATION_KEY_ID");
    }
  });

  it("guards even the bootstrap authorize tool", async () => {
    const server = createServer(testConfig, null, { credentialsMissing: true });

    const result = await callTool(server, "b2_authorize_account", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing_credentials");
  });

  it("does not guard tool calls when credentials are present", async () => {
    const server = createServer(testConfig, null);
    // Without the discovery flag the real handler runs; b2_list_buckets does not
    // reach the missing_credentials short-circuit (it fails or succeeds through
    // the normal client path, never returning this discovery-only code).
    const result = await callTool(server, "b2_list_buckets", {});
    const text = result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("missing_credentials");
  });
});
