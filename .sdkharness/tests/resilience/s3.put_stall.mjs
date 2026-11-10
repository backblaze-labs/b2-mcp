// s3.put_stall (surface.s3:yes; needs a request timeout). Run by ../run-resilience; see ../../README.md.
//
// The PutObject request is held for 200 s, longer than the server's own 150 s deadline for an S3 data-plane call (CIRCUIT_TIMEOUT_MS in
// src/utils/circuit-breaker.ts). The Checklist lists "the HTTPS connection times out waiting for a response (socket timeout)" among the failures after
// which a client abandons the request and re-attempts the write. So the call must END before the stall does (the stalled request was abandoned, not
// waited out), report a failure, store nothing, and the same write must then land. No-client-option does not apply: the server has a deadline.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
import { armWire, check, writeScenario } from "../lib/s3-resilience.mjs";

const STALL_MS = 200_000;

await writeScenario("s3.put_stall", {
  arm: () => armWire({ on: "s3:PutObject", kind: "stall", ms: STALL_MS }),
  fired: { fault: "stall" },
  verify: ({ outcome, elapsed }) => {
    check(
      elapsed < STALL_MS - 10_000,
      `the call took ${elapsed} ms: the stalled request was waited out (a ${STALL_MS} ms stall), not abandoned`,
    );
    check(!outcome.ok, "the write was reported done although the request was held until abandoned");
  },
});
