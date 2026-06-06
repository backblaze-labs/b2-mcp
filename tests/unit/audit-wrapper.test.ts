/**
 * Tests for the audit-logging wrapper (wrapToolsWithAudit / getRegisteredTools),
 * including the degradation paths added for resilience: a missing SDK registry
 * and tools with no recognizable handler key both warn instead of failing
 * silently, and the wrapper reports how many tools it wrapped.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapToolsWithAudit, getRegisteredTools } from "../../src/server";
import { logger } from "../../src/utils/logger";
import { B2Config } from "../../src/utils/types";

const cfg = { applicationKeyId: "test-key-id-1234567890" } as B2Config;

let infoSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined as never);
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});

afterEach(() => jest.restoreAllMocks());

describe("getRegisteredTools", () => {
  it("returns null when the SDK registry is absent", () => {
    expect(getRegisteredTools({} as McpServer)).toBeNull();
  });

  it("returns the registry object when present", () => {
    const reg = { a: {} };
    expect(getRegisteredTools({ _registeredTools: reg } as unknown as McpServer)).toBe(reg);
  });
});

describe("wrapToolsWithAudit", () => {
  it("warns and returns 0 when the registry is missing", () => {
    const count = wrapToolsWithAudit({} as McpServer, cfg);
    expect(count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "registry-missing" }),
      expect.stringContaining("audit.wrap.skipped"),
    );
  });

  it("skips (with a warning) a tool that has no recognizable handler key", () => {
    const server = { _registeredTools: { broken: { notAHandler: 1 } } } as unknown as McpServer;
    const count = wrapToolsWithAudit(server, cfg);
    expect(count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "broken" }),
      expect.stringContaining("no recognizable handler key"),
    );
  });

  it("wraps a tool, logs tool.call on success, and preserves the result", async () => {
    const original = jest.fn().mockResolvedValue({ isError: false, ok: true });
    const tool: Record<string, unknown> = { callback: original };
    const server = { _registeredTools: { t: tool } } as unknown as McpServer;

    const count = wrapToolsWithAudit(server, cfg);
    expect(count).toBe(1);

    const result = await (tool.callback as (...a: unknown[]) => Promise<unknown>)(
      { bucketId: "b" },
      {},
    );
    expect(result).toEqual({ isError: false, ok: true });
    expect(original).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "t", argKeys: ["bucketId"], error: false }),
      "tool.call",
    );
  });

  it("logs tool.error and rethrows when the handler throws", async () => {
    const original = jest.fn().mockRejectedValue(new Error("boom"));
    const tool: Record<string, unknown> = { callback: original };
    const server = { _registeredTools: { t: tool } } as unknown as McpServer;
    wrapToolsWithAudit(server, cfg);

    await expect((tool.callback as (...a: unknown[]) => Promise<unknown>)({}, {})).rejects.toThrow(
      "boom",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "t", err: "boom" }),
      "tool.error",
    );
  });
});
