// auth.expired_401 (files.list). Run by ../run-resilience; see ../../README.md.
//
// The listing's first call answers 401 bad_auth_token, the answer real B2 gives a token it rejects. B2's
// Integration Checklist says that on a rejected token the client calls b2_authorize_account again and
// repeats the request. So the journal must show b2_authorize_account after the 401, and then the listing
// answering 200.
//
// Why bad_auth_token and not expired_auth_token: real B2 never answers one expired_auth_token on a token
// that is still live. A token expires once, for good, so the realistic expiry case is a token that stays
// dead, and that is auth.clock_expiry (the simulator clock moves past the token's life). Measured against
// real B2 on 2026-10-12: a garbage, wrong, truncated, empty or missing token on b2_list_file_names is always
// 401 bad_auth_token, and the server re-authorizes at once (401, b2_authorize_account, 200). A real
// expired_auth_token cannot be produced before a token's 24 hours are up, so the Checklist is its only source.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
// https://www.backblaze.com/apidocs/b2-list-file-names
import {
  armFault,
  injectedOnce,
  listingScenario,
  reauthorizedThenListed,
} from "../lib/resilience.mjs";

await listingScenario("auth.expired_401", {
  arm: () => armFault({ on: "b2_list_file_names", status: 401, code: "bad_auth_token" }),
  verify(entries) {
    reauthorizedThenListed(entries, injectedOnce(entries, 401));
  },
});
