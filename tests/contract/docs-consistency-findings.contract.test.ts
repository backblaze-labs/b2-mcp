/**
 * Docs and release-metadata consistency checks (cases C3, C4, C11, C12).
 * Each asserts the correct state of the documentation. Cases whose defect is still present
 * use `knownDefect` (see tests/support/known-defect.ts); the checks read repository files and
 * are skipped, not failed, when run outside a full checkout.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { knownDefect } from "../support/known-defect";
import { root } from "./support";

const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");

const fullCheckout = [
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "package.json",
  "docs/AUTHENTICATION.md",
  "src/credentials.ts",
].every((relativePath) => existsSync(join(root, relativePath)));

/** True when the tag exists in this checkout (shallow or tag-less clones do not have it). */
function hasGitTag(tag: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const releaseTagsAvailable = fullCheckout && hasGitTag("v0.2.1") && hasGitTag("v0.2.2");

describe.skipIf(!fullCheckout)(
  "Finding C3: README describes where B2_ALLOW_LOCAL_FILES and B2_FILE_ROOT apply",
  () => {
    knownDefect(
      "does not call B2_ALLOW_LOCAL_FILES / B2_FILE_ROOT HTTP-only (stdio reads both)",
      () => {
        const line = read("README.md")
          .split("\n")
          .find((l) => l.includes("B2_ALLOW_LOCAL_FILES") && l.includes("B2_FILE_ROOT"));
        expect(line, "README mentions both variables").toBeDefined();
        expect(line, "README line describing the local-file variables").not.toMatch(/HTTP-only/i);
      },
    );

    it("the stdio credential reader does consume both variables (guard for the claim above)", () => {
      const source = read("src/credentials.ts");
      expect(source, "credentials.ts reads B2_ALLOW_LOCAL_FILES").toContain(
        "process.env.B2_ALLOW_LOCAL_FILES",
      );
      expect(source, "credentials.ts reads B2_FILE_ROOT").toContain("process.env.B2_FILE_ROOT");
    });
  },
);

describe.skipIf(!fullCheckout)(
  "Finding C4: SECURITY.md supported-versions text matches the released package",
  () => {
    knownDefect("does not describe the package as not yet published", () => {
      const security = read("SECURITY.md");
      const section = security.slice(
        security.indexOf("## Supported Versions"),
        security.indexOf("## Reporting a Vulnerability"),
      );
      expect(section.length, "Supported Versions section found").toBeGreaterThan(0);
      expect(section, "SECURITY.md supported-versions text").not.toMatch(
        /no supported installable npm version/i,
      );
      expect(section, "SECURITY.md supported-versions text").not.toMatch(/Before that publish/i);
    });
  },
);

describe("Finding C11: CHANGELOG [0.2.2] claims about held-back dependency bumps are true", () => {
  // Compares the v0.2.1 and v0.2.2 release tags, so later bumps on the default branch do not
  // affect the result. Skipped (shown as skipped, never failed) when either tag is not in the
  // checkout: a default shallow CI checkout has no tags, so this case only runs where the
  // tags are fetched (`fetch-depth: 0` or `fetch-tags: true`) or locally.
  (releaseTagsAvailable ? knownDefect : knownDefect.skip)(
    "packages the changelog says were held back are unchanged between v0.2.1 and v0.2.2",
    () => {
      type Manifest = {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const manifestAt = (tag: string): Manifest =>
        JSON.parse(
          execFileSync("git", ["show", `${tag}:package.json`], { cwd: root, encoding: "utf8" }),
        );
      const previous = manifestAt("v0.2.1");
      const released = manifestAt("v0.2.2");
      const section = read("CHANGELOG.md").split("## [0.2.1]")[0].split("## [0.2.2]")[1] ?? "";
      expect(section, "CHANGELOG has a [0.2.2] section").toMatch(/held back/i);

      const heldBack = [
        "eslint",
        "@aws-sdk/client-s3",
        "@aws-sdk/s3-request-presigner",
        "@smithy/types",
        "zod",
        "@modelcontextprotocol/client",
      ];
      const versionOf = (pkg: Manifest, name: string) =>
        pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      const changed = heldBack.filter(
        (name) => versionOf(previous, name) !== versionOf(released, name),
      );
      expect(changed, "held-back packages whose version changed").toEqual([]);
    },
  );
});

describe.skipIf(!fullCheckout)(
  "Finding C12: README pointers into docs/AUTHENTICATION.md resolve to real content",
  () => {
    knownDefect(
      "AUTHENTICATION.md covers what README says it covers: destructive gate, secret sinks, idempotency keys, POSIX vs Windows",
      () => {
        const readme = read("README.md");
        expect(readme, "README pointer text").toMatch(
          /destructive-gate policy and durable-secret handling/,
        );
        expect(readme, "README pointer text").toMatch(
          /\(secret sinks, idempotency keys, POSIX vs\. Windows behavior\)/,
        );
        const auth = read("docs/AUTHENTICATION.md");
        for (const topic of [
          /destructive/i,
          /secret sink/i,
          /idempotency/i,
          /POSIX/i,
          /Windows/i,
        ]) {
          expect(auth, `AUTHENTICATION.md should cover ${topic}`).toMatch(topic);
        }
      },
    );
  },
);
