import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { root } from "../contract/support";

const script = join(root, "scripts/check-doc-links.mjs");

function runDocLinks(rootDir: string) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, B2_MCP_DOC_LINK_ROOT: rootDir },
    encoding: "utf8",
  });
}

describe("Markdown link checker", () => {
  it("accepts local links that resolve inside the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-doc-links-ok-"));
    try {
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "README.md"), "[Guide](docs/guide.md)\n[Anchor](#heading)\n");
      writeFileSync(join(dir, "docs/guide.md"), "# Guide\n");

      const result = runDocLinks(dir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("doc-links: local Markdown links are valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects broken local links", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-doc-links-broken-"));
    try {
      writeFileSync(join(dir, "README.md"), "[Missing](docs/missing.md)\n");

      const result = runDocLinks(dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("broken local link: docs/missing.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
