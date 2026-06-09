/**
 * Unit tests for B2 native API tool handlers.
 * Uses jest.mock('axios') so no real network calls are made.
 *
 * B2Client.call() uses axios(config) (callable form), so we mock the
 * entire module rather than spying on individual methods.
 * B2AuthManager uses axios.get() for the authorize endpoint.
 */

import axios from "axios";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Mock axios ────────────────────────────────────────────────────────────────

jest.mock("axios");

// Cast to jest mock so we can set return values
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = (server as any)._registeredTools?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
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
  region: "us-west-004",
  largeFileThreshold: 100 * 1024 * 1024,
  partSize: 100 * 1024 * 1024,
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
  server = createServer(testConfig);
  jest.clearAllMocks();
  // Default: auth succeeds, API returns empty object
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  mockedAxios.mockResolvedValue({ data: {} } as any);
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
});

// ── b2_delete_bucket ──────────────────────────────────────────────────────────

describe("b2_delete_bucket", () => {
  beforeEach(() => setupMocks({ bucketId: "bucket-001", bucketName: "my-bucket" }));

  it("returns success message with bucketId", async () => {
    const result = await callTool(server, "b2_delete_bucket", { bucketId: "bucket-001" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("bucket-001");
  });
});

// ── b2_list_file_names ────────────────────────────────────────────────────────

describe("b2_list_file_names", () => {
  const mockFiles = {
    files: [
      {
        fileId: "file-001",
        fileName: "photo.jpg",
        contentLength: 102400,
        contentType: "image/jpeg",
      },
      {
        fileId: "file-002",
        fileName: "doc.pdf",
        contentLength: 51200,
        contentType: "application/pdf",
      },
    ],
    nextFileName: null,
  };

  beforeEach(() => setupMocks(mockFiles));

  it("returns files array with expected shape", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_file_names", { bucketId: "bucket-001" }),
    );
    expect(result.files).toHaveLength(2);
    expect(result.files[0].fileName).toBe("photo.jpg");
    expect(result.files[1].contentType).toBe("application/pdf");
  });

  it("passes maxFileCount to the API", async () => {
    await callTool(server, "b2_list_file_names", { bucketId: "bucket-001", maxFileCount: 25 });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxFileCount: 25 }) }),
    );
  });

  it("passes prefix filter when provided", async () => {
    await callTool(server, "b2_list_file_names", { bucketId: "bucket-001", prefix: "photos/" });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prefix: "photos/" }) }),
    );
  });
});

// ── b2_get_file_info ──────────────────────────────────────────────────────────

describe("b2_get_file_info", () => {
  const mockFileInfo = {
    fileId: "file-001",
    fileName: "photo.jpg",
    contentLength: 102400,
    contentType: "image/jpeg",
    fileInfo: { author: "Kevin" },
    uploadTimestamp: 1700000000000,
  };

  beforeEach(() => setupMocks(mockFileInfo));

  it("returns file metadata", async () => {
    const result = parseResult(await callTool(server, "b2_get_file_info", { fileId: "file-001" }));
    expect(result.fileId).toBe("file-001");
    expect(result.fileName).toBe("photo.jpg");
    expect(result.contentLength).toBe(102400);
  });
});

// ── b2_hide_file ──────────────────────────────────────────────────────────────

describe("b2_hide_file", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "hide-marker-001",
      fileName: "photo.jpg",
      action: "hide",
      uploadTimestamp: Date.now(),
    }),
  );

  it("returns the hide marker file info", async () => {
    const result = parseResult(
      await callTool(server, "b2_hide_file", {
        bucketId: "bucket-001",
        fileName: "photo.jpg",
      }),
    );
    expect(result.action).toBe("hide");
    expect(result.fileName).toBe("photo.jpg");
  });
});

// ── b2_copy_file ──────────────────────────────────────────────────────────────

