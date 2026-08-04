/**
 * Unit tests for B2 native API tool handlers.
 * Uses jest.mock('axios') so no real network calls are made.
 *
 * B2Client.call() uses axios(config) (callable form), so we mock the
 * entire module rather than spying on individual methods.
 * B2AuthManager uses axios.get() for the authorize endpoint.
 */

import axios from "axios";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { runWithMcpRequestSignal } from "../../src/request-context";

// ── Mock axios ────────────────────────────────────────────────────────────────

jest.mock("axios");

// Cast to jest mock so we can set return values
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

function parseResult(result: any) {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-app-key-secret",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

// v3 auth response shape — flattened by B2AuthManager.authorize()
const mockAuthData = {
  accountId: "test-account-123",
  authorizationToken: "mock-token-xyz",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api005.backblazeb2.com",
      downloadUrl: "https://f005.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      recommendedPartSize: 100 * 1024 * 1024,
      absoluteMinimumPartSize: 5 * 1024 * 1024,
    },
  },
};

let server: McpServer;

/** Set up both the auth GET mock and the API callable mock. */
function setupMocks(apiResponseData: Record<string, unknown>) {
  // Auth manager calls axios.get for b2_authorize_account
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  // B2Client.call() uses axios(config) — mockedAxios is the callable mock
  mockedAxios.mockResolvedValue({ data: apiResponseData } as any);
}

beforeEach(() => {
  invalidateAuthManagerCache();
  jest.clearAllMocks();
  // Default: auth succeeds, API returns empty object
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  mockedAxios.mockResolvedValue({ data: {} } as any);
  server = createServer(testConfig);
});

// ── b2_authorize_account ──────────────────────────────────────────────────────

describe("b2_authorize_account", () => {
  it("returns accountId and downloadUrl from auth response", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    const result = parseResult(await callTool(server, "b2_authorize_account", {}));
    expect(result.accountId).toBe("test-account-123");
    expect(result.downloadUrl).toBe("https://f005.backblazeb2.com");
    expect(result.authorizationToken).toBeUndefined(); // should be redacted
  });

  it("calls the B2 authorize endpoint with basic auth", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    await callTool(server, "b2_authorize_account", {});
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("b2_authorize_account"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }),
      }),
    );
  });
});

// ── B2Client 401 re-auth (core resilience path) ───────────────────────────────

describe("B2Client 401 re-auth-and-retry", () => {
  it("re-authorizes and retries exactly once on a 401, then succeeds", async () => {
    // Authorize succeeds every time; the first API call 401s (token expired
    // between our 23h cache and B2's 24h lifetime), the retry succeeds.
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios
      .mockRejectedValueOnce({ response: { status: 401 }, isAxiosError: true })
      .mockResolvedValueOnce({ data: { buckets: [] } });

    const result = parseResult(await callTool(server, "b2_list_buckets", {}));
    expect(result.buckets).toEqual([]); // recovered silently
    expect(mockedAxios).toHaveBeenCalledTimes(2); // original + one retry
    expect(mockedAxios.get).toHaveBeenCalledTimes(2); // re-authorized after invalidate
  });

  it("does not retry more than once — a second 401 surfaces the error", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue({ response: { status: 401 }, isAxiosError: true });

    const result = await callTool(server, "b2_list_buckets", {});
    expect(result.isError).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(2); // original + exactly one retry, then throws
  });
});

// ── b2_list_buckets ───────────────────────────────────────────────────────────

describe("b2_list_buckets", () => {
  const mockBuckets = {
    buckets: [
      { bucketId: "bucket-001", bucketName: "my-bucket", bucketType: "allPrivate" },
      { bucketId: "bucket-002", bucketName: "public-bucket", bucketType: "allPublic" },
    ],
  };

  beforeEach(() => setupMocks(mockBuckets));

  it("returns a buckets array", async () => {
    const result = parseResult(await callTool(server, "b2_list_buckets", {}));
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].bucketName).toBe("my-bucket");
  });

  it("passes bucketTypes filter when provided", async () => {
    await callTool(server, "b2_list_buckets", { bucketTypes: ["allPrivate"] });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("b2_list_buckets"),
        data: expect.objectContaining({ bucketTypes: ["allPrivate"] }),
      }),
    );
  });

  it("passes the current MCP request abort signal to B2 API calls", async () => {
    const abort = new AbortController();

    await runWithMcpRequestSignal(abort.signal, () => callTool(server, "b2_list_buckets", {}));

    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ signal: abort.signal }));
  });

  const manyBuckets = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      bucketId: `bucket-${i}`,
      bucketName: `bucket-${i}`,
      bucketType: "allPrivate",
    }));

  // NOTE: this harness calls the handler directly, so the schema's .default(100)
  // (applied by the MCP SDK's zod parse in production) is not injected here — we
  // pass `limit` explicitly to exercise the truncation logic itself.
  it("caps to the requested limit and reports truncation", async () => {
    setupMocks({ buckets: manyBuckets(150) });
    const result = parseResult(await callTool(server, "b2_list_buckets", { limit: 100 }));
    expect(result.buckets).toHaveLength(100);
    expect(result.bucket_count).toBe(100);
    expect(result.total_bucket_count).toBe(150);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("first 100 of 150");
  });

  it("returns all buckets when limit covers the total, and omits the truncation flag", async () => {
    setupMocks({ buckets: manyBuckets(150) });
    const result = parseResult(await callTool(server, "b2_list_buckets", { limit: 1000 }));
    expect(result.buckets).toHaveLength(150);
    expect(result.total_bucket_count).toBe(150);
    expect(result.truncated).toBeUndefined();
  });
});

