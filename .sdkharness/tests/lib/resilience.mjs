// Shared plumbing for the sdkharness resilience scenarios: one object in a fresh bucket, the server's
// native listing (b2_list_largest_files, the only tool that calls b2_list_file_names), one documented
// fault armed AFTER the setup, and the simulator's journal read back to see which recovery path ran.
// Run by ../run-resilience; see ../../README.md.
import { advanceClock, armFault, journal } from "./fault.mjs";
import { call, check, eq, payload, put, runScenario } from "./session.mjs";

const KEY = "sdkharness/resilience/listing.txt";
const LIST = "b2_list_file_names";

// Timing is a lower bound only (the journal has no timestamps): the whole call took at least N ms. A busy
// machine makes an upper bound flaky, so none is asserted. 10 ms of slack covers the rounding between a
// timer and Date.now; it is not a tolerance for a client that retries early.
const SLACK_MS = 10;

const listing = (s, bucket) => s.call("b2_list_largest_files", { bucket: bucket.name, limit: 10 });

/**
 * Run one resilience scenario. `arm` injects the scenario's one fault; `verify(entries, elapsedMs)` reads
 * the journal entries made after the arming and throws if the recovery path is not the documented one.
 */
export function listingScenario(id, { arm, verify }) {
  return runScenario(
    id,
    async (s) => {
      s.step("setup: a bucket with one object");
      const bucket = await s.bucket();
      await put(s, bucket, KEY, payload(256, 71), { contentType: "text/plain" });

      s.step("the listing works before any fault");
      const before = await listing(s, bucket);
      check(
        before.files.some((f) => f.name === KEY),
        `the listing before the fault does not show ${KEY}`,
      );
      const mark = (await journal()).length;

      s.step("arm the fault");
      await arm();

      s.step("the listing call under the fault");
      const started = Date.now();
      let after;
      try {
        after = await listing(s, bucket);
      } catch (error) {
        throw new Error(`the listing failed instead of recovering: ${error.message}`);
      }
      const elapsed = Date.now() - started;

      s.step("the listing succeeded and shows the object");
      check(
        after.files.some((f) => f.name === KEY),
        `the listing after the fault does not show ${KEY}`,
      );

      s.step("the recovery path in the simulator's journal");
      verify((await journal()).slice(mark), elapsed);
    },
    { level: "resilience" },
  );
}

// ---- journal helpers ----------------------------------------------------------------------

const lists = (entries) => entries.filter((e) => e.endpoint === LIST);

/** The injected fault fired once on the listing, and a later listing answered 200. */
export function injectedOnce(entries, status) {
  const faulted = lists(entries).filter((e) => e.fault === "injected");
  eq(`injected faults on ${LIST}`, 1, faulted.length);
  eq(`status of the injected fault on ${LIST}`, status, faulted[0].status);
  const later = lists(entries).filter((e) => e.seq > faulted[0].seq && e.status === 200);
  check(later.length >= 1, `no ${LIST} answered 200 after the injected ${status}`);
  return faulted[0];
}

export function atLeast(what, minimumMs, elapsedMs) {
  check(
    elapsedMs + SLACK_MS >= minimumMs,
    `${what}: the whole call took ${elapsedMs} ms, but a client must wait at least ${minimumMs} ms before it retries`,
  );
}

/** After `first` (a journal entry), the client authorized again, and then a listing answered 200. */
export function reauthorizedThenListed(entries, first) {
  const authorized = entries.find(
    (e) => e.endpoint === "b2_authorize_account" && e.seq > first.seq,
  );
  check(
    authorized,
    `after the ${first.status} on ${first.endpoint} the client never called b2_authorize_account again`,
  );
  const listed = lists(entries).find((e) => e.seq > authorized.seq && e.status === 200);
  check(listed, `no ${LIST} answered 200 after the client authorized again`);
}

export { advanceClock, armFault, call, check };
