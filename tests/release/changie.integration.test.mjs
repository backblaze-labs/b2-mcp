import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function entries(markdown) {
  const result = [];
  let kind = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("### ")) kind = line.slice(4);
    else if (line.startsWith("- ")) result.push({ kind, body: line.slice(2) });
    else if (line.startsWith("  ") && result.length) result[result.length - 1].body += `\n${line}`;
  }
  return result;
}

test("Changie reproduces the committed changelog and preserves migrated entries", () => {
  const fixture = mkdtempSync(join(tmpdir(), "b2-mcp-changie-"));
  const changie = (...args) => {
    const result = spawnSync("changie", args, { cwd: fixture, encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  try {
    cpSync(join(root, ".changie.yaml"), join(fixture, ".changie.yaml"));
    cpSync(join(root, ".changes"), join(fixture, ".changes"), { recursive: true });
    const committed = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const generated = changie("merge", "--dry-run");
    assert.ok(generated === committed, "Changie output must match the committed changelog");

    const original = readFileSync(
      join(root, "tests/fixtures/release-standard/changelog-before-changie.md"),
      "utf8",
    );
    const headings = [...original.matchAll(/^## \[([\d.]+)\] - .+$/gm)];
    assert.equal(headings.length, 6);
    const footers = original.search(/^\[Unreleased\]: /m);
    assert.ok(footers > 0);
    for (const [index, heading] of headings.entries()) {
      const expected = original
        .slice(heading.index, headings[index + 1]?.index ?? footers)
        .trimEnd();
      assert.ok(generated.includes(expected), `archived release v${heading[1]} was altered`);
    }
    const historicalFooters = original.match(/^\[[\d.]+\]: .+$/gm) ?? [];
    assert.equal(historicalFooters.length, 6);
    const generatedLines = generated.split("\n");
    for (const footer of historicalFooters) {
      assert.equal(
        generatedLines.filter((line) => line === footer).length,
        1,
        `historical release footer was omitted or altered: ${footer}`,
      );
    }

    const pending = entries(original.slice(original.indexOf("## [Unreleased]"), headings[0].index));
    assert.equal(pending.length, 11);
    if (readdirSync(join(fixture, ".changes/unreleased")).some((name) => name.endsWith(".yaml"))) {
      changie("batch", "v999999.0.0", "--allow-no-changes=false");
    }
    const batched = entries(changie("merge", "--dry-run"));
    for (const entry of pending) {
      assert.ok(
        batched.some((candidate) => candidate.kind === entry.kind && candidate.body === entry.body),
        `migrated ${entry.kind} entry was omitted or altered: ${entry.body.split("\n")[0]}`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
