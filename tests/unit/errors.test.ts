import {
  parseB2Error,
  formatB2Error,
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