describe("b2_copy_file", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "copy-001",
      fileName: "photo-copy.jpg",
      contentLength: 102400,
      action: "copy",
    }),
  );

  it("returns copied file info", async () => {
    const result = parseResult(
      await callTool(server, "b2_copy_file", {
        sourceFileId: "file-001",
        fileName: "photo-copy.jpg",
      }),
    );
    expect(result.fileId).toBe("copy-001");
    expect(result.fileName).toBe("photo-copy.jpg");
  });
});

// ── b2_list_file_versions ─────────────────────────────────────────────────────

describe("b2_list_file_versions", () => {
  beforeEach(() =>
    setupMocks({
      files: [
        { fileId: "v1", fileName: "doc.pdf", action: "upload" },
        { fileId: "v2", fileName: "doc.pdf", action: "hide" },
      ],
      nextFileId: null,
      nextFileName: null,
    }),
  );

  it("returns version history with action types", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_file_versions", { bucketId: "bucket-001" }),
    );
    expect(result.files).toHaveLength(2);
    expect(result.files[0].action).toBe("upload");
    expect(result.files[1].action).toBe("hide");
  });
});

// ── b2_create_key ─────────────────────────────────────────────────────────────

describe("b2_create_key", () => {
  beforeEach(() =>
    setupMocks({
      keyName: "test-key",
      applicationKeyId: "key-123",
      applicationKey: "secret-abc",
      capabilities: ["readFiles", "writeFiles"],
    }),
  );

  it("returns the new key info including keyId", async () => {
    const result = parseResult(
      await callTool(server, "b2_create_key", {
        keyName: "test-key",
        capabilities: ["readFiles", "writeFiles"],
      }),
    );
    expect(result.keyName).toBe("test-key");
    expect(result.applicationKeyId).toBe("key-123");
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

// ── b2_get_download_authorization ────────────────────────────────────────────

describe("b2_get_download_authorization", () => {
  beforeEach(() =>
    setupMocks({
      bucketId: "bucket-001",
      fileNamePrefix: "photos/",
      authorizationToken: "download-token-xyz",
    }),
  );

  it("returns an authorization token", async () => {
    const result = parseResult(
      await callTool(server, "b2_get_download_authorization", {
        bucketId: "bucket-001",
        fileNamePrefix: "photos/",
        validDurationInSeconds: 3600,
      }),
    );
    expect(result.authorizationToken).toBe("download-token-xyz");
    expect(result.bucketId).toBe("bucket-001");
  });
});

// ── b2_start_large_file ───────────────────────────────────────────────────────

describe("b2_start_large_file", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "large-file-001",
      fileName: "large-video.mp4",
      accountId: "test-account-123",
      bucketId: "bucket-001",
      contentType: "video/mp4",
    }),
  );

  it("returns the new large file ID and metadata", async () => {
    const result = parseResult(
      await callTool(server, "b2_start_large_file", {
        bucketId: "bucket-001",
        fileName: "large-video.mp4",
        contentType: "video/mp4",
      }),
    );
    expect(result.fileId).toBe("large-file-001");
    expect(result.fileName).toBe("large-video.mp4");
  });
});

// ── b2_cancel_large_file ──────────────────────────────────────────────────────

describe("b2_cancel_large_file", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "large-file-001",
      fileName: "large-video.mp4",
      accountId: "test-account-123",
      bucketId: "bucket-001",
    }),
  );

  it("returns cancelled file info", async () => {
    const result = parseResult(
      await callTool(server, "b2_cancel_large_file", { fileId: "large-file-001" }),
    );
    expect(result.fileId).toBe("large-file-001");
  });
});

// ── b2_list_unfinished_large_files ────────────────────────────────────────────

describe("b2_list_unfinished_large_files", () => {
  beforeEach(() =>
    setupMocks({
      files: [{ fileId: "large-001", fileName: "video.mp4", contentType: "video/mp4" }],
      nextFileId: null,
    }),
  );

  it("returns list of unfinished uploads", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_unfinished_large_files", { bucketId: "bucket-001" }),
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0].fileName).toBe("video.mp4");
  });
});

// ── b2_delete_key ─────────────────────────────────────────────────────────────

