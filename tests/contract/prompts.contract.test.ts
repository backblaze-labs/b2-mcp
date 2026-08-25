import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import type { CredentialProvider, CredentialResolution } from "../../src/credentials";
import { B2_WORKFLOW_PROMPT_NAMES } from "../../src/prompts";
import { CONTRACT_TEST_CONFIG } from "../../src/tool-contract";

async function listenOnEphemeralPort(handle: HttpServerHandle): Promise<number> {
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
  return address.port;
}

function credentialProvider(): CredentialProvider {
  return {
    name: "prompt-contract",
    validateConfiguration() {
      return undefined;
    },
    resolve(): CredentialResolution {
      return {
        config: CONTRACT_TEST_CONFIG,
        cacheKey: "prompt-contract",
        capabilityCacheKey: "prompt-contract",
      };
    },
  };
}

async function withPromptClient<T>(
  capabilities: string[] | null,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const handle = buildHttpServer({
    credentialProvider: credentialProvider(),
    fetchCapabilities: async () => capabilities,
  });
  const port = await listenOnEphemeralPort(handle);
  const client = new Client(
    { name: "b2-mcp-prompt-contract", version: "1.0.0" },
    { defaultCacheTtlMs: 0 },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
    handle.drain();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
}

function textContent(result: Awaited<ReturnType<Client["getPrompt"]>>): string {
  const content = result.messages[0]?.content;
  if (content?.type !== "text") throw new Error("expected text prompt content");
  return content.text;
}

describe("MCP prompt contract", () => {
  it("serves prompts/list with the right-sized full prompt set", async () => {
    await withPromptClient(null, async (client) => {
      const listed = await client.listPrompts({}, { cacheMode: "refresh" });
      const names = listed.prompts.map((prompt) => prompt.name).sort();

      expect(names).toEqual([...B2_WORKFLOW_PROMPT_NAMES].sort());

      const objectLock = listed.prompts.find(
        (prompt) => prompt.name === "b2-provision-object-lock-bucket",
      );
      expect(objectLock?.arguments?.map((arg) => arg.name).sort()).toEqual([
        "bucketName",
        "mode",
        "retentionDuration",
        "retentionUnit",
      ]);
      expect(objectLock?.arguments?.every((arg) => arg.required)).toBe(true);
    });
  });

  it("serves prompts/get as a parameterized message sequence", async () => {
    await withPromptClient(null, async (client) => {
      const result = await client.getPrompt({
        name: "b2-provision-object-lock-bucket",
        arguments: {
          bucketName: "contract-lock-bucket",
          mode: "governance",
          retentionDuration: "30",
          retentionUnit: "days",
        },
      });

      expect(result.description).toMatch(/Object Lock/i);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.role).toBe("user");
      expect(textContent(result)).toContain("contract-lock-bucket");
      expect(textContent(result)).toContain("b2_create_bucket");
      expect(textContent(result)).toContain("b2_update_bucket");
    });
  });

  it("rejects invalid prompt arguments before returning prompt text", async () => {
    await withPromptClient(null, async (client) => {
      await expect(
        client.getPrompt({
          name: "b2-provision-object-lock-bucket",
          arguments: {
            bucketName: "contract-lock-bucket",
            mode: "governance",
            retentionDuration: "0",
            retentionUnit: "days",
          },
        }),
      ).rejects.toThrow();

      await expect(
        client.getPrompt({
          name: "b2-audit-public-exposure",
          arguments: {
            bucketName: "a".repeat(64),
            riskContext: "production",
          },
        }),
      ).rejects.toThrow();
    });
  });

  it("omits key rotation from credentials without key-management capabilities", async () => {
    await withPromptClient(
      ["listBuckets", "listFiles", "listKeys", "readBucketNotifications", "readFiles"],
      async (client) => {
        const listed = await client.listPrompts({}, { cacheMode: "refresh" });
        const names = listed.prompts.map((prompt) => prompt.name).sort();

        expect(names).toEqual(["b2-audit-public-exposure", "b2-review-event-notifications"]);
        expect(names).not.toContain("b2-rotate-application-key");
      },
    );
  });

  it("does not produce prompt text that bypasses destructive confirmation", async () => {
    await withPromptClient(null, async (client) => {
      const result = await client.getPrompt({
        name: "b2-rotate-application-key",
        arguments: {
          oldApplicationKeyId: "old-key-id",
          workloadName: "nightly-backup",
          requestedReduction: "remove deleteFiles",
        },
      });
      const text = textContent(result);

      expect(text).toContain("destructive gate");
      expect(text).not.toMatch(/["']?confirm["']?\s*:\s*true/i);
    });
  });
});
