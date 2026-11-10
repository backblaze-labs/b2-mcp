// s3.put_503 (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// s3_put_object's PutObject answers 503 service_unavailable once. The server's writes use an S3 client that does not retry (src/s3/aws-sdk-adapter.ts,
// `maxAttempts: 1`): the failure goes to the caller, who retries. What B2's pages ask is that a failed write is never lost silently and that the
// client recovers: an OK means the object is stored intact, a failure names the 503 and leaves nothing behind, and the same write then lands.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
import { armFault, writeScenario } from "../lib/s3-resilience.mjs";

await writeScenario("s3.put_503", {
  arm: () => armFault({ on: "s3:PutObject", status: 503, code: "service_unavailable" }),
  named: /\b503\b/,
});