describe("b2_delete_key", () => {
  beforeEach(() => setupMocks({ applicationKeyId: "key-ro", keyName: "readonly" }));

  it("returns deleted key info", async () => {
    const result = parseResult(
      await callTool(server, "b2_delete_key", { applicationKeyId: "key-ro" }),
    );
    expect(result.applicationKeyId).toBe("key-ro");
  });
});

// ── b2_delete_file_version ────────────────────────────────────────────────────

describe("b2_delete_file_version", () => {
  beforeEach(() => setupMocks({ fileId: "file-001", fileName: "photo.jpg" }));

  it("returns deleted file info", async () => {
    const result = parseResult(
      await callTool(server, "b2_delete_file_version", {
        fileId: "file-001",
        fileName: "photo.jpg",
      }),
    );
    expect(result.fileId).toBe("file-001");
  });
});

// ── b2_get_download_url_for_file ──────────────────────────────────────────────

describe("b2_get_download_url_for_file", () => {
  it("returns a download URL string", async () => {
    // This tool builds the URL from auth data — no extra API call needed
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    const result = parseResult(
      await callTool(server, "b2_get_download_url_for_file", {
        bucketName: "my-bucket",
        fileName: "photo.jpg",
      }),
    );
    const url = typeof result === "string" ? result : (result?.url ?? result?.downloadUrl);
    expect(url).toContain("photo.jpg");
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

  it("b2_get_file_info returns isError for bad_request", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue({
      response: {
        status: 400,
        data: { status: 400, code: "bad_request", message: "Bad file ID." },
      },
    } as any);
    const result = await callTool(server, "b2_get_file_info", { fileId: "bad" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("400");
  });

  it("b2_list_file_names returns isError on network error", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue(new Error("Network timeout") as any);
    const result = await callTool(server, "b2_list_file_names", { bucketId: "bucket-001" });
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

// ── b2_upload_file ────────────────────────────────────────────────────────────

describe("b2_upload_file", () => {
  const uploadUrlResponse = {
    uploadUrl: "https://pod-001.backblaze.com/b2api/v2/b2_upload_file/bucket-001/upload",
    authorizationToken: "upload-token-abc",
    bucketId: "bucket-001",
  };
  const uploadedFileInfo = {
    fileId: "file-uploaded-001",
    fileName: "hello.txt",
    contentLength: 11,
    contentType: "text/plain",
    uploadTimestamp: Date.now(),
  };

  beforeEach(() => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    // First axios(config) call → get_upload_url; second POST call → file info
    mockedAxios.mockResolvedValueOnce({ data: uploadUrlResponse } as any);
    (mockedAxios as any).post = jest.fn().mockResolvedValue({ data: uploadedFileInfo });
  });

  it("uploads base64 content and returns file info", async () => {
    const content = Buffer.from("hello world").toString("base64");
    const result = parseResult(
      await callTool(server, "b2_upload_file", {
        bucketId: "bucket-001",
        fileName: "hello.txt",
        content,
      }),
    );
    expect(result.fileId).toBe("file-uploaded-001");
    expect(result.fileName).toBe("hello.txt");
  });

  it("returns isError when neither filePath nor content is provided", async () => {
    const result = await callTool(server, "b2_upload_file", {
      bucketId: "bucket-001",
      fileName: "hello.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("filePath or content");
  });
});

// ── b2_download_file_by_id ────────────────────────────────────────────────────

describe("b2_download_file_by_id", () => {
  const fileContent = Buffer.from("file content here");

  beforeEach(() => {
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: mockAuthData }) // auth call
      .mockResolvedValueOnce({
        // download call
        data: fileContent,
        headers: { "content-type": "text/plain", "content-length": String(fileContent.length) },
      });
  });

  it("returns base64-encoded content with metadata", async () => {
    const result = parseResult(
      await callTool(server, "b2_download_file_by_id", { fileId: "file-001" }),
    );
    expect(result.fileId).toBe("file-001");
    expect(result.encoding).toBe("base64");
    expect(result.contentType).toBe("text/plain");
    const decoded = Buffer.from(result.content, "base64").toString();
    expect(decoded).toBe("file content here");
  });
});

// ── b2_download_file_by_name ──────────────────────────────────────────────────

describe("b2_download_file_by_name", () => {
  const fileContent = Buffer.from("named file content");

  beforeEach(() => {
    mockedAxios.get = jest
      .fn()
      .mockResolvedValueOnce({ data: mockAuthData })
      .mockResolvedValueOnce({
        data: fileContent,
        headers: { "content-type": "image/jpeg", "content-length": String(fileContent.length) },
      });
  });

  it("returns base64-encoded content with the file name", async () => {
    const result = parseResult(
      await callTool(server, "b2_download_file_by_name", {
        bucketName: "my-bucket",
        fileName: "photo.jpg",
      }),
    );
    expect(result.fileName).toBe("photo.jpg");
    expect(result.encoding).toBe("base64");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("builds the correct download URL from auth data", async () => {
    await callTool(server, "b2_download_file_by_name", {
      bucketName: "my-bucket",
      fileName: "docs/report.pdf",
    });
    const downloadCallUrl = (mockedAxios.get as jest.Mock).mock.calls[1][0];
    expect(downloadCallUrl).toContain("f005.backblazeb2.com");
    expect(downloadCallUrl).toContain("my-bucket");
    expect(downloadCallUrl).toContain("docs");
  });
});

// ── b2_get_upload_url ─────────────────────────────────────────────────────────

describe("b2_get_upload_url", () => {
  beforeEach(() =>
    setupMocks({
      uploadUrl: "https://pod-001.backblaze.com/b2api/v2/b2_upload_file/bucket-001/upload",
      authorizationToken: "upload-token-abc",
      bucketId: "bucket-001",
    }),
  );

  it("returns uploadUrl, authorizationToken, and bucketId", async () => {
    const result = parseResult(
      await callTool(server, "b2_get_upload_url", { bucketId: "bucket-001" }),
    );
    expect(result.uploadUrl).toContain("backblaze.com");
    expect(result.authorizationToken).toBe("upload-token-abc");
    expect(result.bucketId).toBe("bucket-001");
  });
});

// ── b2_get_upload_part_url ────────────────────────────────────────────────────

describe("b2_get_upload_part_url", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "large-file-001",
      uploadUrl: "https://pod-001.backblaze.com/b2api/v2/b2_upload_part",
      authorizationToken: "part-upload-token-xyz",
    }),
  );

  it("returns uploadUrl and token for the given fileId", async () => {
    const result = parseResult(
      await callTool(server, "b2_get_upload_part_url", {
        fileId: "large-file-001",
      }),
    );
    expect(result.fileId).toBe("large-file-001");
    expect(result.authorizationToken).toBe("part-upload-token-xyz");
    expect(result.uploadUrl).toBeDefined();
  });
});

// ── b2_upload_part ────────────────────────────────────────────────────────────

describe("b2_upload_part", () => {
  const partInfo = {
    fileId: "large-file-001",
    partNumber: 1,
    contentLength: 5242880,
    contentSha1: "abc123",
  };

  beforeEach(() => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    (mockedAxios as any).post = jest.fn().mockResolvedValue({ data: partInfo });
  });

  it("returns part info after uploading", async () => {
    const content = Buffer.alloc(16).toString("base64"); // small content for test
    const result = parseResult(
      await callTool(server, "b2_upload_part", {
        uploadUrl: "https://pod-001.backblaze.com/b2api/v2/b2_upload_part",
        uploadAuthToken: "part-token",
        partNumber: 1,
        content,
      }),
    );
    expect(result.partNumber).toBe(1);
  });

  it("sends the part number and SHA1 header", async () => {
    const content = Buffer.alloc(16).toString("base64");
    await callTool(server, "b2_upload_part", {
      uploadUrl: "https://pod-001.backblaze.com/upload",
      uploadAuthToken: "part-token",
      partNumber: 2,
      content,
    });
    const postCall = (mockedAxios as any).post.mock.calls[0];
    expect(postCall[2].headers["X-Bz-Part-Number"]).toBe("2");
    expect(postCall[2].headers["X-Bz-Content-Sha1"]).toMatch(/^[a-f0-9]{40}$/);
  });
});

// ── b2_copy_part ──────────────────────────────────────────────────────────────

describe("b2_copy_part", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "large-file-001",
      partNumber: 1,
      contentLength: 5242880,
      contentSha1: "def456",
    }),
  );

  it("returns copied part info", async () => {
    const result = parseResult(
      await callTool(server, "b2_copy_part", {
        sourceFileId: "file-001",
        largeFileId: "large-file-001",
        partNumber: 1,
      }),
    );
    expect(result.partNumber).toBe(1);
    expect(result.fileId).toBe("large-file-001");
  });

  it("passes sourceFileId and partNumber to the API", async () => {
    await callTool(server, "b2_copy_part", {
      sourceFileId: "file-src",
      largeFileId: "large-001",
      partNumber: 3,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceFileId: "file-src", partNumber: 3 }),
      }),
    );
  });
});

