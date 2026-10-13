// api.backoff_503 (files.list). Run by ../run-resilience; see ../../README.md.
//
// The listing's first call answers 503 service_unavailable. B2's Integration Checklist asks a client to
// retry a 503 with exponential backoff, starting at one second, so the retry comes no sooner than 1 s
// after it (asserted as a lower bound on the whole call: the journal has no timestamps), and then the
// listing succeeds. The expected values come from the page, not from what the server does.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/b2-list-file-names
import { armFault, atLeast, injectedOnce, listingScenario } from "../lib/resilience.mjs";

await listingScenario("api.backoff_503", {
  arm: () => armFault({ on: "b2_list_file_names", status: 503, code: "service_unavailable" }),
  verify(entries, elapsed) {
    injectedOnce(entries, 503);
    atLeast("backoff after a 503", 1000, elapsed);
  },
});
