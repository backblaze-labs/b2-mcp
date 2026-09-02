import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, getRegisteredTools } from "../../src/server";
import { logger } from "../../src/utils/logger";
import { callTool, testConfig } from "../support/deterministic-fakes";

afterEach(() => vi.restoreAllMocks());

function schemaKeys(server: ReturnType<typeof createServer>, name: string): string[] {
  return Object.keys(getRegisteredTools(server)?.[name]?.inputSchema?.shape ?? {});
}

// createServer(config, null, { credentialsUnavailable: true }) is the credential-less
// stdio discovery mode: the full tool surface is registered so directory services
// can read tools/list, but every tool call short-circuits with a clear
// missing_credentials error instead of attempting a doomed provider call.
describe("credential-less discovery mode", () => {
  it("registers the full surface but refuses tool calls with missing_credentials", async () => {
    const server = createServer(testConfig, null, { credentialsUnavailable: true });

    for (const name of ["b2_list_buckets", "s3_head_bucket", "b2_usage_growth"]) {
      const result = await callTool(server, name, {});
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("missing_credentials");
      expect(text).toContain("HTTP 401");
      expect(text).toContain("B2_APPLICATION_KEY_ID");
    }
  });

  it("emits a tool.call audit event for the rejected attempt", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const server = createServer(testConfig, null, { credentialsUnavailable: true });

    await callTool(server, "b2_list_buckets", {});

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "b2_list_buckets",
        error: true,
        code: "missing_credentials",
        status: 401,
      }),
      "tool.call",
    );
  });

  it("advertises the full durable-secret schemas, not confirm-only stubs", () => {
    // testConfig has no secret sink, so outside discovery mode these tools would
    // register confirm-only compatibility stubs. Discovery mode must decouple
    // schema advertisement from sink availability so registries learn real inputs.
    const server = createServer(testConfig, null, { credentialsUnavailable: true });

    expect(schemaKeys(server, "b2_create_key")).toEqual(
      expect.arrayContaining(["keyName", "capabilities", "idempotencyKey"]),
    );
    expect(schemaKeys(server, "b2_create_group_member")).toEqual(
      expect.arrayContaining(["adminAccountId", "groupId", "memberEmail"]),
    );
    expect(schemaKeys(server, "b2_reserve_trial_create_account")).toEqual(
      expect.arrayContaining(["email", "term", "storage"]),
    );
  });

  it("still refuses the durable-secret tools with missing_credentials", async () => {
    const server = createServer(testConfig, null, { credentialsUnavailable: true });

    for (const name of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      const result = await callTool(server, name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("missing_credentials");
    }
  });

  it("keeps confirm-only stubs when credentials are present without a sink", () => {
    // Without the discovery flag and no active sink, the durable-secret tools stay
    // compatibility stubs (confirm-only), confirming the schemas are decoupled
    // from sink availability only under discovery mode.
    const server = createServer(testConfig, null);
    expect(schemaKeys(server, "b2_create_key")).toEqual(["confirm"]);
  });

  it("guards even the bootstrap authorize tool", async () => {
    const server = createServer(testConfig, null, { credentialsUnavailable: true });

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
