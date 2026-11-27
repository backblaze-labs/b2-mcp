import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIMULATOR_DIR_ENV,
  resolveSimulatorServeScript,
} from "../../test-support/standalone-simulator";

/**
 * How simulator-backed tests find the standalone b2-simulator checkout. These
 * cases need no simulator: they pin that a missing or wrong checkout fails
 * loudly instead of turning into a skipped (falsely green) run.
 */
describe("standalone simulator discovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b2-mcp-sim-discovery-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the variable to set when it is unset or empty", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => resolveSimulatorServeScript({ [SIMULATOR_DIR_ENV]: value })).toThrow(
        /B2_SIMULATOR_DIR is not set.*backblaze-labs\/b2-simulator/s,
      );
    }
  });

  it("refuses a directory that does not exist", () => {
    const missing = join(dir, "nope");
    expect(() => resolveSimulatorServeScript({ [SIMULATOR_DIR_ENV]: missing })).toThrow(
      `B2_SIMULATOR_DIR=${missing} has no bin/simulator/serve.mjs`,
    );
  });

  it("refuses a directory that is not a b2-simulator checkout", () => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    expect(() => resolveSimulatorServeScript({ [SIMULATOR_DIR_ENV]: dir })).toThrow(
      `B2_SIMULATOR_DIR=${dir} has no bin/simulator/serve.mjs`,
    );
  });

  it("refuses a relative path, so the result does not depend on the working directory", () => {
    expect(() => resolveSimulatorServeScript({ [SIMULATOR_DIR_ENV]: "b2-simulator" })).toThrow(
      "B2_SIMULATOR_DIR must be an absolute path",
    );
  });

  it("returns the serve script and certificate of a checkout", () => {
    mkdirSync(join(dir, "bin", "simulator"), { recursive: true });
    writeFileSync(join(dir, "bin", "simulator", "serve.mjs"), "");
    writeFileSync(join(dir, "bin", "simulator", "loopback-cert.pem"), "");
    expect(resolveSimulatorServeScript({ [SIMULATOR_DIR_ENV]: dir })).toEqual({
      serveScript: join(dir, "bin", "simulator", "serve.mjs"),
      caCertPath: join(dir, "bin", "simulator", "loopback-cert.pem"),
    });
  });
});