// ── b2_finish_large_file ──────────────────────────────────────────────────────

describe("b2_finish_large_file", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "large-file-001",
      fileName: "big-backup.tar.gz",
      contentLength: 15728640,
      contentType: "application/gzip",
      contentSha1: "none",
    }),
  );

  it("returns the completed file info", async () => {
    const result = parseResult(
      await callTool(server, "b2_finish_large_file", {
        fileId: "large-file-001",
        partSha1Array: ["sha1-part1", "sha1-part2", "sha1-part3"],
      }),
    );
    expect(result.fileId).toBe("large-file-001");
    expect(result.fileName).toBe("big-backup.tar.gz");
  });

  it("passes partSha1Array to the API", async () => {
    const sha1s = ["aaa", "bbb"];
    await callTool(server, "b2_finish_large_file", {
      fileId: "large-file-001",
      partSha1Array: sha1s,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ partSha1Array: sha1s }) }),
    );
  });
});

// ── b2_list_parts ─────────────────────────────────────────────────────────────

describe("b2_list_parts", () => {
  beforeEach(() =>
    setupMocks({
      parts: [
        { partNumber: 1, contentLength: 10485760, contentSha1: "sha1a" },
        { partNumber: 2, contentLength: 5242880, contentSha1: "sha1b" },
      ],
      nextPartNumber: null,
    }),
  );

  it("returns uploaded parts for a large file", async () => {
    const result = parseResult(
      await callTool(server, "b2_list_parts", { fileId: "large-file-001" }),
    );
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].partNumber).toBe(1);
    expect(result.parts[1].contentSha1).toBe("sha1b");
  });
});

