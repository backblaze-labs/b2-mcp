import { describe, expect, it, vi } from "vitest";
import {
  readProviderJsonResponse,
  sendProviderJsonRequest,
  stringifyToolResultPayload,
  type EvalFetch,
} from "./provider-utils";

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("provider retry transport", () => {
  it("falls back when JSON serialization does not produce a string", () => {
    expect(stringifyToolResultPayload(undefined)).toBe("undefined");
  });

  it("redacts secrets from provider request-id headers", async () => {
    const apiKey = "sk-proj-real-secret-1234567890";
    const response = new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
      status: 401,
      headers: { "x-request-id": `Bearer ${apiKey}` },
    });

    let caught: unknown;
    await readProviderJsonResponse({
      response,
      providerName: "Test",
      apiName: "Test API",
      failurePrefix: "Test API request failed",
      requestIdHeaderNames: ["x-request-id"],
      secretValues: [apiKey],
      signal: abortSignal(),
    }).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("requestId: Bearer [REDACTED]");
    expect(message).not.toContain(apiKey);
  });

  it("redacts secrets from request-id headers on oversized provider errors", async () => {
    const apiKey = "sk-proj-real-secret-1234567890";
    const response = new Response("too large", {
      status: 502,
      headers: { "x-request-id": apiKey },
    });

    let caught: unknown;
    await readProviderJsonResponse({
      response,
      providerName: "Test",
      apiName: "Test API",
      failurePrefix: "Test API request failed",
      requestIdHeaderNames: ["x-request-id"],
      secretValues: [apiKey],
      maxBodyBytes: 1,
      signal: abortSignal(),
    }).catch((err: unknown) => {
      caught = err;
    });

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("requestId: [REDACTED_SECRET]");
    expect(message).not.toContain(apiKey);
  });

  it("retries fetch TypeError transport failures", async () => {
    const fetchImpl = vi
      .fn<EvalFetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(
      sendProviderJsonRequest({
        providerName: "Test",
        url: "https://provider.example/messages",
        fetchImpl,
        headers: { authorization: "Bearer test-key" },
        body: { model: "test-model" },
        signal: abortSignal(),
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        retryableStatuses: new Set(),
        readResponse: async () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry TypeErrors after a response is received", async () => {
    const fetchImpl = vi.fn<EvalFetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
      }),
    );

    await expect(
      sendProviderJsonRequest({
        providerName: "Test",
        url: "https://provider.example/messages",
        fetchImpl,
        headers: { authorization: "Bearer test-key" },
        body: { model: "test-model" },
        signal: abortSignal(),
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        retryableStatuses: new Set(),
        readResponse: async () => {
          throw new TypeError("parser bug");
        },
      }),
    ).rejects.toThrow(/parser bug/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
