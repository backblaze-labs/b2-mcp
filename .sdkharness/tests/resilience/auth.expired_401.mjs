// auth.expired_401 (files.list). Run by ../run-resilience; see ../../README.md.
//
// The listing's first call answers 401 expired_auth_token. B2's Integration Checklist says that on an
// expired token the client calls b2_authorize_account again and repeats the request. So the journal must
// show b2_authorize_account after the 401, and then the listing answering 200. A server that retries the
// same request with the same dead token until it happens to work has not done what the page asks, even
// when the listing finally succeeds: this check does not accept that, and it is not weakened for it.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/b2-list-file-names
import {
  armFault,
  injectedOnce,
  listingScenario,
  reauthorizedThenListed,
} from "../lib/resilience.mjs";

await listingScenario("auth.expired_401", {
  arm: () => armFault({ on: "b2_list_file_names", status: 401, code: "expired_auth_token" }),
  verify(entries) {
    reauthorizedThenListed(entries, injectedOnce(entries, 401));
  },
});