// ── b2_create_bucket ──────────────────────────────────────────────────────────

describe("b2_create_bucket", () => {
  beforeEach(() =>
    setupMocks({
      bucketId: "new-bucket-id",
      bucketName: "test-new-bucket",
      bucketType: "allPrivate",
      accountId: "test-account-123",
    }),
  );

  it("returns the created bucket info", async () => {
    const result = parseResult(
      await callTool(server, "b2_create_bucket", {
        bucketName: "test-new-bucket",
        bucketType: "allPrivate",
      }),
    );
    expect(result.bucketId).toBe("new-bucket-id");
    expect(result.bucketName).toBe("test-new-bucket");
  });

  it("passes bucketName and bucketType to the API", async () => {
    await callTool(server, "b2_create_bucket", {
      bucketName: "my-bucket",
      bucketType: "allPublic",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("b2_create_bucket"),
        data: expect.objectContaining({ bucketName: "my-bucket", bucketType: "allPublic" }),
      }),
    );
  });

  it("forwards fileLockEnabled when set (Object Lock enabled at creation)", async () => {
    await callTool(server, "b2_create_bucket", {
      bucketName: "locked-bucket",
      bucketType: "allPrivate",
      fileLockEnabled: true,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fileLockEnabled: true }),
      }),
    );
  });

  it("omits fileLockEnabled when not provided", async () => {
    await callTool(server, "b2_create_bucket", {
      bucketName: "plain-bucket",
      bucketType: "allPrivate",
    });
    const data = (mockedAxios.mock.calls[0][0] as unknown as { data: Record<string, unknown> })
      .data;
    expect(data).not.toHaveProperty("fileLockEnabled");
  });
});

// ── b2_delete_bucket ──────────────────────────────────────────────────────────

