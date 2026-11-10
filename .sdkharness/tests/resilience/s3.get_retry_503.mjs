// s3.get_retry_503 (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// s3_get_object's first GetObject answers 503 service_unavailable, the 5xx shape B2 documents for its S3-compatible API ("Codes in the 5xx range
// ... include JSON diagnostics"). B2's Integration Checklist asks a client to retry a 503, so the read is retried inside the one tool call and the
// bytes delivered are the bytes stored. The expected values come from the pages, not from what the server does.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
import { armFault, readScenario } from "../lib/s3-resilience.mjs";

await readScenario("s3.get_retry_503", {
  status: 503,
  arm: () => armFault({ on: "s3:GetObject", status: 503, code: "service_unavailable" }),
});
