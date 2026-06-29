import {
  parseB2Error,
  formatB2Error,
  parseErrorText,
  toolError,
  toolSuccess,
  toolJson,
} from "../../src/utils/errors";

describe("parseB2Error", () => {
  it("should parse axios-style error with response body", () => {
    const err = {
      response: {
        status: 400,
        data: { status: 400, code: "bad_bucket_id", message: "The bucket ID is not valid." },
      },
    };
    const parsed = parseB2Error(err);
    expect(parsed.status).toBe(400);
    expect(parsed.code).toBe("bad_bucket_id");
    expect(parsed.message).toBe("The bucket ID is not valid.");
  });

  it("should handle plain Error objects", () => {
    const err = new Error("Network error");
    const parsed = parseB2Error(err);
    expect(parsed.code).toBe("internal_error");
    expect(parsed.message).toBe("Network error");
  });

  it("should handle unknown error types", () => {
    const parsed = parseB2Error("something went wrong");
    expect(parsed.code).toBe("internal_error");
    expect(parsed.message).toBe("something went wrong");
  });

  // AWS SDK v3 (S3) errors carry status in $metadata, not response.status —
  // these must classify by their true code, not collapse to 500/internal_error.
  it("classifies an AWS SDK 404 (NoSuchKey) as 404 with its real code + requestId", () => {
    const err = {
      name: "NoSuchKey",
      message: "The specified key does not exist.",
      $metadata: { httpStatusCode: 404, requestId: "req-abc-123", extendedRequestId: "ext-xyz" },
    };
    const parsed = parseB2Error(err);
    expect(parsed.status).toBe(404);
    expect(parsed.code).toBe("NoSuchKey");
    expect(parsed.requestId).toBe("req-abc-123");
    expect(parsed.extendedRequestId).toBe("ext-xyz");
  });

  it("classifies an AWS SDK 403 (Forbidden) as 403", () => {
    const err = { name: "Forbidden", message: "Forbidden", $metadata: { httpStatusCode: 403 } };
    expect(parseB2Error(err).status).toBe(403);
    expect(parseB2Error(err).code).toBe("Forbidden");
  });

  it("classifies a genuine AWS SDK 500 (UnknownError) as 500 — the ticket case", () => {
    const err = {
      name: "UnknownError",
      message: "UnknownError",
      $metadata: { httpStatusCode: 500, requestId: "req-500-1" },
    };
    const parsed = parseB2Error(err);
    expect(parsed.status).toBe(500);
    expect(parsed.code).toBe("UnknownError");
    expect(parsed.requestId).toBe("req-500-1");
  });

  it("prefers err.Code over err.name when both are present", () => {
    const err = {
      Code: "NoSuchBucket",
      name: "NoSuchBucketException",
      message: "no bucket",
      $metadata: { httpStatusCode: 404 },
    };
    expect(parseB2Error(err).code).toBe("NoSuchBucket");
  });

  it("captures a requestId from axios response headers (B2 native)", () => {
    const err = {
      response: {
        status: 500,
        data: { code: "internal_error", message: "boom" },
        headers: { "x-bz-request-id": "bz-req-9" },
      },
    };
    expect(parseB2Error(err).requestId).toBe("bz-req-9");
  });
});

describe("formatB2Error", () => {
  it("should format error as human-readable string", () => {
    const err = {
      response: {
        status: 404,
        data: { code: "file_not_present", message: "No file with the given name." },
      },
    };
    const formatted = formatB2Error(err);
    expect(formatted).toContain("file_not_present");
    expect(formatted).toContain("404");
    expect(formatted).toContain("No file with the given name.");
  });

  it("appends the requestId when present (for support tickets)", () => {
    const err = {
      name: "UnknownError",
      message: "UnknownError",
      $metadata: { httpStatusCode: 500, requestId: "req-500-1" },
    };
    expect(formatB2Error(err)).toContain("requestId: req-500-1");
  });

  it("appends master-key guidance on an S3 InvalidAccessKeyId / Malformed Access Key Id", () => {
    const err = {
      name: "InvalidAccessKeyId",
      message: "Malformed Access Key Id",
      $metadata: { httpStatusCode: 403, requestId: "req-403" },
    };
    const formatted = formatB2Error(err);
    expect(formatted).toContain("InvalidAccessKeyId");
    expect(formatted).toContain("only accepts a regular");
    expect(formatted).toContain("master key");
    expect(formatted).toContain("requestId: req-403"); // hint sits before the requestId
  });

  it("does not append the hint to unrelated errors", () => {
    const err = { response: { status: 404, data: { code: "file_not_present", message: "gone" } } };
    expect(formatB2Error(err)).not.toContain("application key");
  });
});

describe("parseErrorText (round-trips formatB2Error for the audit layer)", () => {
  it("extracts code, status, and requestId", () => {
    const text = formatB2Error({
      name: "NoSuchKey",
      message: "missing",
      $metadata: { httpStatusCode: 404, requestId: "req-9" },
    });
    expect(parseErrorText(text)).toEqual({ code: "NoSuchKey", status: 404, requestId: "req-9" });
  });

  it("works without a requestId", () => {
    const text = "B2 Error [bad_request] (HTTP 400): nope";
    expect(parseErrorText(text)).toEqual({
      code: "bad_request",
      status: 400,
      requestId: undefined,
    });
  });

  it("returns null for non-error / undefined text", () => {
    expect(parseErrorText(undefined)).toBeNull();
    expect(parseErrorText("some success text")).toBeNull();
  });
});

describe("toolError", () => {
  it("should return an isError response with text content", () => {
    const result = toolError(new Error("test error"));
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("test error");
  });
});

describe("toolSuccess", () => {
  it("should return text content", () => {
    const result = toolSuccess("Operation completed.");
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Operation completed.");
  });
});

describe("toolJson", () => {
  it("should serialize data as pretty JSON", () => {
    const data = { bucketId: "abc123", bucketName: "my-bucket" };
    const result = toolJson(data);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.bucketId).toBe("abc123");
    expect(parsed.bucketName).toBe("my-bucket");
  });
});
