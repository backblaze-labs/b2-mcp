import { B2ReportClient } from "../../src/b2/report-client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { createReportS3Client } from "../../src/s3/client";
import { DeterministicS3ClientFake, testConfig } from "../support/deterministic-fakes";

vi.mock("../../src/s3/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/s3/client")>()),
  createReportS3Client: vi.fn(),
}));

function reportAuth() {
  return {
    accountId: "test-account-123",
    authorizationToken: "mock-token-xyz",
    apiUrl: "https://api005.backblazeb2.com",
    downloadUrl: "https://f005.backblazeb2.com",
    s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
    recommendedPartSize: 100 * 1024 * 1024,
    absoluteMinimumPartSize: 5 * 1024 * 1024,
    capabilities: ["readFiles"],
  };
}

function createReportClient(s3 = new DeterministicS3ClientFake()) {
  const getAuth = vi.fn(async () => reportAuth());
  const getConfig = vi.fn(() => testConfig);
  vi.mocked(createReportS3Client).mockReturnValue(
    s3.asPeerClient() as ReturnType<typeof createReportS3Client>,
  );
  return {
    client: new B2ReportClient({ getAuth, getConfig } as never),
    getAuth,
    s3,
  };
}

describe("B2ReportClient coverage (issue 400)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads an async-iterable body exposed on a function value", async () => {
    // isAsyncIterable() must accept typeof value === "function" bodies.
    const body = function reportBody() {
      /* only used as a function-typed carrier for an asyncIterator */
    } as unknown as {
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
    };
    (body as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = async function* () {
      yield Buffer.from("csv");
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "fn.csv");

    expect(result).toEqual({ text: "csv", bytes: 3, truncated: false });
  });

  it("stops when a later chunk arrives after the byte cap is exactly filled", async () => {
    // First chunk fills the cap exactly; the next chunk hits `remaining <= 0`.
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("abc");
        yield Buffer.from("def");
      },
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "cap.csv", {
      maxBytes: 3,
    });

    expect(result).toEqual({ text: "abc", bytes: 3, truncated: true });
  });

  it("destroys an async-iterable body with a wrapped Error on a non-Error abort reason", async () => {
    const controller = new AbortController();
    const iterator = {
      next: vi.fn(async () => {
        controller.abort("boom-string");
        return { done: false, value: Buffer.from("ignored") };
      }),
      return: vi.fn(async () => ({ done: true, value: undefined as never })),
    };
    const body = {
      destroy: vi.fn(),
      [Symbol.asyncIterator]: () => iterator,
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.downloadReportObjectText("b2-reports-test", "abort-string.csv"),
      ),
    ).rejects.toBe("boom-string");
    // Non-Error reason gets wrapped: destroy sees an Error whose message is the string.
    expect(body.destroy).toHaveBeenCalledWith(expect.objectContaining({ message: "boom-string" }));
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  it("destroys a transformToByteArray body with a wrapped Error on a non-Error abort reason", async () => {
    const controller = new AbortController();
    const destroy = vi.fn();
    // Synchronously abort the parent, then never resolve: the read observes an
    // already-aborted signal and runs the transformToByteArray cleanup path.
    const transformToByteArray = vi.fn(
      () =>
        new Promise<Uint8Array>(() => {
          controller.abort("transform-boom");
        }),
    );
    const body = { destroy, transformToByteArray };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.downloadReportObjectText("b2-reports-test", "transform-abort.csv"),
      ),
    ).rejects.toBe("transform-boom");
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ message: "transform-boom" }));
  });

  it("destroys a transformToByteArray body with the original Error abort reason", async () => {
    const controller = new AbortController();
    const destroy = vi.fn();
    const reason = new Error("transform-error-reason");
    const transformToByteArray = vi.fn(
      () =>
        new Promise<Uint8Array>(() => {
          controller.abort(reason);
        }),
    );
    const body = { destroy, transformToByteArray };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.downloadReportObjectText("b2-reports-test", "transform-error.csv"),
      ),
    ).rejects.toBe(reason);
    expect(destroy).toHaveBeenCalledWith(reason);
  });

  it("aborts immediately when the parent signal is already aborted with no reason", async () => {
    // Fake parent signal: aborted with an undefined reason exercises the
    // `parent?.reason ?? abortError()` fallback and the pre-run aborted branch.
    const listeners: Array<() => void> = [];
    const parent = {
      aborted: true,
      reason: undefined,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body: { transformToByteArray: vi.fn(async () => Uint8Array.of(97)) },
    });
    const { client } = createReportClient(s3);

    await expect(
      runWithMcpRequestSignal(parent, () =>
        client.downloadReportObjectText("b2-reports-test", "pre-aborted.csv"),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
