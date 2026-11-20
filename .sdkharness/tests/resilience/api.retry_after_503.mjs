// api.retry_after_503 (files.list). Run by ../run-resilience; see ../../README.md.
//
// The listing's first call answers 503 with `Retry-After: 2`. B2's Integration Checklist asks a client to
// honour Retry-After, so the retry comes no sooner than 2 s after it (a lower bound on the whole call),
// and then the listing succeeds.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/b2-list-file-names
import { armFault, atLeast, injectedOnce, listingScenario } from "../lib/resilience.mjs";

await listingScenario("api.retry_after_503", {
  arm: () =>
    armFault({ on: "b2_list_file_names", status: 503, code: "service_unavailable", retryAfter: 2 }),
  verify(entries, elapsed) {
    injectedOnce(entries, 503);
    atLeast("Retry-After: 2 on a 503", 2000, elapsed);
  },
});
