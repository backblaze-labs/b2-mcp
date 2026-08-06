import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";

const nodeRequire = createRequire(__filename);
const { parseYaml, pnpmLockToPackageLock, readPackageManagerLock } = nodeRequire(
  "../../scripts/lib/pnpm-lock.cjs",
) as {
  parseYaml: (text: string) => unknown;
  pnpmLockToPackageLock: (
    lock: unknown,
    packageJson?: Record<string, unknown>,
  ) => {
    packages: Record<string, Record<string, unknown>>;
  };
  readPackageManagerLock: (root: string) => { lockfileVersion: number };
};
const root = join(__dirname, "../..");

function registryLock(): unknown {
  return parseYaml(
    [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      root-lib:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "    optionalDependencies:",
      "      optional-lib:",
      "        specifier: 2.0.0",
      "        version: 2.0.0",
      "    devDependencies:",
      "      peer-lib:",
      "        specifier: 4.0.0",
      "        version: 4.0.0(peer-dep@1.0.0)",
      "",
      "packages:",
      "",
      "  root-lib@1.0.0:",
      "    resolution: {integrity: sha512-root}",
      "",
      "  child-lib@1.1.0:",
      "    resolution: {integrity: sha512-child}",
      "",
      "  optional-lib@2.0.0:",
      "    resolution: {integrity: sha512-optional}",
      "",
      "  peer-lib@4.0.0(peer-dep@1.0.0):",
      "    resolution: {integrity: sha512-peer}",
      "    peerDependencies: {peer-dep: 1.0.0}",
      "",
      "snapshots:",
      "",
      "  root-lib@1.0.0:",
      "    dependencies:",
      "      child-lib: 1.1.0",
      "",
      "  child-lib@1.1.0: {}",
      "",
      "  optional-lib@2.0.0: {}",
      "",
      "  peer-lib@4.0.0(peer-dep@1.0.0): {}",
      "",
    ].join("\n"),
  );
}

describe("pnpm lock adapter", () => {
  it("matches the pinned pnpm lockfile format", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const lock = parseYaml(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")) as {
      lockfileVersion?: string;
    };

    expect(packageJson.packageManager).toMatch(/^pnpm@11\.20\.0\+/);
    expect(lock.lockfileVersion).toBe("9.0");
  });

  it("converts direct, optional, transitive, and peer-suffixed packages", () => {
    const converted = pnpmLockToPackageLock(registryLock(), {
      name: "fixture",
      version: "0.0.0",
    });

    expect(converted.packages[""].dependencies).toEqual({ "root-lib": "1.0.0" });
    expect(converted.packages[""].optionalDependencies).toEqual({ "optional-lib": "2.0.0" });
    expect(converted.packages["node_modules/root-lib"].dev).toBe(false);
    expect(converted.packages["node_modules/child-lib"].dev).toBe(false);
    expect(converted.packages["node_modules/optional-lib"].dev).toBe(false);
    expect(converted.packages["node_modules/peer-lib"].dev).toBe(true);
    expect(converted.packages["node_modules/peer-lib"].peerDependencies).toEqual({
      "peer-dep": "1.0.0",
    });
  });

  it("fails closed for unsupported lockfile versions", () => {
    expect(() =>
      pnpmLockToPackageLock({
        lockfileVersion: "99.0",
        importers: { ".": {} },
        packages: { "left-pad@1.3.0": { resolution: { integrity: "sha512-left" } } },
        snapshots: { "left-pad@1.3.0": {} },
      }),
    ).toThrow(/Unsupported pnpm lockfileVersion/);
  });

  it("fails closed for git or URL package keys instead of dropping them", () => {
    expect(() =>
      pnpmLockToPackageLock({
        lockfileVersion: "9.0",
        importers: { ".": {} },
        packages: {
          "bad@git+https://example.invalid/repo.git": {
            resolution: { integrity: "sha512-bad" },
          },
        },
        snapshots: {},
      }),
    ).toThrow(/Unsupported pnpm lock package key/);
  });

  it.each([
    ["anchor", "lockfileVersion: &version '9.0'\n"],
    ["alias", "lockfileVersion: *version\n"],
    ["block scalar", "lockfileVersion: |\n  9.0\n"],
    ["folded scalar", "lockfileVersion: >\n  9.0\n"],
    ["multiline quote", 'lockfileVersion: "9.0\n  continued"\n'],
    ["complex key", "? lockfileVersion\n: '9.0'\n"],
  ])("fails closed for unsupported YAML %s syntax", (_name, text) => {
    expect(() => parseYaml(text)).toThrow(/Unsupported (?:YAML|multiline)/);
  });

  it.each([
    ["importer link dependency", { dependencies: { "local-lib": { version: "link:../local" } } }],
    ["importer file dependency", { dependencies: { "local-lib": { version: "file:../local" } } }],
    [
      "importer git dependency",
      { dependencies: { "local-lib": { version: "github:example/local#abc123" } } },
    ],
  ])("fails closed for unsupported %s references", (_name, importer) => {
    expect(() =>
      pnpmLockToPackageLock({
        lockfileVersion: "9.0",
        importers: { ".": importer },
        packages: { "root-lib@1.0.0": { resolution: { integrity: "sha512-root" } } },
        snapshots: { "root-lib@1.0.0": {} },
      }),
    ).toThrow(/Unsupported (?:non-registry |pnpm )?dependency reference/);
  });

  it("fails closed for unsupported snapshot dependency references", () => {
    expect(() =>
      pnpmLockToPackageLock({
        lockfileVersion: "9.0",
        importers: { ".": { dependencies: { "root-lib": { version: "1.0.0" } } } },
        packages: { "root-lib@1.0.0": { resolution: { integrity: "sha512-root" } } },
        snapshots: { "root-lib@1.0.0": { dependencies: { "local-lib": "file:../local" } } },
      }),
    ).toThrow(/Unsupported non-registry dependency reference/);
  });

  it("keeps package-lock fallback scoped to fixtures without pnpm locks", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-pnpm-lock-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"fixture","version":"0.0.0"}\n');
      writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');

      expect(readPackageManagerLock(dir).lockfileVersion).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back when an existing pnpm lock is unsupported", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-pnpm-lock-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"fixture","version":"0.0.0"}\n');
      writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '99.0'\n");

      expect(() => readPackageManagerLock(dir)).toThrow(/Unsupported pnpm lockfileVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
