// s3.get_retry_after_503 (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// The first GetObject answers 503 service_unavailable with `Retry-After: 2`. B2's Integration Checklist: when a response carries Retry-After, wait
// at least that long before the retry. Asserted as a lower bound on the whole call (the journal has no timestamps), then the read succeeds with the
// stored bytes.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
import { armFault, atLeast, readScenario } from "../lib/s3-resilience.mjs";

await readScenario("s3.get_retry_after_503", {
  status: 503,
  arm: () => armFault({ on: "s3:GetObject", status: 503, code: "service_unavailable", retryAfter: 2 }),
  verify: (_entries, elapsed) => atLeast("Retry-After: 2 on a 503", 2000, elapsed),
});
