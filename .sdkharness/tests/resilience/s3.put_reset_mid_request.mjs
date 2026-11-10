// s3.put_reset_mid_request (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// The connection is reset while the PutObject request is still being sent. The Checklist lists a dropped connection among the failures after which
// a client re-attempts the write. As s3.put_503: never lost silently, a failure reaches the caller, no partial object is left (the request never
// completed, so nothing may be stored), and the same write then lands.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
import { armWire, writeScenario } from "../lib/s3-resilience.mjs";

await writeScenario("s3.put_reset_mid_request", {
  arm: () => armWire({ on: "s3:PutObject", kind: "reset-mid-request" }),
});