describe("b2_delete_bucket", () => {
  beforeEach(() => setupMocks({ bucketId: "bucket-001", bucketName: "my-bucket" }));

  it("returns success message with bucketId", async () => {
    const result = await callTool(server, "b2_delete_bucket", {
      bucketId: "bucket-001",
      confirm: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("bucket-001");
  });

  it("is blocked without confirm under the default policy (gate is wired into the handler)", async () => {
    const result = await callTool(server, "b2_delete_bucket", { bucketId: "bucket-001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/i);
    // The destructive call must NOT have reached the B2 API.
    expect(mockedAxios).not.toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("b2_delete_bucket"),
      }),
    );
  });
});

// ── durable-secret-producing tools ────────────────────────────────────────────

describe("durable-secret-producing tools", () => {
  it("keeps stale tool names callable as non-secret unavailable stubs", async () => {
    const tools = getRegisteredTools(server) ?? {};
    for (const name of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      expect(tools[name]).toBeDefined();
      const result = await callTool(server, name, { keyName: "stale-client" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tool_unavailable");
      expect(result.content[0].text).not.toContain("mock-token-xyz");
    }
    expect(mockedAxios).not.toHaveBeenCalled();
  });
});

// ── b2_list_keys ──────────────────────────────────────────────────────────────

describe("b2_list_keys", () => {
  beforeEach(() =>
    setupMocks({
      keys: [
        { keyName: "master", applicationKeyId: "key-master", capabilities: ["*"] },
        { keyName: "readonly", applicationKeyId: "key-ro", capabilities: ["readFiles"] },
      ],
      nextApplicationKeyId: null,
    }),
  );

  it("returns list of application keys", async () => {
    const result = parseResult(await callTool(server, "b2_list_keys", {}));
    expect(result.keys).toHaveLength(2);
    expect(result.keys[1].keyName).toBe("readonly");
  });
});

// ── b2_delete_key ─────────────────────────────────────────────────────────────

describe("b2_delete_key", () => {
  beforeEach(() => setupMocks({ applicationKeyId: "key-ro", keyName: "readonly" }));

  it("returns deleted key info and sends applicationKeyId to the API", async () => {
    const result = parseResult(
      await callTool(server, "b2_delete_key", { applicationKeyId: "key-ro", confirm: true }),
    );
    expect(result.applicationKeyId).toBe("key-ro");
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ applicationKeyId: "key-ro" }) }),
    );
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe("Error propagation", () => {
  it("b2_list_buckets returns isError on 401 auth failure", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue({
      response: {
        status: 401,
        data: { status: 401, code: "unauthorized", message: "Bad auth token." },
      },
    } as any);
    const result = await callTool(server, "b2_list_buckets", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unauthorized");
  });

  it("b2_list_keys returns isError for bad_request", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue({
      response: {
        status: 400,
        data: { status: 400, code: "bad_request", message: "Bad request." },
      },
    } as any);
    const result = await callTool(server, "b2_list_keys", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("400");
  });

  it("b2_get_bucket_notification_rules returns isError on network error", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue(new Error("Network timeout") as any);
    const result = await callTool(server, "b2_get_bucket_notification_rules", {
      bucketId: "bucket-001",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network timeout");
  });
});

// ── b2_update_bucket ──────────────────────────────────────────────────────────

describe("b2_update_bucket", () => {
  beforeEach(() =>
    setupMocks({
      bucketId: "bucket-001",
      bucketName: "my-bucket",
      bucketType: "allPublic",
      accountId: "test-account-123",
    }),
  );

  it("returns updated bucket info", async () => {
    const result = parseResult(
      await callTool(server, "b2_update_bucket", {
        bucketId: "bucket-001",
        bucketType: "allPublic",
        confirm: true,
      }),
    );
    expect(result.bucketId).toBe("bucket-001");
    expect(result.bucketType).toBe("allPublic");
  });

  it("passes bucketType to the API", async () => {
    await callTool(server, "b2_update_bucket", {
      bucketId: "bucket-001",
      bucketType: "allPrivate",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bucketType: "allPrivate" }) }),
    );
  });

  it("enables Object Lock on an existing bucket (B2 native allows the retrofit)", async () => {
    await callTool(server, "b2_update_bucket", { bucketId: "bucket-001", fileLockEnabled: true });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileLockEnabled: true }) }),
    );
  });

  it("forwards defaultRetention with the flat { mode, period } shape", async () => {
    const defaultRetention = { mode: "governance", period: { duration: 7, unit: "days" } };
    await callTool(server, "b2_update_bucket", { bucketId: "bucket-001", defaultRetention });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ defaultRetention }) }),
    );
  });
});

// ── b2_get_bucket_notification_rules ─────────────────────────────────────────

describe("b2_get_bucket_notification_rules", () => {
  beforeEach(() =>
    setupMocks({
      bucketId: "bucket-001",
      eventNotificationRules: [
        {
          name: "on-upload",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          targetConfiguration: { targetType: "webhook", url: "https://example.com/hook" },
        },
      ],
    }),
  );

  it("returns notification rules for the bucket", async () => {
    const result = parseResult(
      await callTool(server, "b2_get_bucket_notification_rules", {
        bucketId: "bucket-001",
      }),
    );
    expect(result.eventNotificationRules).toHaveLength(1);
    expect(result.eventNotificationRules[0].name).toBe("on-upload");
  });
});

// ── b2_set_bucket_notification_rules ─────────────────────────────────────────

describe("b2_set_bucket_notification_rules", () => {
  beforeEach(() =>
    setupMocks({
      bucketId: "bucket-001",
      eventNotificationRules: [],
    }),
  );

  it("forwards an explicit objectNamePrefix and returns the updated configuration", async () => {
    const rules = [
      {
        name: "on-delete",
        objectNamePrefix: "incoming/",
        eventTypes: ["b2:ObjectDeleted:*"],
        isEnabled: true,
        targetConfiguration: { targetType: "webhook", url: "https://example.com/hook" },
      },
    ];
    const result = parseResult(
      await callTool(server, "b2_set_bucket_notification_rules", {
        bucketId: "bucket-001",
        eventNotificationRules: rules,
      }),
    );
    expect(result.bucketId).toBe("bucket-001");
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bucketId: "bucket-001", eventNotificationRules: rules }),
      }),
    );
  });

  it("injects objectNamePrefix='' when a rule omits it (B2 requires the field)", async () => {
    const rules = [
      {
        name: "on-create",
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: true,
        targetConfiguration: { targetType: "webhook", url: "https://example.com/hook" },
      },
    ];
    await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "bucket-001",
      eventNotificationRules: rules,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventNotificationRules: [expect.objectContaining({ objectNamePrefix: "" })],
        }),
      }),
    );
  });
});

