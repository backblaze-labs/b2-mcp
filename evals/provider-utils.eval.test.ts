import { describe, expect, it, vi } from "vitest";
import {
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
