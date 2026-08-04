import {
  decodeToonForTests,
  parseMcpOutputFormat,
  runWithResultSerializationOptions,
  serializeStructuredToolResult,
  TOON_PACKAGE_VERSION,
  TOON_SPEC_VERSION,
} from "../../src/utils/result-serializer";
import {
  runWithSanitizerOptions,
  SECRET_SANITIZER_REDACTION,
} from "../../src/utils/secret-sanitizer";
import { toolJson } from "../../src/utils/errors";

const CANARY = "B2_MCP_CANARY_SECRET_result_serializer";

describe("result serializer", () => {
  it("defaults structured tool-result text to TOON and keeps canonical structuredContent", () => {
    const result = serializeStructuredToolResult({
      buckets: [
        { bucketName: "alpha", bucketType: "allPrivate" },
        { bucketName: "beta", bucketType: "allPublic" },
      ],
      nextContinuationToken: "cursor==",
    });

    expect(result.structuredContent).toEqual({
      buckets: [
        { bucketName: "alpha", bucketType: "allPrivate" },
        { bucketName: "beta", bucketType: "allPublic" },
      ],
      nextContinuationToken: "cursor==",
    });
    expect(result.content[0].text).toContain("buckets[2]{bucketName,bucketType}:");
    expect(decodeToonForTests(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("serializes compact JSON when compatibility mode is selected", () => {
    const result = runWithResultSerializationOptions({ outputFormat: "json" }, () =>
      toolJson({ bucketId: "b2", fileCount: 2 }),
    );

    expect(result.content[0].text).toBe('{"bucketId":"b2","fileCount":2}');
    expect(result.structuredContent).toEqual({ bucketId: "b2", fileCount: 2 });
  });

  it("sanitizes structuredContent before TOON encoding", () => {
    const result = runWithSanitizerOptions({ secrets: [CANARY] }, () =>
      toolJson({
        applicationKey: CANARY,
        metadata: `token=${CANARY}`,
      }),
    );

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.structuredContent).toEqual({
      applicationKey: SECRET_SANITIZER_REDACTION,
      metadata: `token=${SECRET_SANITIZER_REDACTION}`,
    });
    expect(decodeToonForTests(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("round-trips hostile B2-controlled strings without treating them as syntax", () => {
    const result = toolJson({
      objects: [
        {
          fileName: "comma,value: # comment",
          note: 'quote " slash \\ tab\t cr\r newline\nunicode ☃',
          formula: "=SUM(A1:A2)",
          fakeHeader: "items[2]{x}:\n  1",
        },
      ],
    });

    expect(decodeToonForTests(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("normalizes successful structured output through JSON compatibility", () => {
    const result = toolJson({
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      omitted: undefined,
      nonFinite: Number.POSITIVE_INFINITY,
    });

    expect(result.structuredContent).toEqual({
      createdAt: "2026-08-04T00:00:00.000Z",
      nonFinite: null,
    });
    expect(decodeToonForTests(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("validates output format values", () => {
    expect(parseMcpOutputFormat(undefined)).toBe("toon");
    expect(parseMcpOutputFormat("")).toBe("toon");
    expect(parseMcpOutputFormat(" JSON ")).toBe("json");
    expect(() => parseMcpOutputFormat("yaml")).toThrow(/B2_MCP_OUTPUT_FORMAT/);
  });

  it("records the reviewed TOON package and spec versions", () => {
    expect(TOON_PACKAGE_VERSION).toBe("4.1.0");
    expect(TOON_SPEC_VERSION).toBe("4.1");
  });
});
