// auth.clock_expiry (files.list). Run by ../run-resilience; see ../../README.md.
//
// One server session outlives its token: after the setup the simulator's clock moves 24 h and 1 ms past
// the token's life (an account authorization token is good for 24 h), so the simulator answers the next
// native call with a real 401. The Integration Checklist says the client then calls b2_authorize_account
// again; the journal must show a real 401 (no injected fault) on whichever native call came first (the
// listing resolves the bucket name before it lists, so it is usually b2_list_buckets), then
// b2_authorize_account, then the listing answering 200.
// https://www.backblaze.com/apidocs/b2-authorize-account
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
import {
  advanceClock,
  check,
  listingScenario,
  reauthorizedThenListed,
} from "../lib/resilience.mjs";

await listingScenario("auth.clock_expiry", {
  arm: () => advanceClock(86_400_001),
  verify(entries) {
    const expired = entries.find((e) => e.status === 401 && !e.fault);
    check(expired, "the simulator never answered a call with a real 401 after the clock moved");
    reauthorizedThenListed(entries, expired);
  },
});
