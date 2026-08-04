import { execFileSync } from "child_process";
import { root } from "../contract/support";

describe("compiled output", () => {
  it("rebuilds dist and exposes the compiled entry points", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });

    const output = execFileSync(
      "node",
      [
        "-e",
        [
          'const server = require("./dist/server.js");',
          'const index = require("./dist/index.js");',
          'if (typeof server.createServer !== "function") process.exit(2);',
          'if (typeof server.loadConfig !== "function") process.exit(3);',
          'if (typeof index.startStdio !== "function") process.exit(4);',
          'process.stdout.write("ok");',
        ].join(" "),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(output).toBe("ok");
  });
});