// ── b2_get_download_url_for_file_id ───────────────────────────────────────────

describe("b2_get_download_url_for_file_id", () => {
  it("returns a download URL containing the fileId", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    const result = parseResult(
      await callTool(server, "b2_get_download_url_for_file_id", {
        fileId: "file-abc-123",
      }),
    );
    const url = typeof result === "string" ? result : (result?.url ?? result?.downloadUrl);
    expect(url).toContain("file-abc-123");
  });

  it("appends authorization token when provided", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    const result = parseResult(
      await callTool(server, "b2_get_download_url_for_file_id", {
        fileId: "file-abc-123",
        authorizationToken: "dl-token-xyz",
      }),
    );
    const url = typeof result === "string" ? result : (result?.url ?? result?.downloadUrl);
    expect(url).toContain("dl-token-xyz");
  });
});

// ── b2_update_file_legal_hold ─────────────────────────────────────────────────

describe("b2_update_file_legal_hold", () => {
  beforeEach(() =>
    setupMocks({
      fileId: "file-001",
      fileName: "doc.pdf",
      legalHold: { isClientAuthorizedToRead: true, value: "on" },
    }),
  );

  it("returns updated legal hold status", async () => {
    const result = parseResult(
      await callTool(server, "b2_update_file_legal_hold", {
        fileId: "file-001",
        fileName: "doc.pdf",
        legalHold: { isClientAuthorizedToRead: true, value: "on" },
      }),
    );
    expect(result.legalHold.value).toBe("on");
  });

  it("passes legalHold payload to the API", async () => {
    await callTool(server, "b2_update_file_legal_hold", {
      fileId: "file-001",
      fileName: "doc.pdf",
      legalHold: { isClientAuthorizedToRead: true, value: "off" },
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          legalHold: expect.objectContaining({ value: "off" }),
        }),
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

describe("b2_create_group_member", () => {
  const mockMember = {
    applicationKeyId: "100530e11d8c",
    applicationKey: "K100wD6xncrk",
    groupMember: {
      accountId: "new-account-abc",
      email: "member@example.com",
      groupId: "254",
      groupName: "Partner Group 2",
      region: "us-west",
    },
  };

  beforeEach(() => setupMocks(mockMember));

  it("returns applicationKeyId and groupMember info", async () => {
    const result = parseResult(
      await callTool(server, "b2_create_group_member", {
        adminAccountId: "test-account-123",
        groupId: "254",
        memberEmail: "member@example.com",
      }),
    );
    expect(result.applicationKeyId).toBe("100530e11d8c");
    expect(result.groupMember.email).toBe("member@example.com");
  });

  it("uses b2api/v3 in the request URL", async () => {
    await callTool(server, "b2_create_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberEmail: "m@example.com",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("b2api/v3") }),
    );
  });

  it("sends region when provided", async () => {
    await callTool(server, "b2_create_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberEmail: "m@example.com",
      region: "eu-central",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ region: "eu-central" }) }),
    );
  });

  it("omits region when not provided", async () => {
    await callTool(server, "b2_create_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberEmail: "m@example.com",
    });
    const callArgs = (mockedAxios as any).mock.calls[0][0];
    expect(callArgs.data.region).toBeUndefined();
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

describe("b2_reserve_trial_create_account", () => {
  const mockTrial = {
    accountId: "trial-account-123",
    applicationKey: "K100trial",
    applicationKeyId: "key-trial-id",
    s3Endpoint: "s3.us-west-004.backblazeb2.com",
    startDate: "2026-05-16",
    endDate: "2026-05-30",
    email: "user@example.com",
    bucketName: "my-trial-bucket",
    bucketId: "bucket-trial-001",
  };

  beforeEach(() => setupMocks(mockTrial));

  it("returns trial account info with credentials and dates", async () => {
    const result = parseResult(
      await callTool(server, "b2_reserve_trial_create_account", {
        email: "user@example.com",
        term: 14,
        storage: 5,
      }),
    );
    expect(result.accountId).toBe("trial-account-123");
    expect(result.bucketName).toBe("my-trial-bucket");
    expect(result.startDate).toBe("2026-05-16");
    expect(result.endDate).toBe("2026-05-30");
  });

  it("uses b2api/v3 in the request URL", async () => {
    await callTool(server, "b2_reserve_trial_create_account", {
      email: "user@example.com",
      term: 7,
      storage: 1,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("b2api/v3") }),
    );
  });

  it("sends email, term, and storage in the POST body", async () => {
    await callTool(server, "b2_reserve_trial_create_account", {
      email: "trial@company.com",
      term: 30,
      storage: 10,
      region: "eu-central",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "trial@company.com",
          term: 30,
          storage: 10,
          region: "eu-central",
        }),
      }),
    );
  });
});

