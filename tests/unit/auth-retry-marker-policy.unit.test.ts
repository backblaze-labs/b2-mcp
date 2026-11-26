import type { HttpResponse, HttpTransport } from "@backblaze-labs/b2-sdk";
import { createMcpHttpTransport } from "../../src/auth";
import { _resetRetryBudget } from "../../src/utils/retry";

const readRequest = {
  url: "https://api005.backblazeb2.com/b2api/v4/b2_list_buckets",
  method: "POST" as const,
  body: "{}",
};

beforeEach(() => {
  _resetRetryBudget();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  _resetRetryBudget();
  vi.restoreAllMocks();
});

function unavailableResponse(unreadable: boolean): HttpResponse {
  const payload = { status: 503, code: "service_unavailable", message: "try later" };
  return {
    status: 503,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    json: async <T>() => {
      if (unreadable) throw new SyntaxError("truncated first response");
      return payload as T;
    },
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
  };
}

function transport(send: HttpTransport["send"], maxRetries = 1) {
  return createMcpHttpTransport(
    { send },
    {
      maxRetries,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 1000,
    },
  );
}

describe("definitive response status across SDK retries", () => {
  it.each([
    { body: "unreadable", unreadable: true },
    { body: "valid", unreadable: false },
  ])("reports the final network failure after a 503 with a $body body", async ({ unreadable }) => {
    const firstResponse = unavailableResponse(unreadable);
    const readBody = vi.spyOn(firstResponse, "json");
    const send = vi
      .fn<HttpTransport["send"]>()
      .mockResolvedValueOnce(firstResponse)
      .mockRejectedValueOnce(new TypeError("connection failed on retry"));

    await expect(transport(send).send(readRequest)).rejects.toMatchObject({
      name: "NetworkError",
      message: "connection failed on retry",
    });
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("preserves an unreadable 503 when no later attempt supersedes it", async () => {
    const firstResponse = unavailableResponse(true);
    const readBody = vi.spyOn(firstResponse, "json");
    const send = vi.fn<HttpTransport["send"]>().mockResolvedValueOnce(firstResponse);

    await expect(transport(send, 0).send(readRequest)).rejects.toMatchObject({
      status: 503,
      code: "response_body_unavailable",
      message: "HTTP 503 response body could not be read",
    });
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
