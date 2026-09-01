import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { once } from "events";
import {
  MODERN_META,
  MODERN_PROTOCOL_VERSION,
  RawStdioSession,
  ROOT,
  protocolEnv,
} from "../support/protocol";
import { closeClient, connectModernStdioClient } from "./support/clients";

function resultOf(frame: any): any {
  expect(frame.error).toBeUndefined();
  expect(frame.result).toBeDefined();
  return frame.result;
}

function errorOf(frame: any): any {
  expect(frame.result).toBeUndefined();
  expect(frame.error).toBeDefined();
  return frame.error;
}

function send(child: ChildProcessWithoutNullStreams, id: number, method: string): void {
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: MODERN_META } })}\n`,
  );
}

describe("stdio transport (MCP 2026-07-28)", () => {
  let raw: RawStdioSession | null = null;

  afterEach(async () => {
    await raw?.close();
    raw = null;
  });

  it("does not copy parent secret variables into spawned protocol processes", () => {
    const previous = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      NPM_TOKEN: process.env.NPM_TOKEN,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    process.env.GITHUB_TOKEN = "sentinel-github-token";
    process.env.NPM_TOKEN = "sentinel-npm-token";
    process.env.AWS_SECRET_ACCESS_KEY = "sentinel-aws-secret";
    try {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          [
            "process.stdout.write(JSON.stringify({",
            "github: process.env.GITHUB_TOKEN ?? null,",
            "npm: process.env.NPM_TOKEN ?? null,",
            "aws: process.env.AWS_SECRET_ACCESS_KEY ?? null",
            "}));",
          ].join(""),
        ],
        { env: protocolEnv(), encoding: "utf8" },
      );
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ github: null, npm: null, aws: null });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("keeps a never-settling capability bootstrap alive until the fail-closed deadline", async () => {
    const script = [
      'const server = require("./dist/server.js");',
      "server.fetchCapabilities = () => new Promise(() => undefined);",
      'require("./dist/index.js").startStdio().catch((err) => {',
      "  console.error(err && err.stack ? err.stack : err);",
      "  process.exit(1);",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], {
      cwd: ROOT,
      env: protocolEnv({
        B2_REGISTER_ALL_TOOLS: "false",
        B2_SECRET_SINK: "off",
        B2_STDIO_CAPABILITY_TIMEOUT_MS: "50",
        LOG_LEVEL: "info",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames: any[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) frames.push(JSON.parse(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const waitForFrame = (id: number) =>
      new Promise<any>((resolve, reject) => {
        const cleanup = () => {
          clearInterval(interval);
          clearTimeout(timer);
          child.off("exit", onExit);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(
            new Error(`stdio child exited before response ${id}: ${code ?? signal}\n${stderr}`),
          );
        };
        const interval = setInterval(() => {
          const frame = frames.find((candidate) => candidate.id === id);
          if (!frame) return;
          cleanup();
          resolve(frame);
        }, 10);
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for response ${id}\n${stderr}`));
        }, 2_000);
        child.on("exit", onExit);
      });

    try {
      send(child, 1, "server/discover");
      const discover = resultOf(await waitForFrame(1));
      expect(discover.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);

      send(child, 2, "tools/list");
      const listed = resultOf(await waitForFrame(2));
      const toolNames = listed.tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("b2_authorize_account");
      expect(toolNames).not.toContain("b2_create_bucket");
      expect(toolNames).not.toContain("b2_create_key");
      expect(toolNames).not.toContain("s3_put_object");
      expect(toolNames).not.toContain("s3_delete_object");
      expect(toolNames).not.toContain("b2_list_groups");
      expect(stderr).toContain("capability.fetch.stdio_degraded");
      expect(stderr).toContain("stdio_capability_deadline_exceeded");
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      await once(child, "exit").catch(() => undefined);
      clearTimeout(timer);
    }
  });

  it("serves discover, list, and representative tool calls through the SDK client", async () => {
    const { client } = await connectModernStdioClient();
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);

      const discover = client.getDiscoverResult() ?? (await client.discover());
      expect(discover.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
      expect(discover.capabilities.tools).toBeDefined();
      expect(client.getServerVersion()?.name).toBe("backblaze-b2");

      const listed = await client.listTools(undefined, { cacheMode: "refresh" });
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("b2_list_buckets");
      expect(toolNames).toContain("s3_list_objects_v2");

      const bucketName = "protocol-stdio-modern";
      const create = await client.callTool({
        name: "b2_create_bucket",
        arguments: { bucketName, bucketType: "allPrivate" },
      });
      expect(create.isError).not.toBe(true);

      const b2Call = await client.callTool({ name: "b2_list_buckets", arguments: {} });
      expect(b2Call.isError).not.toBe(true);
      expect(JSON.stringify(b2Call)).toContain(bucketName);

      const s3Call = await client.callTool({
        name: "s3_list_objects_v2",
        arguments: { bucket: bucketName },
      });
      expect(s3Call.isError).not.toBe(true);
      expect(JSON.stringify(s3Call)).toContain("objects");
    } finally {
      await closeClient(client);
    }
  });

  it("keeps modern raw stdio frames sessionless and sends logs to stderr", async () => {
    raw = new RawStdioSession();
    raw.start({ LOG_LEVEL: "info" });

    const discover = resultOf(
      await raw.request("server/discover", {
        _meta: MODERN_META,
      }),
    );
    expect(discover.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);
    expect(discover.resultType).toBe("complete");
    expect(discover.ttlMs).toBe(30_000);
    expect(discover.cacheScope).toBe("private");
    expect(discover._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "backblaze-b2",
    });

    const listed = resultOf(
      await raw.request("tools/list", {
        _meta: MODERN_META,
      }),
    );
    expect(listed.resultType).toBe("complete");
    expect(listed.ttlMs).toBe(30_000);
    expect(listed.cacheScope).toBe("private");
    expect(listed.tools.some((tool: { name: string }) => tool.name === "b2_list_buckets")).toBe(
      true,
    );

    const ping = errorOf(await raw.request("ping", { _meta: MODERN_META }));
    const logging = errorOf(
      await raw.request("logging/setLevel", { level: "info", _meta: MODERN_META }),
    );
    expect(ping.code).toBe(-32601);
    expect(logging.code).toBe(-32601);

    for (const line of raw.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toMatch(/server\.started|server\.ready|Mcp-Session-Id/i);
    }
    expect(raw.stderrChunks.join("")).toMatch(/server\.(started|ready)/);
  });

  it("returns controlled modern errors for invalid tool requests", async () => {
    raw = new RawStdioSession();
    raw.start();

    const invalidName = errorOf(
      await raw.request("tools/call", {
        name: "missing_tool",
        arguments: {},
        _meta: MODERN_META,
      }),
    );
    const malformedArguments = errorOf(
      await raw.request("tools/call", {
        name: "b2_list_buckets",
        arguments: "not-an-object" as unknown as Record<string, unknown>,
        _meta: MODERN_META,
      }),
    );
    const schemaFailure = resultOf(
      await raw.request("tools/call", {
        name: "b2_create_bucket",
        arguments: { bucketType: "allPrivate" },
        _meta: MODERN_META,
      }),
    );

    expect(invalidName.code).toBe(-32602);
    expect(malformedArguments.code).toBe(-32602);
    expect(schemaFailure.isError).toBe(true);
    expect(JSON.stringify(schemaFailure)).toMatch(/validation/i);
  });
});
