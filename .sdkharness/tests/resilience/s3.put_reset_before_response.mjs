// s3.put_reset_before_response (surface.s3:yes). Run by ../run-resilience; see ../../README.md.
//
// The PutObject is applied and the connection is reset before the answer: the caller cannot know the write landed. The Checklist lists a dropped
// connection among the failures after which a client re-attempts the write, and a second version of the same name is the accepted cost. So an OK
// needs the object stored; a failure may leave the one stored copy (it was applied); every stored version is intact; the same write then lands.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
import { armWire, writeScenario } from "../lib/s3-resilience.mjs";

await writeScenario("s3.put_reset_before_response", {
  arm: () => armWire({ on: "s3:PutObject", kind: "reset-before-response" }),
  fired: { fault: "reset-before-response" },
  mayHaveStored: true,
});
