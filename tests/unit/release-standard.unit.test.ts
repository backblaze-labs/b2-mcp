import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/publish.yml"), "utf8"));

type ChangeEntry = { kind: string; body: string };

function changeEntries(markdown: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  let kind = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("### ")) kind = line.slice(4);
    else if (line.startsWith("- ")) entries.push({ kind, body: line.slice(2) });
    else if (line.startsWith("  ") && entries.length > 0) {
      entries[entries.length - 1].body += `\n${line}`;
    }
  }
  return entries;
}

describe("release preparation standard", () => {
  it("signs release tags with the reviewed SSH key", () => {
    const release = readFileSync(join(root, "RELEASE.md"), "utf8");
    const command = release.match(/^\s*git -c gpg\.format=ssh .* tag -s vX\.Y\.Z .*$/m)?.[0] ?? "";
    expect(command, "documented SSH signing command").not.toBe("");
    const result = spawnSync("bash", ["-c", `git() { printf '%s\\n' "$@"; }; ${command}`], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_SIGNING_KEY: "/tmp/reviewed-release-key" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "-c",
      "gpg.format=ssh",
      "-c",
      "user.signingkey=/tmp/reviewed-release-key",
      "tag",
      "-s",
      "vX.Y.Z",
      "-m",
      "vX.Y.Z",
    ]);
  });

  it("previews the explicitly selected version before the npm bump", () => {
    const release = readFileSync(join(root, "RELEASE.md"), "utf8");
    const preview = release.match(/^\s*changie batch .*--dry-run.*$/m)?.[0] ?? "";
    expect(preview, "documented standalone Changie preview command").not.toBe("");

    const result = spawnSync("bash", ["-c", `changie() { printf '%s\\n' "$@"; }; ${preview}`], {
      encoding: "utf8",
      env: { ...process.env, NEXT_VERSION: "1.2.3" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "batch",
      "v1.2.3",
      "--dry-run",
      "--allow-no-changes=false",
    ]);
  });

  it("uses Changie fragments without changing npm version selection", () => {
    const config = parse(readFileSync(join(root, ".changie.yaml"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    expect(config.changesDir).toBe(".changes");
    expect(config.unreleasedDir).toBe("unreleased");
    expect(config.changelogPath).toBe("CHANGELOG.md");
    expect(config.versionFormat).toContain("## [{{.VersionNoPrefix}}]");
    expect(config.kinds.map((kind: { label: string }) => kind.label)).toEqual([
      "Added",
      "Changed",
      "Deprecated",
      "Removed",
      "Fixed",
      "Security",
    ]);
    expect(config.replacements ?? []).toEqual([]);
    expect(pkg.scripts.version).not.toContain("cut-changelog");
    expect(pkg.scripts.version).toContain("scripts/update-server-json-version.mjs");
  });

  it("preserves each archived release and pending entry from the pre-Changie changelog", () => {
    // Snapshot of CHANGELOG.md from the parent of the Changie migration, so the
    // comparison works in shallow checkouts and does not depend on Git history.
    const original = readFileSync(
      join(root, "tests/fixtures/release-standard/changelog-before-changie.md"),
      "utf8",
    );
    const headings = [...original.matchAll(/^## \[([\d.]+)\] - .+$/gm)];
    expect(headings).toHaveLength(6);
    const footers = original.search(/^\[Unreleased\]: /m);
    expect(footers).toBeGreaterThan(0);

    for (const [index, heading] of headings.entries()) {
      const version = heading[1];
      const end = headings[index + 1]?.index ?? footers;
      const expected = original.slice(heading.index, end).trimEnd();
      const archived = readFileSync(join(root, `.changes/v${version}.md`), "utf8")
        .replace(/\n\[[\d.]+\]: [^\n]+\s*$/, "")
        .trimEnd();
      expect(archived, `archived release v${version}`).toBe(expected);
    }

    const pending = changeEntries(
      original.slice(original.indexOf("## [Unreleased]"), headings[0].index),
    );
    expect(pending).toHaveLength(11);
    const fragmentDir = join(root, ".changes/unreleased");
    const fragments: ChangeEntry[] = readdirSync(fragmentDir)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => parse(readFileSync(join(fragmentDir, name), "utf8")) as ChangeEntry);
    const historical = new Set(headings.map((heading) => `v${heading[1]}.md`));
    const laterReleases = readdirSync(join(root, ".changes"))
      .filter((name) => /^v[\d.]+\.md$/.test(name) && !historical.has(name))
      .flatMap((name) => changeEntries(readFileSync(join(root, ".changes", name), "utf8")));
    for (const entry of pending) {
      expect(
        [...fragments, ...laterReleases].filter(
          (candidate) => candidate.kind === entry.kind && candidate.body === entry.body,
        ),
        `pending ${entry.kind} entry: ${entry.body.split("\n")[0]}`,
      ).toHaveLength(1);
    }
  });

  it("requires release milestones and preserves all fourteen gate items", () => {
    const release = readFileSync(join(root, "RELEASE.md"), "utf8");
    const contribution = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    const template = readFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
    const gate = release.split("## Release Gate")[1].split("## Package And Release")[0];

    expect(gate.match(/^\d+\./gm)).toHaveLength(14);
    expect(release).toContain("## Release Milestones");
    expect(release).toContain("release owner creates or selects an open `vX.Y.Z` milestone");
    expect(release).toContain(
      "Every release-bound issue and PR must carry that milestone before merge",
    );
    expect(release).toContain("Complete them or explicitly defer them to a later milestone");
    expect(release).toMatch(
      /After npm, GHCR, SBOM\/signature, GitHub Release, and directory verification\s+succeed, record the tag and evidence in the release issue, close the milestone/,
    );
    expect(contribution).toMatch(
      /Assign the PR and its linked issue to the intended release milestone/,
    );
    expect(template).toContain(
      "PR and linked issue are assigned to the intended release milestone",
    );
  });
});

describe("release tag signature gate", () => {
  it.each(["approved", "unapproved", "unsigned", "lightweight", "wrong-commit"])(
    "verifies the real %s tag before candidate code executes",
    (scenario) => {
      const steps = workflow.jobs.prepare.steps as Array<{
        name?: string;
        run?: string;
        uses?: string;
        env?: Record<string, unknown>;
        with?: Record<string, unknown>;
      }>;
      const signatureIndex = steps.findIndex(
        (step) => step.name === "Verify release tag signature",
      );
      expect(
        signatureIndex,
        "publish prepare must explicitly verify tag signatures",
      ).toBeGreaterThan(0);
      const signature = steps[signatureIndex];
      expect(signature.run).toContain("verify-tag");
      expect(signature.env).toMatchObject({
        PUBLISH_TAG: "${{ steps.request.outputs.tag }}",
        EXPECTED_RELEASE_SHA: "${{ steps.ref.outputs.checkout_sha }}",
      });
      const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts[0].with?.ref).toBe("refs/heads/ci-green");
      expect(checkouts[0].with?.["fetch-depth"]).toBe(0);
      expect(signatureIndex).toBeLessThan(steps.indexOf(checkouts[1]));

      const fixture = mkdtempSync(join(tmpdir(), "b2-mcp-tag-signature-"));
      const run = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { cwd: fixture, encoding: "utf8" });
        if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
        return result.stdout.trim();
      };
      try {
        run("git", ["init", "-b", "main"]);
        run("git", ["config", "user.email", "release@example.com"]);
        run("git", ["config", "user.name", "Release Test"]);
        run("git", ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "release"]);
        const sha = run("git", ["rev-parse", "HEAD"]);
        for (const name of ["approved", "unapproved"]) {
          run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(fixture, name)]);
        }
        mkdirSync(join(fixture, ".github"));
        writeFileSync(
          join(fixture, ".github/release-signers"),
          `release@example.com namespaces="git" ${readFileSync(join(fixture, "approved.pub"), "utf8")}`,
        );
        if (scenario === "unsigned")
          run("git", ["-c", "tag.gpgSign=false", "tag", "-a", "v0.2.3", "-m", "release"]);
        else if (scenario === "lightweight")
          run("git", ["-c", "tag.gpgSign=false", "tag", "v0.2.3"]);
        else
          run("git", [
            "-c",
            "gpg.format=ssh",
            "-c",
            `user.signingkey=${join(fixture, scenario === "unapproved" ? "unapproved" : "approved")}`,
            "tag",
            "-s",
            "v0.2.3",
            "-m",
            "release",
          ]);

        const result = spawnSync("bash", ["-c", signature.run as string], {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            PUBLISH_TAG: "v0.2.3",
            EXPECTED_RELEASE_SHA: scenario === "wrong-commit" ? "0".repeat(40) : sha,
          },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          scenario === "approved" ? 0 : 1,
        );
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
