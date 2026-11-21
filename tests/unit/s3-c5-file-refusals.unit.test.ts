import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
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
    return [];
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

it.each([
  ["s3_put_object", "disabled"],
  ["s3_put_object", "outside root"],
  ["s3_get_object", "disabled"],
  ["s3_get_object", "outside root"],
])("%s returns bad_request for local files %s", async (tool, refusal) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c5-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c5-out-"));
  try {
    const directory = refusal === "disabled" ? root : outside;
    const input = path.join(directory, "input.txt");
    const output = path.join(directory, "out.txt");
    fs.writeFileSync(input, "data");
    const s3 = new DeterministicS3ClientFake();
    const tools = new ToolHarness();
    registerS3ObjectTools(tools, s3.asPeerClient(), versions, {
      ...testConfig,
      allowLocalFiles: refusal !== "disabled",
      fileRoot: root,
    });
    const result = await tools.call(
      tool,
      tool === "s3_put_object"
        ? { bucket: "b", key: "k", filePath: input, contentType: "text/plain" }
        : { bucket: "b", key: "k", saveToPath: output },
    );
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(s3.requests).toEqual([]);
    expect(fs.existsSync(output)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it.each([
  ["s3_put_object", "sandboxed"],
  ["s3_put_object", "unrestricted"],
  ["s3_get_object", "sandboxed"],
  ["s3_get_object", "unrestricted"],
])("%s rejects a NUL byte in a %s local path", async (tool, mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c5-nul-"));
  try {
    const s3 = new DeterministicS3ClientFake();
    const tools = new ToolHarness();
    registerS3ObjectTools(tools, s3.asPeerClient(), versions, {
      ...testConfig,
      fileRoot: mode === "sandboxed" ? root : null,
    });
    const invalidPath = path.join(root, "before\0after");
    const result = await tools.call(
      tool,
      tool === "s3_put_object"
        ? { bucket: "b", key: "k", filePath: invalidPath, contentType: "text/plain" }
        : { bucket: "b", key: "k", saveToPath: invalidPath },
    );
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(s3.requests).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
