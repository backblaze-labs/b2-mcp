import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(__filename);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b2-mutation-profile-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "mutation-scopes"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(targets: unknown, name = "http-oauth") {
  writeFileSync(
    join(root, `mutation-scopes/${name}.json`),
    JSON.stringify({ description: "Public request boundary", targets }),
  );
}

function profile(name = "http-oauth") {
  const { mutationProfileConfig } = nodeRequire("../../scripts/lib/mutation-profiles.cjs") as {
    mutationProfileConfig: (
      name: string,
      base: Record<string, unknown>,
      root: string,
    ) => Record<string, unknown>;
  };
  return mutationProfileConfig(
    name,
    { mutate: ["src/core.ts"], thresholds: { break: null }, ignoreStatic: true, timeoutMS: 60_000 },
    root,
  );
}

it("selects real named top-level implementations and keeps separate profile reports", () => {
  writeFileSync(
    join(root, "src/boundary.ts"),
    [
      '// function validateToken() { return "comment"; }',
      'const text = "function validateToken() {}";',
      "function outer() { function validateToken() { return false; } }",
      "export async function validateToken() {",
      "  return true;",
      "}",
      "export class Boundary {",
      "  accept() { return true; }",
      "}",
      "",
    ].join("\n"),
  );
  manifest([{ file: "src/boundary.ts", declarations: ["validateToken", "Boundary"] }]);
  expect(profile()).toMatchObject({
    mutate: ["src/boundary.ts:4-6", "src/boundary.ts:7-9"],
    thresholds: { break: null },
    ignoreStatic: true,
    timeoutMS: 60_000,
    jsonReporter: { fileName: "reports/mutation/http-oauth/mutation.json" },
    htmlReporter: { fileName: "reports/mutation/http-oauth/mutation.html" },
    tempDirName: ".stryker-tmp/http-oauth",
  });
});

it("resolves fresh line positions after unrelated source lines are inserted", () => {
  const file = join(root, "src/boundary.ts");
  writeFileSync(file, "export function accept() { return true; }\n");
  manifest([{ file: "src/boundary.ts", declarations: ["accept"] }]);
  expect(profile().mutate).toEqual(["src/boundary.ts:1-1"]);
  writeFileSync(file, "// unrelated change\n\nexport function accept() { return true; }\n");
  expect(profile().mutate).toEqual(["src/boundary.ts:3-3"]);
});

it("fails explicitly when a selected declaration disappears rather than widening coverage", () => {
  writeFileSync(join(root, "src/boundary.ts"), "export function renamed() {}\n");
  manifest([{ file: "src/boundary.ts", declarations: ["accept"] }]);
  expect(() => profile()).toThrow(/accept.*src\/boundary\.ts/);
});

it("selects an overload implementation rather than declaration signatures", () => {
  writeFileSync(
    join(root, "src/boundary.ts"),
    'export function accept(value: string): boolean;\nexport function accept(value: string) {\n  return value === "accepted";\n}\n',
  );
  manifest([{ file: "src/boundary.ts", declarations: ["accept"] }]);
  expect(profile().mutate).toEqual(["src/boundary.ts:2-4"]);
});

it.each([
  { targets: [{ file: "src/boundary.ts", declarations: [] }] },
  { targets: [{ file: "src/boundary.ts", declarations: ["accept", "accept"] }] },
  { targets: [{ file: "src/**/*.ts", declarations: ["accept"] }] },
  { targets: [{ file: "src/../boundary.ts", declarations: ["accept"] }] },
  { targets: [] },
])("rejects invalid or unbounded target manifests: %j", ({ targets }) => {
  writeFileSync(join(root, "src/boundary.ts"), "export function accept() {}\n");
  manifest(targets);
  expect(() => profile()).toThrow(/mutation profile/i);
});

it("rejects unknown profile names before reading a manifest", () => {
  expect(() => profile("../outside")).toThrow(/Unknown mutation profile/);
});

it.each(["jwks-cache", "ledger-lock"])(
  "isolates the %s failure-recovery profile from existing reports",
  (name) => {
    writeFileSync(join(root, "src/boundary.ts"), "export function recover() { return true; }\n");
    manifest([{ file: "src/boundary.ts", declarations: ["recover"] }], name);
    expect(profile(name)).toMatchObject({
      mutate: ["src/boundary.ts:1-1"],
      jsonReporter: { fileName: `reports/mutation/${name}/mutation.json` },
      htmlReporter: { fileName: `reports/mutation/${name}/mutation.html` },
      tempDirName: `.stryker-tmp/${name}`,
      thresholds: { break: null },
      ignoreStatic: true,
      timeoutMS: 60_000,
    });
  },
);
