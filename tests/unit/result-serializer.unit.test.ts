import {
  MAX_TOON_INPUT_DEPTH,
  MAX_TOON_INPUT_JSON_CHARS,
  MAX_TOON_INPUT_NODES,
  parseMcpOutputFormat,
  preflightMcpOutputFormat,
  runWithResultSerializationOptions,
  serializeStructuredToolResult,
  TOON_IMPLEMENTATION,
  TOON_SPEC_VERSION,
} from "../../src/utils/result-serializer";
import type { JsonCompatible } from "../../src/utils/result-serializer";
import {
  runWithSanitizerOptions,
  SECRET_SANITIZER_REDACTION,
} from "../../src/utils/secret-sanitizer";
import { toolJson } from "../../src/utils/errors";
import { logger } from "../../src/utils/logger";
import { decodeToon, TOON_DECODER_BLOCKED_ENV } from "./toon-decoder-helper";
import { readFileSync } from "fs";
import { join } from "path";

const CANARY = "B2_MCP_CANARY_SECRET_result_serializer";

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

  it("keeps canonical structured content while only changing text rendering", async () => {
    const data = {
      buckets: [
        { bucketName: "alpha", bucketType: "allPrivate" },
        { bucketName: "beta", bucketType: "allPublic" },
      ],
      nextContinuationToken: "cursor==",
    };

    const jsonResult = serializeStructuredToolResult(data, {}, "json");
    const toonResult = serializeStructuredToolResult(data, {}, "toon");

    expect(jsonResult.structuredContent).toEqual(data);
    expect(toonResult.structuredContent).toEqual(data);
    expect(jsonResult.content[0].text).toBe(JSON.stringify(data));
    expect(toonResult.content[0].text).toBe(
      [
        "buckets[2]{bucketName,bucketType}:",
        "  alpha,allPrivate",
        "  beta,allPublic",
        "nextContinuationToken: cursor==",
      ].join("\n"),
    );
    expect(toonResult.content[0].text).not.toBe(jsonResult.content[0].text);
    await expect(decodeToon(toonResult.content[0].text)).resolves.toEqual(
      toonResult.structuredContent,
    );
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

  it("falls back to compact JSON when TOON encoding fails", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const result = runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({ bad: "\uD800" }),
    );

    expect(result.content[0].text).toBe('{"bad":"\\ud800"}');
    expect(result.structuredContent).toEqual({ bad: "\uD800" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFormat: "toon",
        fallbackOutputFormat: "json",
        reason: "encode_error",
      }),
      "tool.output_format.toon_fallback",
    );
  });

  it("falls back to compact JSON when TOON input bounds are exceeded", () => {
    const value = { value: "x".repeat(MAX_TOON_INPUT_JSON_CHARS) };
    const result = runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson(value),
    );

    expect(result.structuredContent).toEqual(value);
    expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
  });

  it("falls back to JSON text without changing structured content at depth and node bounds", () => {
    const deepValue = nestedValue(MAX_TOON_INPUT_DEPTH + 1);
    const deepValueResult = serializeStructuredToolResult(deepValue, {}, "toon");
    expect(deepValueResult.structuredContent).toEqual(deepValue);
    expect(deepValueResult.content[0].text).toBe(JSON.stringify(deepValue));

    const manyNodes = Array.from({ length: MAX_TOON_INPUT_NODES + 1 }, () => "");
    const manyNodesResult = serializeStructuredToolResult(manyNodes, {}, "toon");
    expect(manyNodesResult.structuredContent).toEqual(manyNodes);
    expect(manyNodesResult.content[0].text).toBe(JSON.stringify(manyNodes));
  });

  it("preflights TOON mode with a smoke serialization", () => {
    expect(() => preflightMcpOutputFormat("json")).not.toThrow();
    expect(() => preflightMcpOutputFormat("toon")).not.toThrow();
  });

  it("does not load the npm TOON package when JSON mode serializes text", async () => {
    vi.resetModules();
    vi.doMock("@toon-format/toon", () => {
      throw new Error("TOON package loaded");
    });
    try {
      const serializer = await import("../../src/utils/result-serializer");
      expect(serializer.serializeStructuredToolResult({ ok: true })).toEqual({
        content: [{ type: "text", text: '{"ok":true}' }],
        structuredContent: { ok: true },
      });
      expect(
        serializer.runWithResultSerializationOptions({ outputFormat: "json" }, () =>
          serializer.serializeStructuredToolResult({ ok: true }),
        ),
      ).toEqual({
        content: [{ type: "text", text: '{"ok":true}' }],
        structuredContent: { ok: true },
      });
    } finally {
      vi.doUnmock("@toon-format/toon");
      vi.resetModules();
    }
  });

  it("does not execute the npm TOON package in TOON mode", async () => {
    const originalApplicationKey = process.env.B2_APPLICATION_KEY;
    const originalMasterKey = process.env.B2_MASTER_KEY;
    let mockObservedEnv: string | undefined;

    try {
      process.env.B2_APPLICATION_KEY = "B2_MCP_CANARY_APPLICATION_KEY";
      process.env.B2_MASTER_KEY = "B2_MCP_CANARY_MASTER_KEY";
      vi.resetModules();
      vi.doMock("@toon-format/toon", () => {
        mockObservedEnv = `${process.env.B2_APPLICATION_KEY}:${process.env.B2_MASTER_KEY}`;
        return {
          encode: () => mockObservedEnv,
          decode: () => ({}),
        };
      });
      try {
        const serializer = await import("../../src/utils/result-serializer");
        const result = serializer.runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
          serializer.serializeStructuredToolResult({ ok: true }),
        );

        expect(result.content[0].text).toBe("ok: true");
        expect(JSON.stringify(result)).not.toContain("B2_MCP_CANARY_APPLICATION_KEY");
        expect(JSON.stringify(result)).not.toContain("B2_MCP_CANARY_MASTER_KEY");
        expect(mockObservedEnv).toBeUndefined();
      } finally {
        vi.doUnmock("@toon-format/toon");
        vi.resetModules();
      }
    } finally {
      if (originalApplicationKey === undefined) delete process.env.B2_APPLICATION_KEY;
      else process.env.B2_APPLICATION_KEY = originalApplicationKey;
      if (originalMasterKey === undefined) delete process.env.B2_MASTER_KEY;
      else process.env.B2_MASTER_KEY = originalMasterKey;
    }
  });

  it("validates output format values", () => {
    expect(parseMcpOutputFormat(undefined)).toBe("json");
    expect(parseMcpOutputFormat("")).toBe("json");
    expect(parseMcpOutputFormat(" TOON ")).toBe("toon");
    expect(parseMcpOutputFormat(" JSON ")).toBe("json");
    expect(() => parseMcpOutputFormat("yaml")).toThrow(/B2_MCP_OUTPUT_FORMAT/);
  });

  it("records the repo-owned TOON encoder contract without drifting", () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(TOON_IMPLEMENTATION).toBe("repo-owned");
    expect(TOON_SPEC_VERSION).toBe("4.1");
    expect(packageJson.dependencies?.["@toon-format/toon"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@toon-format/toon"]).toBe("4.1.1");
  });

  it("imports the third-party TOON test decoder only in a sanitized child process", async () => {
    const saved = new Map<string, string | undefined>();
    for (const name of TOON_DECODER_BLOCKED_ENV) {
      saved.set(name, process.env[name]);
      process.env[name] = `canary-${name}`;
    }

    try {
      await expect(decodeToon("ok: true")).resolves.toEqual({ ok: true });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

function nestedValue(depth: number): JsonCompatible {
  let value: JsonCompatible = "leaf";
  for (let index = 0; index < depth; index++) {
    value = { child: value };
  }
  return value;
}
