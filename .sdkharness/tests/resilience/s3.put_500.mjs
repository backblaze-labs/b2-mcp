// s3.put_500 (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// As s3.put_503, with a 500 internal_error on PutObject. Asserted on the 500 status only, never its code (the Checklist's 500 row names none).
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
import { armFault, writeScenario } from "../lib/s3-resilience.mjs";

await writeScenario("s3.put_500", {
  arm: () => armFault({ on: "s3:PutObject", status: 500, code: "internal_error" }),
  fired: { fault: "injected", status: 500 },
  named: /\b500\b/,
});
