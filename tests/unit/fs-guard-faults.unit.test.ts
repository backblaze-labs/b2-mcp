import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import { parseB2Error, parseErrorText } from "../../src/utils/errors";
import { isInsideFileRoot, resolveLocalPath } from "../../src/utils/fs-guard";
import type { B2S3VersionGuard } from "../../src/utils/types";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  testConfig,
} from "../support/deterministic-fakes";

const fault = vi.hoisted(() => ({
  path: "",
  error: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  const realpathSync = Object.assign(
    (name: fs.PathLike, ...options: unknown[]) => {
      if (fault.error && String(name) === fault.path) throw fault.error;
      return Reflect.apply(original.realpathSync, undefined, [name, ...options]);
    },
    { native: original.realpathSync.native },
  );
  return { ...original, realpathSync };
});

const versions: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("Unexpected version lookup");
  },
  async resolveS3FileVersions() {
    return [];
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

let root: string;
let input: string;
let parent: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b2-fs-fault-")));
  input = path.join(root, "input.txt");
  parent = path.join(root, "parent");
  fs.writeFileSync(input, "data");
  fs.mkdirSync(parent);
});

afterEach(() => {
  fault.path = "";
  fault.error = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("filesystem guard unexpected failures", () => {
  for (const code of ["EIO", "EMFILE"]) {
    it.each(["sandbox root", "read path", "write ancestor", "pinned root"])(
      `preserves ${code} while resolving the %s as a server error`,
      (where) => {
        const config = { ...testConfig, fileRoot: root };
        fault.path = where === "read path" ? input : where === "write ancestor" ? parent : root;
        fault.error = Object.assign(new Error(`simulated ${code}`), { code });
        let caught: unknown;
        try {
          if (where === "pinned root") isInsideFileRoot(config, input);
          else
            resolveLocalPath(
              config,
              where === "write ancestor" ? path.join(parent, "out") : input,
              where === "write ancestor" ? "write" : "read",
            );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe(fault.error);
        expect(parseB2Error(caught)).toMatchObject({ status: 500, code });
      },
    );

    it.each(["s3_put_object", "s3_get_object"])(
      `returns a server error from %s when sandbox root resolution fails with ${code}`,
      async (tool) => {
        const s3 = new DeterministicS3ClientFake();
        const tools = new ToolHarness();
        registerS3ObjectTools(tools, s3.asPeerClient(), versions, {
          ...testConfig,
          fileRoot: root,
        });
        fault.path = root;
        fault.error = Object.assign(new Error(`simulated ${code}`), { code });
        const result = await tools.call(
          tool,
          tool === "s3_put_object"
            ? { bucket: "b", key: "k", filePath: input, contentType: "text/plain" }
            : { bucket: "b", key: "k", saveToPath: path.join(parent, "out") },
        );
        expect(result.isError).toBe(true);
        expect(parseErrorText(parseResult(result) as string)).toMatchObject({ status: 500, code });
        expect(s3.requests).toEqual([]);
      },
    );
  }
});

describe("filesystem guard expected path refusals", () => {
  it.each(
    ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EACCES", "EPERM"].flatMap((code) =>
      ["sandbox root", "read path", "pinned root"].map((where) => ({ code, where })),
    ),
  )("classifies $code at the $where as bad_request", ({ code, where }) => {
    const config = { ...testConfig, fileRoot: root };
    fault.path = where === "read path" ? input : root;
    fault.error = Object.assign(new Error(`simulated ${code}`), { code });
    let caught: unknown;
    try {
      if (where === "pinned root") isInsideFileRoot(config, input);
      else resolveLocalPath(config, input, "read");
    } catch (err) {
      caught = err;
    }
    expect(parseB2Error(caught)).toMatchObject({ status: 400, code: "bad_request" });
  });
});

it
  .skipIf(process.platform !== "linux" || !fs.existsSync("/proc/self/fd"))
  .each(["EIO", "EMFILE", "EBUSY", "EROFS", "EISDIR", "ENOTEMPTY", "EXDEV"])(
  "returns 500 and closes the directory if pinning encounters %s",
  async (code) => {
    const s3 = new DeterministicS3ClientFake();
    const tools = new ToolHarness();
    registerS3ObjectTools(tools, s3.asPeerClient(), versions, { ...testConfig, fileRoot: root });
    const open = fs.promises.open.bind(fs.promises);
    let pin: fs.promises.FileHandle | undefined;
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...(args as Parameters<typeof open>));
      if (String(args[0]) === parent && typeof args[1] === "number") {
        pin = handle;
        fault.path = root;
        fault.error = Object.assign(new Error(`simulated ${code}`), { code });
      }
      return handle;
    });
    try {
      const result = await tools.call("s3_get_object", {
        bucket: "b",
        key: "k",
        saveToPath: path.join(parent, "out"),
      });
      expect(pin).toBeDefined();
      expect(result.isError).toBe(true);
      expect(parseErrorText(parseResult(result) as string)).toMatchObject({ status: 500, code });
      expect(s3.requests).toEqual([]);
      expect(pin?.fd).toBe(-1);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  },
);
