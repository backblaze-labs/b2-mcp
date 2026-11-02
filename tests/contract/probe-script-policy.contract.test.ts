import { readFileSync } from "fs";
import { join } from "path";

const probeScript = readFileSync(join(__dirname, "../../scripts/probe-b2-500s.mjs"), "utf8");

// The probe runs the server with its default destructive policy, which refuses
// s3_abort_multipart_upload unless the call carries confirm: true. The probe
// ignores the cleanup result, so a refused abort leaves an unfinished upload in
// the customer bucket without any visible failure.
describe("probe-b2-500s destructive cleanup", () => {
  it("confirms its s3_abort_multipart_upload cleanup call", () => {
    const abortCalls = [
      ...probeScript.matchAll(/callTool\(\s*server,\s*"s3_abort_multipart_upload",\s*\{([^}]*)\}/g),
    ];

    expect(abortCalls.length).toBeGreaterThan(0);
    for (const call of abortCalls) {
      expect(call[1]).toMatch(/confirm:\s*true/);
    }
  });
});
