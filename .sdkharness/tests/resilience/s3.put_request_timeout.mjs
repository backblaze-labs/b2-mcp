// s3.put_request_timeout (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// PutObject answers 400 RequestTimeout once, S3's code for a request the server gave up waiting for (the S3 counterpart of the native 408
// request_timeout, which the Checklist lists as retryable). As s3.put_503: never lost silently, the failure names RequestTimeout, nothing is left
// behind, and the same write then lands.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
import { armFault, writeScenario } from "../lib/s3-resilience.mjs";

await writeScenario("s3.put_request_timeout", {
  arm: () => armFault({ on: "s3:PutObject", status: 400, code: "RequestTimeout" }),
  named: /RequestTimeout/,
});
