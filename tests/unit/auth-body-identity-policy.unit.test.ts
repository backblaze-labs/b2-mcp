import type { HttpRequest, HttpTransport } from "@backblaze-labs/b2-sdk";
import * as v from "vitest";
import { createMcpHttpTransport } from "../../src/auth";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";

v.afterEach(() => {
  v.vi.restoreAllMocks();
  _resetRetryBudget();
});

v.it(
  "charges a Blob subclass replay of the same request against the shared retry budget",
  async () => {
    // A Blob subtype with inherited behavior produces the same HTTP body. Merely
    // wrapping that payload in an application class must not grant a free retry.
    class UploadBody extends Blob {}
    const first = new Blob(["public payload"], { type: "application/octet-stream" });
    const replay = new UploadBody(["public payload"], { type: "application/octet-stream" });
    v.expect(await first.arrayBuffer()).toEqual(await replay.arrayBuffer());
    v.expect(first.type).toBe(replay.type);

    v.vi.spyOn(Date, "now").mockReturnValue(0);
    _resetRetryBudget();
    for (let i = 0; i < 100; i++) v.expect(_consumeRetryToken()).toBe(true);
    v.expect(_consumeRetryToken()).toBe(false);

    const send = v.vi.fn<HttpTransport["send"]>(async () => ({
      status: 503,
      headers: new Headers(),
      body: null,
      json: async <T>() => ({ status: 503, code: "service_unavailable" }) as T,
      text: async () => "service unavailable",
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const transport = createMcpHttpTransport({ send }, { maxRetries: 0 });
    const request: HttpRequest = {
      url: "https://api005.backblazeb2.com/b2api/v4/b2_list_buckets",
      method: "POST",
      signal: new AbortController().signal,
      body: first,
    };

    await v.expect(transport.send(request)).rejects.toMatchObject({ status: 503 });
    await v.expect(transport.send({ ...request, body: replay })).rejects.toMatchObject({
      code: "retry_budget_exhausted",
    });
    v.expect(send).toHaveBeenCalledTimes(1);
  },
);