describe("bz_list_computers", () => {
  const mockComputers = {
    nextComputerId: null,
    computers: [
      {
        computerId: "aab0a1acc4e2",
        computerName: "johnsmith_2024_09_24",
        lastFileUploadedTimestamp: 1727276780000,
      },
      {
        computerId: "2ed0514c3452",
        computerName: "johnsmith_2024_09_25",
        lastFileUploadedTimestamp: 1727285088000,
      },
    ],
  };

  beforeEach(() => setupMocks(mockComputers));

  it("returns computers array", async () => {
    const result = parseResult(
      await callTool(server, "bz_list_computers", {
        accountId: "test-account-123",
      }),
    );
    expect(result.computers).toHaveLength(2);
    expect(result.computers[0].computerName).toBe("johnsmith_2024_09_24");
  });

  it("uses api/backup/v1 path (not b2api/v2)", async () => {
    await callTool(server, "bz_list_computers", { accountId: "test-account-123" });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("api/backup/v1") }),
    );
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.not.stringContaining("b2api/v2") }),
    );
  });

  it("sends accountId as a query param (GET request)", async () => {
    await callTool(server, "bz_list_computers", { accountId: "test-account-123" });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        params: expect.objectContaining({ accountId: "test-account-123" }),
      }),
    );
  });

  it("forwards startComputerId pagination cursor when provided", async () => {
    await callTool(server, "bz_list_computers", {
      accountId: "test-account-123",
      startComputerId: "aab0a1acc4e2",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ startComputerId: "aab0a1acc4e2" }),
      }),
    );
  });
});

