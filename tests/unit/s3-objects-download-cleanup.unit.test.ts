import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { B2S3ObjectBody } from "../../src/s3/aws-sdk-adapter";
import { registerS3ObjectTools } from "../../src/s3/objects";
import {
  circuitBreaker,
  s3CircuitBreaker,
  s3TransferCircuitBreaker,
} from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import type { B2S3VersionGuard } from "../../src/utils/types";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  testConfig,
} from "../support/deterministic-fakes";

const versions: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("Unexpected version lookup");
  },
  async resolveS3FileVersions() {
    throw new Error("Unexpected version lookup");
  },
  async getCurrentS3FileVersion() {
    throw new Error("Unexpected version lookup");
  },
};

let root: string;
let dir: string;
let target: string;
let s3: DeterministicS3ClientFake;
let tools: ToolHarness;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b2-download-cleanup-")));
  dir = path.join(root, "new-parent", "nested");
  target = path.join(dir, "out.bin");
  s3 = new DeterministicS3ClientFake();
  tools = new ToolHarness();
  registerS3ObjectTools(tools, s3.asPeerClient(), versions, { ...testConfig, fileRoot: root });
});

afterEach(() => {
  vi.restoreAllMocks();
  circuitBreaker.close();
  s3CircuitBreaker.close();
  s3TransferCircuitBreaker.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function queueBody(fail = false): void {
  const body = Readable.from(
    (async function* () {
      yield Buffer.from("downloaded bytes");
      if (fail) throw Object.assign(new Error("stream interrupted"), { code: "ECONNRESET" });
    })(),
  );
  s3.respond("getObject", {
    key: "object",
    metadata: {},
    contentLength: 16,
    body: body as B2S3ObjectBody,
  });
}

const download = () =>
  tools.call("s3_get_object", { bucket: "bucket", key: "object", saveToPath: target });

it("leaves no new directories or partial files when a download fails mid-stream", async () => {
  queueBody(true);
  const result = await download();
  expect(result.isError).toBe(true);
  expect(s3.requestsFor("getObject")).toHaveLength(1);
  expect(fs.readdirSync(root, { recursive: true })).toEqual([]);
});

it("preserves an existing parent after a GET failure without creating final parents", async () => {
  const existing = path.dirname(dir);
  fs.mkdirSync(existing);
  s3.respond("getObject", () => {
    throw new Error("GET failed");
  });
  const result = await download();
  expect(result.isError).toBe(true);
  expect(s3.requestsFor("getObject")).toHaveLength(1);
  expect(fs.readdirSync(root)).toEqual(["new-parent"]);
  expect(fs.readdirSync(existing)).toEqual([]);
});

it("preserves a concurrently populated directory after a transfer failure", async () => {
  s3.respond("getObject", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "other.txt"), "other");
    throw new Error("GET failed");
  });
  const result = await download();
  expect(result.isError).toBe(true);
  expect(fs.readdirSync(dir)).toEqual(["other.txt"]);
  expect(fs.readFileSync(path.join(dir, "other.txt"), "utf8")).toBe("other");
  expect(fs.readdirSync(root)).toEqual(["new-parent"]);
});

it("preserves a replacement directory if finalization fails after creating parents", async () => {
  queueBody();
  const mkdir = fs.promises.mkdir.bind(fs.promises);
  let replacement: fs.Stats | undefined;
  vi.spyOn(fs.promises, "mkdir").mockImplementation(async (...args) => {
    const result = await mkdir(...args);
    if (String(args[0]) === dir) {
      fs.renameSync(dir, `${dir}.original`);
      fs.mkdirSync(dir);
      replacement = fs.statSync(dir);
      throw Object.assign(new Error("finalization failed"), { code: "EIO" });
    }
    return result;
  });
  const result = await download();
  expect(result.isError).toBe(true);
  expect(s3.requestsFor("getObject")).toHaveLength(1);
  expect(replacement).toBeDefined();
  expect(fs.statSync(dir).ino).toBe(replacement?.ino);
  expect(fs.statSync(dir).dev).toBe(replacement?.dev);
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readdirSync(root)).toEqual(["new-parent"]);
  expect(
    fs.readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith(".part")),
  ).toEqual([]);
});

