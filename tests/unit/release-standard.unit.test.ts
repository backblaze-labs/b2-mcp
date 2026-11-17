import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/publish.yml"), "utf8"));

describe("release preparation standard", () => {
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

  it("requires release milestones and preserves all fourteen gate items", () => {
    const release = readFileSync(join(root, "RELEASE.md"), "utf8");
    const contribution = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    const template = readFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
    const gate = release.split("## Release Gate")[1].split("## Package And Release")[0];

    expect(gate.match(/^\d+\./gm)).toHaveLength(14);
    expect(release).toContain("## Release Milestones");
    expect(release).toContain("open issues");
    expect(release).toContain("close the milestone");
    expect(contribution).toContain("milestone");
    expect(template).toContain("milestone");
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
