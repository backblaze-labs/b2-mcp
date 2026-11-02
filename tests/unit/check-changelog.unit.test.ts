import { join } from "path";
import { pathToFileURL } from "url";

type Verdict = { needsEntry: boolean; hasEntry: boolean; visible: string[] };

async function load() {
  return (await import(
    pathToFileURL(join(__dirname, "../../scripts/check-changelog.mjs")).href
  )) as {
    changelogVerdict: (changed: string[], added: string[], dependenciesChanged: boolean) => Verdict;
  };
}

describe("changelog check", () => {
  it("requires an entry for user-visible source changes", async () => {
    const { changelogVerdict } = await load();
    expect(changelogVerdict(["src/s3/objects.ts"], [], false)).toMatchObject({
      needsEntry: true,
      hasEntry: false,
    });
  });

  it.each([[".changes/unreleased/Fixed-20261027-120000.yaml"], [".changes/v0.2.3.md"]])(
    "accepts %s as the entry",
    async (fragment) => {
      const { changelogVerdict } = await load();
      expect(changelogVerdict(["src/server.ts", fragment], [fragment], false)).toMatchObject({
        needsEntry: true,
        hasEntry: true,
      });
    },
  );

  it("does not count a fragment that was only modified, or a nested path", async () => {
    const { changelogVerdict } = await load();
    expect(
      changelogVerdict(["src/server.ts"], [".changes/unreleased/x/y.yaml"], false).hasEntry,
    ).toBe(false);
    expect(changelogVerdict(["src/server.ts", ".changes/v0.2.2.md"], [], false).hasEntry).toBe(
      false,
    );
  });

  it("requires an entry when runtime dependencies change", async () => {
    const { changelogVerdict } = await load();
    expect(changelogVerdict(["package.json", "pnpm-lock.yaml"], [], true).needsEntry).toBe(true);
  });

  it.each([
    [["tests/unit/auth.unit.test.ts"]],
    [["docs/TESTING.md", "README.md"]],
    [[".github/workflows/test.yml"]],
    [["package.json"]],
    [["srcs/other.ts", "deploy-notes.md", "Dockerfile.dev"]],
  ])("needs no entry for %j", async (changed) => {
    const { changelogVerdict } = await load();
    expect(changelogVerdict(changed, [], false).needsEntry).toBe(false);
  });
});
