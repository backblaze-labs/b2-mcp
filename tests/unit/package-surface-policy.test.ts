import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

describe("package surface policy", () => {
  const pkg = readJson<{
    files: string[];
    devDependencies: Record<string, string>;
  }>("package.json");
  const smoke = readFileSync(join(root, "scripts/packed-consumer-smoke.mjs"), "utf8");

  it("keeps repo-only policy files out of the published npm package", () => {
    expect(pkg.files).not.toEqual(
      expect.arrayContaining(["runtime-policy.json", "audit-policy.json"]),
    );
    expect(smoke).toContain('["runtime-policy.json", "audit-policy.json"]');
    expect(smoke).toContain("should not be published");
  });

  it("keeps the cold packed-consumer install retry hardened", () => {
    expect(smoke).toContain("npm_config_fetch_retries");
    expect(smoke).toContain("npm_config_fetch_retry_factor");
    expect(smoke).toContain("npm_config_fetch_retry_mintimeout");
    expect(smoke).toContain("npm_config_fetch_retry_maxtimeout");
    expect(smoke).toMatch(/retryLabel:\s*"npm ci"/);
    expect(smoke).toMatch(/retries:\s*[1-9]/);
  });

  it("exact-pins runtime-sensitive lint and typing packages", () => {
    for (const name of ["@eslint/js", "@types/node", "eslint", "typescript-eslint"]) {
      expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