// ── b2_update_file_legal_hold ─────────────────────────────────────────────────

describe("b2_update_file_legal_hold", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "file-001",
      fileName: "doc.pdf",
      legalHold: "on",
    }),
  );

  it("returns updated legal hold status", async () => {
    const result = parseResult(
      await callTool(server, "b2_update_file_legal_hold", {
        fileId: "file-001",
        fileName: "doc.pdf",
        legalHold: "on",
      }),
    );
    expect(result.legalHold).toBe("on");
  });

  it("forwards legalHold to the API as a bare string (B2 write-API shape)", async () => {
    await callTool(server, "b2_update_file_legal_hold", {
      fileId: "file-001",
      fileName: "doc.pdf",
      legalHold: "off",
      confirm: true, // removing a legal hold is gated
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ legalHold: "off" }),
      }),
    );
  });
});

// ── Partner API tools ─────────────────────────────────────────────────────────

describe("b2_list_groups", () => {
  const mockGroups = {
    accountId: "test-account-123",
    groups: [{ groupId: "254", groupName: "Partner Group 2", groupProducts: ["STORAGE"] }],
    nextGroupId: null,
  };

  beforeEach(() => setupMocks(mockGroups));

  it("returns groups array", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_groups", {
        adminAccountId: "test-account-123",
      }),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].groupName).toBe("Partner Group 2");
  });

  it("uses b2api/v3 in the request URL", async () => {
    await callTool(server, "b2_list_groups", { adminAccountId: "test-account-123" });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("b2api/v3") }),
    );
  });

  it("sends adminAccountId as a query param (GET request)", async () => {
    await callTool(server, "b2_list_groups", { adminAccountId: "test-account-123" });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        params: expect.objectContaining({ adminAccountId: "test-account-123" }),
      }),
    );
  });

  it("forwards optional groupName filter when provided", async () => {
    await callTool(server, "b2_list_groups", {
      adminAccountId: "test-account-123",
      groupName: "Partner Group 2",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ groupName: "Partner Group 2" }),
      }),
    );
  });
});

describe("b2_eject_group_member", () => {
  const mockEjected = {
    accountId: "member-account-xyz",
    groupId: "254",
    groupName: "Partner Group 2",
    email: "member@example.com",
    region: "us-west",
  };

  beforeEach(() => setupMocks(mockEjected));

  it("returns ejected member info", async () => {
    const result = parseResult(
      await callTool(server, "b2_eject_group_member", {
        adminAccountId: "test-account-123",
        groupId: "254",
        memberAccountId: "member-account-xyz",
        confirm: true,
      }),
    );
    expect(result.accountId).toBe("member-account-xyz");
    expect(result.groupId).toBe("254");
  });

  it("uses b2api/v3 in the request URL", async () => {
    await callTool(server, "b2_eject_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberAccountId: "member-xyz",
      confirm: true,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("b2api/v3") }),
    );
  });

  it("passes optional email when provided", async () => {
    await callTool(server, "b2_eject_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberAccountId: "member-xyz",
      email: "new@example.com",
      confirm: true,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "new@example.com" }) }),
    );
  });
});

describe("b2_list_group_members", () => {
  const mockMembers = {
    groupId: "254",
    groupName: "Partner Group 2",
    nextEmail: null,
    groupMembers: [
      { accountId: "acc-001", email: "member1@example.com", region: "us-west" },
      { accountId: "acc-002", email: "member2@example.com", region: "us-west" },
    ],
  };

  beforeEach(() => setupMocks(mockMembers));

  it("returns groupMembers array", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_group_members", {
        adminAccountId: "test-account-123",
        groupId: "254",
      }),
    );
    expect(result.groupMembers).toHaveLength(2);
    expect(result.groupMembers[0].email).toBe("member1@example.com");
  });

  it("uses b2api/v3 path and GET method", async () => {
    await callTool(server, "b2_list_group_members", {
      adminAccountId: "test-account-123",
      groupId: "254",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining("b2api/v3"),
        params: expect.objectContaining({ adminAccountId: "test-account-123", groupId: "254" }),
      }),
    );
  });

  it("forwards startEmail when provided", async () => {
    await callTool(server, "b2_list_group_members", {
      adminAccountId: "test-account-123",
      groupId: "254",
      startEmail: "first@example.com",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ startEmail: "first@example.com" }),
      }),
    );
  });
});

