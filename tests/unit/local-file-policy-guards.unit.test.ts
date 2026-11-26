/**
 * Regression guards for case C14: the documented local-file policy defaults. These pin the
 * current, intended behavior: trusted local stdio allows local files unless switched off or
 * sandboxed; the HTTP transport never enables local files unless explicitly opted in together
 * with a sandbox root.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HttpHeaderCredentialProvider, StdioEnvCredentialProvider } from "../../src/credentials";
import { FileAccessError, resolveLocalPath } from "../../src/utils/fs-guard";

const savedEnv = process.env;

beforeEach(() => {
  process.env = { ...savedEnv };
  for (const name of ["B2_ALLOW_LOCAL_FILES", "B2_FILE_ROOT", "B2_HTTP_CREDENTIAL_MODE"]) {
    delete process.env[name];
  }
  process.env.B2_APPLICATION_KEY_ID = "stdio-id";
  process.env.B2_APPLICATION_KEY = "stdio-secret";
  process.env.B2_SECRET_SINK = "off";
});

afterEach(() => {
  process.env = savedEnv;
});

const headerRequest = {
  headers: { "x-b2-mcp-key-id": "header-id", "x-b2-mcp-key": "header-secret" },
} as never;

describe("local-file policy defaults (Finding C14 guard)", () => {
  it("stdio: local files are allowed by default (trusted local process) with no sandbox root", () => {
    const { config } = new StdioEnvCredentialProvider().resolve();
    expect(config.allowLocalFiles, "stdio allows local files by default").toBe(true);
    expect(config.fileRoot, "no sandbox root by default").toBeNull();
  });

  it("stdio: B2_ALLOW_LOCAL_FILES=false switches local files off", () => {
    process.env.B2_ALLOW_LOCAL_FILES = "false";
    const { config } = new StdioEnvCredentialProvider().resolve();
    expect(config.allowLocalFiles, "local files switched off").toBe(false);
    expect(
      () => resolveLocalPath(config, "/etc/hosts", "read"),
      "reading a local file is refused when local files are off",
    ).toThrow(FileAccessError);
  });

  it("stdio: B2_FILE_ROOT confines local file access to the root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c14-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c14-out-"));
    try {
      fs.writeFileSync(path.join(outside, "x.txt"), "x");
      process.env.B2_FILE_ROOT = root;
      const { config } = new StdioEnvCredentialProvider().resolve();
      expect(config.fileRoot, "sandbox root from B2_FILE_ROOT").toBe(root);
      expect(
        () => resolveLocalPath(config, path.join(outside, "x.txt"), "read"),
        "a file outside the sandbox root is refused",
      ).toThrow(FileAccessError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("http: local files are off by default", () => {
    const { config } = new HttpHeaderCredentialProvider().resolve({ req: headerRequest });
    expect(config.allowLocalFiles, "http keeps local files off by default").toBe(false);
  });

  it("http: B2_ALLOW_LOCAL_FILES=true without a sandbox root still leaves local files off", () => {
    process.env.B2_ALLOW_LOCAL_FILES = "true";
    const { config } = new HttpHeaderCredentialProvider().resolve({ req: headerRequest });
    expect(config.allowLocalFiles, "http needs a sandbox root to enable local files").toBe(false);
  });
});
