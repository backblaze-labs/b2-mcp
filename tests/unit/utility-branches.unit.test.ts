import { dateFromTimestamp } from "../../src/utils/date";
import {
  contentLengthExceedsLimit,
  MAX_MCP_BODY_BYTES,
  readCappedBodyBytes,
} from "../../src/utils/http-body-limit";
import { forEachBounded } from "../../src/utils/concurrency";

describe("small utility branch coverage", () => {
  it("converts numeric timestamps and ignores omitted values", () => {
    expect(dateFromTimestamp(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(dateFromTimestamp(undefined)).toBeUndefined();
  });

  it("treats invalid content-length values as within the body limit", () => {
    expect(contentLengthExceedsLimit(new Headers({ "content-length": "not-a-number" }))).toBe(
      false,
    );
    expect(
      contentLengthExceedsLimit(new Headers({ "content-length": String(MAX_MCP_BODY_BYTES + 1) })),
    ).toBe(true);
  });

  it("returns an empty body when the request has no stream", async () => {
    await expect(
      readCappedBodyBytes(new Request("https://example.test", { method: "POST" })),
    ).resolves.toHaveLength(0);
  });

  it("reports aborted empty bounded work without calling the worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = vi.fn<() => Promise<void>>();

    await expect(forEachBounded([], { signal: controller.signal }, worker)).resolves.toEqual({
      maxConcurrency: 0,
      aborted: true,
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops bounded workers before processing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = vi.fn<() => Promise<void>>();

    await expect(
      forEachBounded(["a", "b"], { signal: controller.signal }, worker),
    ).resolves.toEqual({
      maxConcurrency: 2,
      aborted: true,
    });
    expect(worker).not.toHaveBeenCalled();
  });
});
