import {
  type HttpResponse,
  type HttpTransport,
  B2Client as SdkB2Client,
} from "@backblaze-labs/b2-sdk";
import type * as AuthModule from "../../src/auth";
import type { B2Config } from "../../src/utils/types";
import { authorizeResponse } from "../support/sdk-test-helpers";

let auth: typeof AuthModule;
let context: typeof import("../../src/request-context");
let policy: typeof import("../../src/utils/tool-capabilities");
let retry: typeof import("../../src/utils/retry");

beforeEach(async () => {
  vi.resetModules();
  auth = await import("../../src/auth");
  context = await import("../../src/request-context");
  policy = await import("../../src/utils/tool-capabilities");
  retry = await import("../../src/utils/retry");
  retry._resetRetryBudget();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  auth.setB2SdkClientFactoryForTests(null);
  retry._resetRetryBudget();
  vi.restoreAllMocks();
});

const readUrl = "https://api005.backblazeb2.com/b2api/v4/b2_list_buckets";
const writeUrl = "https://api005.backblazeb2.com/b2api/v4/b2_create_bucket";
const config: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-master-key-id",
  masterKey: "test-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
};

function wrapped(inner: HttpTransport) {
  return auth.createMcpHttpTransport(inner, {
    maxRetries: 0,
    requestTimeoutMs: 30_000,
  });
}

function jsonResponse(text: string, json: HttpResponse["json"]): HttpResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    json,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

describe("plain caller-abort reasons", () => {
  it.each(["request", "MCP context"])(
    "normalizes a pre-aborted plain reason supplied through the %s signal",
    async (source) => {
      const reason = { name: "AbortError", message: "adapter cancellation detail" };
      const controller = new AbortController();
      controller.abort(reason);
      const send = vi.fn<HttpTransport["send"]>(async () => {
        throw new Error("A pre-aborted request must not be dispatched");
      });
      const transport = wrapped({ send });
      const operation = () =>
        transport.send({
          url: readUrl,
          method: "POST",
          ...(source === "request" ? { signal: controller.signal } : {}),
        });
      const pending =
        source === "request"
          ? operation()
          : context.runWithMcpRequestSignal(controller.signal, operation);
      const error = await pending.then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "AbortError", message: "Aborted" });
      expect(error).not.toBe(reason);
      expect(controller.signal.reason).toBe(reason);
      expect(reason).toEqual({ name: "AbortError", message: "adapter cancellation detail" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: "read", url: readUrl },
    { operation: "write", url: writeUrl },
  ])(
    "preserves the $operation outcome when a plain reason aborts during dispatch",
    async (test) => {
      const reason = { name: "AbortError", message: "adapter cancellation detail" };
      const controller = new AbortController();
      const send = vi.fn<HttpTransport["send"]>(async () => {
        controller.abort(reason);
        throw reason;
      });
      const error = await wrapped({ send })
        .send({ url: test.url, method: "POST", signal: controller.signal })
        .then(
          () => undefined,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(Error);
      if (test.operation === "read") {
        expect(error).toMatchObject({ name: "AbortError", message: "Aborted" });
      } else {
        expect(error).toMatchObject({
          status: 409,
          code: "operation_status_unknown",
          cause: reason,
        });
        if (error instanceof Error) expect(Reflect.get(error, "cause")).toBe(reason);
      }
      expect(controller.signal.reason).toBe(reason);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});

describe("successful-response capture with custom JSON adapters", () => {
  it("retains an adapter-hydrated payload when its optional JSON clone fails", async () => {
    const text = '{"count":"9007199254740993","label":"public"}';
    // A custom adapter may use JSON.parse's reviver. Native Response.json does
    // not produce BigInt; this exercises the defensive adapter boundary.
    const payload: { count: bigint; label: string } = JSON.parse(text, (key, value) =>
      key === "count" ? BigInt(value) : value,
    );
    const send = vi.fn<HttpTransport["send"]>(async () =>
      jsonResponse(text, async <T>() => payload as T),
    );
    const capture: AuthModule.SuccessfulResponseCapture = { endpoint: "b2_list_buckets" };

    const result = await auth.runWithSuccessfulResponseCapture(capture, async () => {
      const response = await wrapped({ send }).send({ url: readUrl, method: "POST" });
      return response.json<typeof payload>();
    });

    expect(result).toBe(payload);
    expect(result.count).toBe(9_007_199_254_740_993n);
    expect(capture.response).toBe(payload);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed reader without recording a successful capture", async () => {
    const failure = new SyntaxError("truncated adapter JSON");
    const send = vi.fn<HttpTransport["send"]>(async () =>
      jsonResponse("", async <T>(): Promise<T> => {
        throw failure;
      }),
    );
    const capture: AuthModule.SuccessfulResponseCapture = { endpoint: "b2_list_buckets" };
    const operation = auth.runWithSuccessfulResponseCapture(capture, async () => {
      const response = await wrapped({ send }).send({ url: readUrl, method: "POST" });
      return response.json();
    });

    await expect(operation).rejects.toBe(failure);
    expect(capture).not.toHaveProperty("response");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("SDK normalization before capability flattening", () => {
  it.each([
    {
      shape: "absent allowed",
      allowed: undefined,
      legacy: undefined,
      expected: [],
      readAllowed: false,
    },
    {
      shape: "absent capabilities",
      allowed: {},
      legacy: undefined,
      expected: [],
      readAllowed: false,
    },
    {
      shape: "null capabilities",
      allowed: { capabilities: null },
      legacy: undefined,
      expected: [],
      readAllowed: false,
    },
    {
      shape: "legacy read capabilities",
      allowed: {},
      legacy: ["readFiles"],
      expected: ["readFiles"],
      readAllowed: true,
    },
  ])("keeps $shape wire data from granting write capabilities", async (test) => {
    const base = authorizeResponse();
    const wire = JSON.stringify({
      ...base,
      apiInfo: {
        storageApi: {
          ...base.apiInfo.storageApi,
          allowed: test.allowed,
          capabilities: test.legacy,
        },
      },
    });
    const send = vi.fn<HttpTransport["send"]>(async () =>
      jsonResponse(wire, async <T>() => JSON.parse(wire) as T),
    );
    const client = new SdkB2Client({
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      transport: wrapped({ send }),
      retry: { maxRetries: 0 },
    });
    auth.setB2SdkClientFactoryForTests(() => ({ client }));

    const result = await new auth.B2AuthManager(config).getAuth();

    expect(result.capabilities).toEqual(test.expected);
    expect(client.accountInfo.getAuth()?.apiInfo.storageApi.allowed.capabilities).toEqual(
      test.expected,
    );
    expect(client.hasCapabilities(["writeBuckets"])).toEqual({
      ok: false,
      missing: ["writeBuckets"],
    });
    expect(policy.isToolEnabled("b2_create_bucket", new Set(result.capabilities))).toBe(false);
    expect(client.hasCapabilities(["readFiles"]).ok).toBe(test.readAllowed);
    expect(policy.isToolEnabled("s3_get_object", new Set(result.capabilities))).toBe(
      test.readAllowed,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].url).toMatch(/\/b2api\/v\d+\/b2_authorize_account$/);
  });
});