describe("bz_delete_computer", () => {
  const mockDeleted = {
    computerId: "aab0a1acc4e2",
    computerName: "johnsmith_2024_09_24",
    lastFileUploadedTimestamp: 1727276780000,
  };

  beforeEach(() => setupMocks(mockDeleted));

  it("returns deleted computer info", async () => {
    const result = parseResult(
      await callTool(server, "bz_delete_computer", {
        accountId: "test-account-123",
        computerId: "aab0a1acc4e2",
      }),
    );
    expect(result.computerId).toBe("aab0a1acc4e2");
    expect(result.computerName).toBe("johnsmith_2024_09_24");
  });

  it("uses api/backup/v1 path in the request URL", async () => {
    await callTool(server, "bz_delete_computer", {
      accountId: "test-account-123",
      computerId: "aab0a1acc4e2",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("api/backup/v1") }),
    );
  });

  it("sends accountId and computerId in the POST body", async () => {
    await callTool(server, "bz_delete_computer", {
      accountId: "test-account-123",
      computerId: "aab0a1acc4e2",
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: "test-account-123",
          computerId: "aab0a1acc4e2",
        }),
      }),
    );
  });

  it("returns isError on structured API error", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
    mockedAxios.mockRejectedValue({
      response: {
        status: 400,
        data: { status: 400, code: "invalid_computer_id", message: "Computer not found." },
      },
    } as any);
    const result = await callTool(server, "bz_delete_computer", {
      accountId: "test-account-123",
      computerId: "bad-id",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_computer_id");
  });
});

// ── b2_update_file_retention ──────────────────────────────────────────────────

describe("b2_update_file_retention", () => {
  const retentionTimestamp = Date.now() + 365 * 24 * 60 * 60 * 1000;
  beforeEach(() =>
    setupMocks({
      fileId: "file-001",
      fileName: "audit.log",
      fileRetention: {
        isClientAuthorizedToRead: true,
        value: { mode: "compliance", retainUntilTimestamp: retentionTimestamp },
      },
    }),
  );

  it("returns the updated file retention info", async () => {
    const result = parseResult(
      await callTool(server, "b2_update_file_retention", {
        fileId: "file-001",
        fileName: "audit.log",
        fileRetention: {
          isClientAuthorizedToRead: true,
          value: { mode: "compliance", retainUntilTimestamp: retentionTimestamp },
        },
      }),
    );
    expect(result.fileRetention.value.mode).toBe("compliance");
  });

  it("passes bypassGovernance when set to true", async () => {
    await callTool(server, "b2_update_file_retention", {
      fileId: "file-001",
      fileName: "doc.pdf",
      fileRetention: {
        isClientAuthorizedToRead: true,
        value: { mode: "governance", retainUntilTimestamp: retentionTimestamp },
      },
      bypassGovernance: true,
    });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bypassGovernance: true }) }),
    );
  });
});