// ── b2_update_file_retention ──────────────────────────────────────────────────

describe("b2_update_file_retention", () => {
  const retentionTimestamp = Date.now() + 365 * 24 * 60 * 60 * 1000;
  beforeEach(() =>
    setupMocks({
      fileId: "file-001",
      fileName: "audit.log",
      fileRetention: { mode: "compliance", retainUntilTimestamp: retentionTimestamp },
    }),
  );

  it("forwards a flat fileRetention to the API (B2 write-API shape, no read-only wrapper)", async () => {
    const result = parseResult(
      await callTool(server, "b2_update_file_retention", {
        fileId: "file-001",
        fileName: "audit.log",
        fileRetention: { mode: "compliance", retainUntilTimestamp: retentionTimestamp },
      }),
    );
    expect(result.fileRetention.mode).toBe("compliance");
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fileRetention: { mode: "compliance", retainUntilTimestamp: retentionTimestamp },
        }),
      }),
    );
  });

  it("passes bypassGovernance when set to true", async () => {
    await callTool(server, "b2_update_file_retention", {
      fileId: "file-001",
      fileName: "doc.pdf",
      fileRetention: { mode: "governance", retainUntilTimestamp: retentionTimestamp },
      bypassGovernance: true,
      confirm: true, // bypassGovernance is gated
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bypassGovernance: true }) }),
    );
  });

  it("clears retention with mode: null", async () => {
    await callTool(server, "b2_update_file_retention", {
      fileId: "file-001",
      fileName: "doc.pdf",
      fileRetention: { mode: null, retainUntilTimestamp: null },
      bypassGovernance: true,
      confirm: true, // clearing retention is gated
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fileRetention: { mode: null, retainUntilTimestamp: null },
        }),
      }),
    );
  });
});

// ── webhook notification-rules hardening ───────────────────────────────────────

describe("b2 notification-rules webhook hardening", () => {
  const ruleWith = (url: string) => ({
    name: "r",
    eventTypes: ["b2:ObjectCreated:*"],
    isEnabled: true,
    targetConfiguration: { targetType: "webhook" as const, url },
  });

  it("rejects a non-HTTPS webhook URL", async () => {
    setupMocks({});
    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "b",
      eventNotificationRules: [ruleWith("http://example.com/hook")],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/https/i);
  });

  it("rejects an internal/SSRF webhook URL", async () => {
    setupMocks({});
    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "b",
      eventNotificationRules: [ruleWith("https://169.254.169.254/latest/meta-data")],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/private|loopback|link-local|localhost/i);
  });

  it("rejects SSRF-bypass URL forms (decimal/hex/octal numeric IPs + IPv4-mapped IPv6)", async () => {
    for (const url of [
      "https://2130706433/hook", // decimal → normalizes to 127.0.0.1
      "https://0x7f000001/hook", // hex → 127.0.0.1
      "https://0177.0.0.1/hook", // octal → 127.0.0.1
      "https://[::ffff:127.0.0.1]/hook", // IPv4-mapped IPv6
    ]) {
      setupMocks({});
      const res = await callTool(server, "b2_set_bucket_notification_rules", {
        bucketId: "b",
        eventNotificationRules: [ruleWith(url)],
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/private|loopback|numeric|IPv6/i);
    }
  });

  it("accepts a valid public HTTPS webhook URL", async () => {
    setupMocks({ eventNotificationRules: [] });
    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "b",
      eventNotificationRules: [ruleWith("https://hooks.example.com/b2")],
    });
    expect(res.isError).toBeFalsy();
  });

  it("redacts hmacSha256SigningSecret + custom-header values in get responses", async () => {
    setupMocks({
      eventNotificationRules: [
        {
          name: "r",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          targetConfiguration: {
            targetType: "webhook",
            url: "https://example.com/hook",
            hmacSha256SigningSecret: "supersecret",
            customHeaders: [{ name: "X-Auth", value: "token123" }],
          },
        },
      ],
    });
    const res = parseResult(
      await callTool(server, "b2_get_bucket_notification_rules", { bucketId: "b" }),
    );
    const tc = res.eventNotificationRules[0].targetConfiguration;
    expect(tc.hmacSha256SigningSecret).toBe("[redacted]");
    expect(tc.customHeaders[0].value).toBe("[redacted]");
    expect(JSON.stringify(res)).not.toContain("supersecret");
    expect(JSON.stringify(res)).not.toContain("token123");
  });
});
