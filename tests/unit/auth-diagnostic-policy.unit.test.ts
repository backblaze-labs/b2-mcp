import { createMcpHttpTransport } from "../../src/auth";
import { logger } from "../../src/utils/logger";
import { _resetRetryBudget } from "../../src/utils/retry";
import { RecordingTransport } from "../support/sdk-test-helpers";

describe("interrupted native write diagnostics", () => {
  afterEach(() => {
    _resetRetryBudget();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "a socket reset code",
      interruption: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      reasonCode: "ECONNRESET",
    },
    {
      label: "a numeric DOM timeout code",
      interruption: new DOMException("The operation timed out", "TimeoutError"),
      reasonCode: undefined,
    },
  ])(
    "keeps useful string diagnostics for $label without replaying the write",
    async ({ interruption, reasonCode }) => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const inner = new RecordingTransport(() => {
        throw interruption;
      });
      const transport = createMcpHttpTransport(inner, {
        maxRetries: 3,
        initialRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        requestTimeoutMs: 30_000,
      });

      const failure: unknown = await transport
        .send({
          url: "https://api005.backblazeb2.com/b2api/v3/b2_create_bucket",
          method: "POST",
          body: "{}",
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ status: 409, code: "operation_status_unknown" });
      // The SDK may wrap the network error; its original cause must remain inspectable.
      const causes: unknown[] = [];
      let cause = failure;
      while (cause instanceof Error && !causes.includes(cause)) {
        causes.push(cause);
        cause = (cause as Error & { cause?: unknown }).cause;
      }
      expect(causes).toContain(interruption);
      expect(inner.requests).toHaveLength(1);
      expect(inner.requests[0].retry?.maxRetries).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "b2_create_bucket",
          status: 409,
          code: "operation_status_unknown",
        }),
        "native.write.outcome_unknown",
      );
      const fields = warn.mock.calls[0][0];
      if (reasonCode === undefined) {
        expect(fields).not.toHaveProperty("reasonCode");
      } else {
        expect(fields).toHaveProperty("reasonCode", reasonCode);
      }
    },
  );
});
