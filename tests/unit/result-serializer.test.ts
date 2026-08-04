import {
  parseMcpOutputFormat,
  runWithResultSerializationOptions,
  serializeStructuredToolResult,
  TOON_PACKAGE_VERSION,
  TOON_SPEC_VERSION,
} from "../../src/utils/result-serializer";
import type { JsonCompatible } from "../../src/utils/result-serializer";
import {
  runWithSanitizerOptions,
  SECRET_SANITIZER_REDACTION,
} from "../../src/utils/secret-sanitizer";
import { toolJson } from "../../src/utils/errors";
import { readFileSync } from "fs";
import { join } from "path";

const CANARY = "B2_MCP_CANARY_SECRET_result_serializer";

async function decodeToon(text: string): Promise<JsonCompatible> {
  const { decode } = await import("@toon-format/toon");
  return decode(text) as JsonCompatible;
}

describe("result serializer", () => {
  it("defaults structured tool-result text to compact JSON and keeps structuredContent", async () => {
    const result = await serializeStructuredToolResult({
      buckets: [
        { bucketName: "alpha", bucketType: "allPrivate" },
        { bucketName: "beta", bucketType: "allPublic" },
      ],
      nextContinuationToken: "cursor==",
    });

    const expected = {
      buckets: [
        { bucketName: "alpha", bucketType: "allPrivate" },
        { bucketName: "beta", bucketType: "allPublic" },
      ],
      nextContinuationToken: "cursor==",
    };
    expect(result.structuredContent).toEqual(expected);
    expect(result.content[0].text).toBe(JSON.stringify(expected));
  });

  it("serializes TOON when opt-in mode is selected", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({
        buckets: [
          { bucketName: "alpha", bucketType: "allPrivate" },
          { bucketName: "beta", bucketType: "allPublic" },
        ],
        nextContinuationToken: "cursor==",
      }),
    );

    expect(result.content[0].text).toContain("buckets[2]{bucketName,bucketType}:");
    await expect(decodeToon(result.content[0].text)).resolves.toEqual(result.structuredContent);
  });

  it("serializes compact JSON when compatibility mode is selected", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "json" }, () =>
      toolJson({ bucketId: "b2", fileCount: 2 }),
    );

    expect(result.content[0].text).toBe('{"bucketId":"b2","fileCount":2}');
    expect(result.structuredContent).toEqual({ bucketId: "b2", fileCount: 2 });
  });

  it("sanitizes structuredContent before TOON encoding", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      runWithSanitizerOptions({ secrets: [CANARY] }, () =>
        toolJson({
          applicationKey: CANARY,
          metadata: `token=${CANARY}`,
        }),
      ),
    );

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.structuredContent).toEqual({
      applicationKey: SECRET_SANITIZER_REDACTION,
      metadata: `token=${SECRET_SANITIZER_REDACTION}`,
    });
    await expect(decodeToon(result.content[0].text)).resolves.toEqual(result.structuredContent);
  });

  it("round-trips hostile B2-controlled strings without treating them as syntax", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({
        objects: [
          {
            fileName: "comma,value: # comment",
            note: 'quote " slash \\ tab\t cr\r newline\nunicode ☃',
            formula: "=SUM(A1:A2)",
            fakeHeader: "items[2]{x}:\n  1",
          },
        ],
      }),
    );

    await expect(decodeToon(result.content[0].text)).resolves.toEqual(result.structuredContent);
  });

  it("round-trips hostile B2-controlled keys without treating them as syntax", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({
        meta: {
          "evil,key\n  injected: 1": "v",
          "a{b}c": "w",
          'quote"colon:key': "x",
        },
      }),
    );

    await expect(decodeToon(result.content[0].text)).resolves.toEqual(result.structuredContent);
  });

  it("normalizes successful structured output through JSON compatibility", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({
        createdAt: new Date("2026-08-04T00:00:00.000Z"),
        omitted: undefined,
        nonFinite: Number.POSITIVE_INFINITY,
      }),
    );

    expect(result.structuredContent).toEqual({
      createdAt: "2026-08-04T00:00:00.000Z",
      nonFinite: null,
    });
    await expect(decodeToon(result.content[0].text)).resolves.toEqual(result.structuredContent);
  });

  it("emits visible text for an empty object in TOON mode", async () => {
    const result = await runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({ omitted: undefined }),
    );

    expect(result.structuredContent).toEqual({});
    expect(result.content[0].text).toBe("{}");
  });

  it("does not load TOON code when JSON mode serializes text", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@toon-format/toon", () => {
        throw new Error("TOON package loaded");
      });
      try {
        const serializer = await import("../../src/utils/result-serializer");
        await expect(serializer.serializeStructuredToolResult({ ok: true })).resolves.toEqual({
          content: [{ type: "text", text: '{"ok":true}' }],
          structuredContent: { ok: true },
        });
        await expect(
          serializer.runWithResultSerializationOptions({ outputFormat: "json" }, () =>
            serializer.serializeStructuredToolResult({ ok: true }),
          ),
        ).resolves.toEqual({
          content: [{ type: "text", text: '{"ok":true}' }],
          structuredContent: { ok: true },
        });
      } finally {
        jest.dontMock("@toon-format/toon");
      }
    });
  });

  it("validates output format values", () => {
    expect(parseMcpOutputFormat(undefined)).toBe("json");
    expect(parseMcpOutputFormat("")).toBe("json");
    expect(parseMcpOutputFormat(" TOON ")).toBe("toon");
    expect(parseMcpOutputFormat(" JSON ")).toBe("json");
    expect(() => parseMcpOutputFormat("yaml")).toThrow(/B2_MCP_OUTPUT_FORMAT/);
  });

  it("records the reviewed TOON package and spec versions without drifting", () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(TOON_PACKAGE_VERSION).toBe(packageJson.dependencies?.["@toon-format/toon"]);
    expect(TOON_SPEC_VERSION).toBe("4.1");
  });
});
