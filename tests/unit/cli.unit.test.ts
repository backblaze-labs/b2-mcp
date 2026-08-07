import { CliUsageError, helpText, parseCliArgs } from "../../src/cli";

describe("CLI argument parsing", () => {
  it("defaults to stdio transport", () => {
    expect(parseCliArgs([])).toEqual({ action: "run", transport: "stdio" });
  });

  it("accepts HTTP transport and port flags", () => {
    expect(parseCliArgs(["--transport", "http", "--port", "3001"])).toEqual({
      action: "run",
      transport: "http",
      port: 3001,
    });
    expect(parseCliArgs(["http", "--port=3002"])).toEqual({
      action: "run",
      transport: "http",
      port: 3002,
    });
  });

  it("supports help and version without requiring transport configuration", () => {
    expect(parseCliArgs(["--help"]).action).toBe("help");
    expect(parseCliArgs(["--version"]).action).toBe("version");
    expect(helpText()).toContain("--transport <stdio|http>");
  });

  it("rejects invalid transport, port, and unknown arguments", () => {
    expect(() => parseCliArgs(["--transport", "sse"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["http", "--port", "0"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--port", "3000"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--session"])).toThrow(CliUsageError);
  });
});
