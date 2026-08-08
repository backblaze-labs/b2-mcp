import { readFileSync } from "fs";
import { join } from "path";
import { readJson, root } from "./support";

const migrationRecord = readFileSync(join(root, "docs/TYPESCRIPT_7_MIGRATION.md"), "utf8");
const testingDoc = readFileSync(join(root, "docs/TESTING.md"), "utf8");

const pkg = readJson<{
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}>("package.json");

describe("TypeScript 7 migration record", () => {
  it("records the staged migration decision and trigger for issue 114", () => {
    expect(migrationRecord).toContain("Issue: [#114]");
    expect(migrationRecord).toContain("Adopt Option B");
    expect(migrationRecord).toContain("TypeScript 7.1 GA");
    expect(migrationRecord).toContain("typescript-eslint");
    expect(migrationRecord).toContain("stable programmatic compiler API");
    expect(migrationRecord).toContain("do not merge a blanket `typescript@7` upgrade");
    expect(testingDoc).toContain("TYPESCRIPT_7_MIGRATION.md");
  });

  it("keeps the current toolchain on TypeScript 6 while doc lint is blocked", () => {
    // Intentional overlap with readme-drift: the badge guard owns README sync,
    // while this test owns the migration decision's stricter 6.0-line deferral.
    expect(pkg.devDependencies.typescript).toMatch(/^~6\.0\.\d+$/);
    expect(pkg.devDependencies["typescript-eslint"]).toMatch(/^8\.\d+\.\d+$/);
    expect(pkg.dependencies).not.toHaveProperty("typescript");
    expect(pkg.dependencies).not.toHaveProperty("typescript-eslint");
    expect(migrationRecord).toContain("`lint:docs` | Blocked now");
    expect(migrationRecord).toContain("The trigger to proceed is:");
  });

  it("keeps local development off ts-node", () => {
    expect(pkg.scripts.dev).toMatch(/\btsx\b/);
    expect(pkg.scripts.dev).not.toMatch(/\bts-node\b/);
    expect(pkg.devDependencies.tsx).toMatch(/^4\.\d+\.\d+$/);
    expect(pkg.dependencies).not.toHaveProperty("tsx");
    expect(pkg.dependencies).not.toHaveProperty("ts-node");
    expect(pkg.devDependencies).not.toHaveProperty("ts-node");
    expect(migrationRecord).toContain("`dev` uses `tsx`");
  });
});