it.skipIf(process.platform !== "linux").each(["before", "after"] as const)(
  "refuses a newly created destination moved outside the root %s its pin is checked",
  async (when) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-final-pin-out-"));
    const moved = path.join(outside, "moved");
    let swapped = false;
    const swap = () => {
      fs.renameSync(dir, moved);
      fs.symlinkSync(outside, dir);
      swapped = true;
    };
    if (when === "before") {
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === dir) swap();
        return handle;
      });
    } else {
      const readlink = fs.promises.readlink.bind(fs.promises);
      vi.spyOn(fs.promises, "readlink").mockImplementation(async (...args) => {
        const location = await readlink(...args);
        // Return the pre-swap location once; the pre-commit recheck must see the move.
        if (location === dir && !swapped) swap();
        return location;
      });
    }
    queueBody();
    try {
      const result = await download();
      expect(result.isError).toBe(true);
      const error = parseResult(result) as string;
      expect(parseErrorText(error)).toMatchObject({ code: "bad_request", status: 400 });
      expect(error).toMatch(/outside the allowed directory/i);
      expect(error).toContain(
        when === "before"
          ? "changed while the download was being prepared"
          : "was moved while the download was in flight",
      );
      expect(swapped).toBe(true);
      expect(s3.requestsFor("getObject")).toHaveLength(1);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(outside, { recursive: true })).toEqual(["moved"]);
      expect(fs.readdirSync(root)).toEqual(["new-parent"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rechecks the file root after mkdir follows a link changed during the GET",
  async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-final-link-out-"));
    const escaped = path.join(outside, "escaped");
    const link = path.join(root, "link");
    fs.symlinkSync(path.join(root, "missing"), link);
    dir = path.join(link, "sub");
    target = path.join(dir, "out.bin");
    const body = Readable.from([Buffer.from("downloaded bytes")]);
    s3.respond("getObject", () => {
      fs.unlinkSync(link);
      fs.symlinkSync(escaped, link);
      return { key: "object", metadata: {}, contentLength: 16, body };
    });
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    let finalized = false;
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === dir) {
        // Make the dangling outside link live after the pre-mkdir path check.
        fs.mkdirSync(escaped);
        finalized = true;
      }
      return mkdir(...args);
    });
    try {
      const result = await download();
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toBe(
        `B2 Error [bad_request] (HTTP 400): Path is outside the allowed directory (${root}).`,
      );
      expect(finalized).toBe(true);
      expect(s3.requestsFor("getObject")).toHaveLength(1);
      expect(fs.readdirSync(outside, { recursive: true })).toEqual([
        "escaped",
        path.join("escaped", "sub"),
      ]);
      expect(fs.readdirSync(root)).toEqual(["link"]);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

it("atomically renames the complete temporary file into its final destination", async () => {
  queueBody();
  const rename = fs.promises.rename.bind(fs.promises);
  const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    expect(String(from)).toMatch(/\.part$/);
    expect(fs.readFileSync(from, "utf8")).toBe("downloaded bytes");
    expect(fs.existsSync(target)).toBe(false);
    return rename(from, to);
  });
  const result = await download();
  expect(result.isError).not.toBe(true);
  expect(renameSpy).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(target, "utf8")).toBe("downloaded bytes");
  expect(fs.readdirSync(root, { recursive: true })).toEqual([
    "new-parent",
    path.join("new-parent", "nested"),
    path.join("new-parent", "nested", "out.bin"),
  ]);
});

it("a hard kill leaves only a partial temp file, with no final file or new final parents", async () => {
  // SIGKILL cannot run cleanup. Wait for a real write, kill, then inspect durable state.
  const source = `
    const fs = require('node:fs');
    const { Readable } = require('node:stream');
    const { registerS3ObjectTools } = require('./src/s3/objects.ts');
    const { ToolHarness, testConfig } = require('./tests/support/deterministic-fakes.ts');
    const tools = new ToolHarness();
    const open = fs.promises.open.bind(fs.promises);
    fs.promises.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.part')) {
        const write = handle.write.bind(handle);
        let written = 0;
        handle.write = async (...parts) => {
          const result = await write(...parts);
          written += result.bytesWritten;
          if (written === Buffer.byteLength('partial bytes')) process.send('written');
          return result;
        };
      }
      return handle;
    };
    let sent = false;
    const body = new Readable({read() {
      if (!sent) { sent = true; this.push(Buffer.from('partial bytes')); }
    }});
    const s3 = { async getObject() {return {key:'object', metadata:{}, body, contentLength:100};} };
    registerS3ObjectTools(tools, s3, {}, {...testConfig, fileRoot:process.env.DOWNLOAD_ROOT});
    tools.call('s3_get_object', {bucket:'bucket', key:'object', saveToPath:process.env.DOWNLOAD_TARGET})
      .then(() => process.exit(2));
  `;
  const child = spawn(process.execPath, ["--require", "tsx/cjs", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, DOWNLOAD_ROOT: root, DOWNLOAD_TARGET: target },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  child.stderr?.resume();
  try {
    await once(child, "message", { signal: AbortSignal.timeout(5_000) });
    child.kill("SIGKILL");
    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    const remaining = fs.readdirSync(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatch(/^out\.bin\.b2mcp-[a-f0-9]+\.part$/);
    expect(fs.readFileSync(path.join(root, remaining[0]), "utf8")).toBe("partial bytes");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

it.each(["tool", "saveToPath"])(
  "documents ancestor staging and interruption behavior in the %s description",
  (field) => {
    const registrar = new ToolHarness();
    const registration = vi.spyOn(registrar, "registerTool");
    registerS3ObjectTools(registrar, s3.asPeerClient(), versions, {
      ...testConfig,
      fileRoot: root,
    });
    const definition = registration.mock.calls.find(([name]) => name === "s3_get_object")?.[1];
    expect(definition).toBeDefined();
    const shape = definition?.inputSchema as Record<string, { description?: string }>;
    const description = field === "tool" ? definition?.description : shape.saveToPath.description;
    expect(description).toMatch(/nearest existing ancestor/);
    expect(description).toMatch(/parent directories only after a complete download/);
    expect(description).toMatch(/SIGKILL may leave a \.part there/);
    expect(description).not.toMatch(/temporary sibling file/);
  },
);
