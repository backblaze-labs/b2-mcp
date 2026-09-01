import { CliUsageError, helpText, parseCliArgs } from "../../src/cli";
import { PortUsageError } from "../../src/utils/config";

describe("CLI argument parsing", () => {
  it("defaults to stdio transport", () => {
    expect(parseCliArgs([], {})).toEqual({ action: "run", transport: "stdio" });
  });

  it("accepts HTTP transport, port, and host flags", () => {
    expect(parseCliArgs(["--transport", "http", "--host", "127.0.0.1", "--port", "3001"])).toEqual({
      action: "run",
      transport: "http",
      host: "127.0.0.1",
      port: 3001,
    });
    expect(parseCliArgs(["--transport", "http", "--port", "3001"])).toEqual({
      action: "run",
      transport: "http",
      port: 3001,
    });
    expect(parseCliArgs(["--transport=http", "--port", "3003"])).toEqual({
      action: "run",
      transport: "http",
      port: 3003,
    });
    expect(parseCliArgs(["http", "--port=3002"])).toEqual({
      action: "run",
      transport: "http",
      port: 3002,
    });
    expect(parseCliArgs(["http", "--host=localhost"])).toEqual({
      action: "run",
      transport: "http",
      host: "localhost",
    });
  });

  it("uses B2_MCP_TRANSPORT when no transport argument is passed", () => {
    expect(parseCliArgs([], { B2_MCP_TRANSPORT: " HTTP " })).toEqual({
      action: "run",
      transport: "http",
    });
    expect(parseCliArgs(["stdio"], { B2_MCP_TRANSPORT: "http" })).toEqual({
      action: "run",
      transport: "stdio",
    });
  });

  it("supports help and version without requiring transport configuration", () => {
    expect(parseCliArgs(["--help"], { B2_MCP_TRANSPORT: "sse" }).action).toBe("help");
    expect(parseCliArgs(["-h"], { B2_MCP_TRANSPORT: "sse" }).action).toBe("help");
    expect(parseCliArgs(["--version"], { B2_MCP_TRANSPORT: "sse" }).action).toBe("version");
    expect(parseCliArgs(["-v"], { B2_MCP_TRANSPORT: "sse" }).action).toBe("version");
    expect(helpText()).toContain("--transport <stdio|http>");
  });

  it("rejects invalid transport, port, and unknown arguments", () => {
    expect(() => parseCliArgs(["--transport"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--transport", "sse"])).toThrow(CliUsageError);
    expect(() => parseCliArgs([], { B2_MCP_TRANSPORT: "sse" })).toThrow(CliUsageError);
    expect(() => parseCliArgs(["http", "--port", "0"])).toThrow(PortUsageError);
    expect(() => parseCliArgs(["http", "--port", "3000abc"])).toThrow("Invalid port: 3000abc");
    expect(() => parseCliArgs(["http", "--port="])).toThrow("--port requires a value");
    expect(() => parseCliArgs(["http", "--host="])).toThrow("--host requires a value");
    expect(() => parseCliArgs(["--port", "3000"], {})).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--host", "127.0.0.1"], {})).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--session"])).toThrow(CliUsageError);
  });
});
