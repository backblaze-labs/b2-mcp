import type { HttpTransport } from "@backblaze-labs/b2-sdk";
import { createMcpHttpTransport } from "../../src/auth";
import { logger } from "../../src/utils/logger";
import { _resetRetryBudget } from "../../src/utils/retry";

afterEach(() => {
  _resetRetryBudget();
  vi.restoreAllMocks();
});

describe("optional write diagnostics", () => {
  it.each(["cause", "code"])(
    "preserves an ambiguous write outcome when the abort reason's %s accessor fails",
    async (field) => {
      const inspectionFailure = new Error("diagnostic detail is unavailable");
      const interruption = new Error("caller timeout");
      interruption.name = "TimeoutError";
      Object.defineProperty(interruption, field, {
        get: () => {
          throw inspectionFailure;
        },
      });
      const controller = new AbortController();
      const send = vi.fn<HttpTransport["send"]>(async () => {
        controller.abort(interruption);
        throw interruption;
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const transport = createMcpHttpTransport(
        { send },
        { maxRetries: 3, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      );
      const failure: unknown = await transport
        .send({
          url: "https://api005.backblazeb2.com/b2api/v4/b2_create_bucket",
          method: "POST",
          signal: controller.signal,
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ status: 409, code: "operation_status_unknown" });
      expect(failure).not.toBe(inspectionFailure);
      expect(failure instanceof Error ? Reflect.get(failure, "cause") : undefined).toBe(
        interruption,
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({ reasonName: "TimeoutError" });
      expect(warn.mock.calls[0][0]).not.toHaveProperty("reasonCode");
    },
  );

  it("finishes optional inspection of a cyclic cause without changing the write outcome", async () => {
    const interruption = new Error("caller timeout");
    interruption.name = "TimeoutError";
    Object.defineProperty(interruption, "cause", { value: interruption });
    const controller = new AbortController();
    const send = vi.fn<HttpTransport["send"]>(async () => {
      controller.abort(interruption);
      throw interruption;
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const transport = createMcpHttpTransport({ send }, { maxRetries: 0 });

    await expect(
      transport.send({
        url: "https://api005.backblazeb2.com/b2api/v4/b2_create_bucket",
        method: "POST",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: 409, code: "operation_status_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toHaveProperty("reasonCode");
  });
});
