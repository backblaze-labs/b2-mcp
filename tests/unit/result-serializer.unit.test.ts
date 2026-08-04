import {
  MAX_TOON_INPUT_JSON_CHARS,
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
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const CANARY = "B2_MCP_CANARY_SECRET_result_serializer";

async function decodeToon(text: string): Promise<JsonCompatible> {
  return decodeToonWithEnv(text, process.env);
}

function decodeToonWithEnv(text: string, env: NodeJS.ProcessEnv): JsonCompatible {
  const decoded = execFileSync(
    process.execPath,
    [
      "-e",
      [
        "const fs = require('fs');",
        "const canary = 'B2_MCP_CANARY';",
        "if (Object.values(process.env).some((value) => String(value).includes(canary))) {",
        "  throw new Error('B2 credential canary reached TOON oracle subprocess');",
        "}",
        "const { decode } = require('@toon-format/toon');",
        "process.stdout.write(JSON.stringify(decode(fs.readFileSync(0, 'utf8'))));",
      ].join("\n"),
    ],
    {
      cwd: join(__dirname, "../.."),
      encoding: "utf8",
      input: text,
      env: envWithoutB2Credentials(env),
    },
  );
  return JSON.parse(decoded) as JsonCompatible;
}

function envWithoutB2Credentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const policy = JSON.parse(
    readFileSync(join(__dirname, "../../scripts/b2-credential-env.json"), "utf8"),
  ) as {
    exact: string[];
    patterns: string[];
  };
  const exact = new Set(policy.exact);
  const patterns = policy.patterns.map((pattern) => new RegExp(pattern));
  const scrubbed = { ...env };
  for (const name of Object.keys(scrubbed)) {
    const upper = name.toUpperCase();
    if (exact.has(upper) || patterns.some((pattern) => pattern.test(upper))) {
      delete scrubbed[name];
    }
  }
  return scrubbed;
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

  it("falls back to compact JSON when TOON encoding fails", () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
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
    const result = runWithResultSerializationOptions({ outputFormat: "toon" }, () =>
      toolJson({ value: "x".repeat(MAX_TOON_INPUT_JSON_CHARS) }),
    );

    expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
  });

  it("preflights TOON mode with a smoke serialization", () => {
    expect(() => preflightMcpOutputFormat("json")).not.toThrow();
    expect(() => preflightMcpOutputFormat("toon")).not.toThrow();
  });

  it("does not load the npm TOON package when JSON mode serializes text", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@toon-format/toon", () => {
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
        jest.dontMock("@toon-format/toon");
      }
    });
  });

  it("does not execute the npm TOON package in TOON mode", async () => {
    const originalApplicationKey = process.env.B2_APPLICATION_KEY;
    const originalMasterKey = process.env.B2_MASTER_KEY;
    let mockObservedEnv: string | undefined;

    try {
      process.env.B2_APPLICATION_KEY = "B2_MCP_CANARY_APPLICATION_KEY";
      process.env.B2_MASTER_KEY = "B2_MCP_CANARY_MASTER_KEY";
      await jest.isolateModulesAsync(async () => {
        jest.doMock("@toon-format/toon", () => {
          mockObservedEnv = `${process.env.B2_APPLICATION_KEY}:${process.env.B2_MASTER_KEY}`;
          return {
            encode: () => mockObservedEnv,
            decode: () => ({}),
          };
        });
        try {
          const serializer = await import("../../src/utils/result-serializer");
          const result = serializer.runWithResultSerializationOptions(
            { outputFormat: "toon" },
            () => serializer.serializeStructuredToolResult({ ok: true }),
          );

          expect(result.content[0].text).toBe("ok: true");
          expect(JSON.stringify(result)).not.toContain("B2_MCP_CANARY_APPLICATION_KEY");
          expect(JSON.stringify(result)).not.toContain("B2_MCP_CANARY_MASTER_KEY");
          expect(mockObservedEnv).toBeUndefined();
        } finally {
          jest.dontMock("@toon-format/toon");
        }
      });
    } finally {
      if (originalApplicationKey === undefined) delete process.env.B2_APPLICATION_KEY;
      else process.env.B2_APPLICATION_KEY = originalApplicationKey;
      if (originalMasterKey === undefined) delete process.env.B2_MASTER_KEY;
      else process.env.B2_MASTER_KEY = originalMasterKey;
    }
  });

  it("scrubs B2 credential env before executing the TOON test oracle", () => {
    expect(
      decodeToonWithEnv("ok: true", {
        ...process.env,
        B2_APPLICATION_KEY: "B2_MCP_CANARY_APPLICATION_KEY",
        B2_MASTER_KEY: "B2_MCP_CANARY_MASTER_KEY",
      }),
    ).toEqual({ ok: true });
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
    expect(packageJson.devDependencies?.["@toon-format/toon"]).toBe("4.1.0");
  });
});
