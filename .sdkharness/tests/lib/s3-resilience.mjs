// Shared plumbing for the `s3.*` resilience scenarios: the S3 requests the server itself sends (s3_get_object, s3_put_object), one documented
// fault armed AFTER the setup on the matching `s3:<Operation>` name, and the simulator's journal read back to see what happened.
// Run by ../run-resilience; see ../../README.md ("Resilience", the `s3.*` rows).
//
// Why these exist next to the native scenarios: the server has no native upload or download, so a fault on b2_upload_file or
// b2_download_file_by_id never reaches it; its data plane is S3. A presigned URL is not asked here, because the server only signs it.
import { armFault, armWire, journal } from "./fault.mjs";
import { b64, check, eq, payload, put, readBytes, runScenario, versionsOf } from "./session.mjs";

const SLACK_MS = 10; // as lib/resilience.mjs: rounding between a timer and Date.now, not a tolerance for an early retry
const KEY = "sdkharness/resilience/s3-object.bin";
const CALL_TIMEOUT_MS = 300_000; // the MCP client's own default (60 s) is shorter than the server's 150 s S3 deadline

const gets = (entries) => entries.filter((e) => e.endpoint === "s3:GetObject");
const puts = (entries) => entries.filter((e) => e.endpoint === "s3:PutObject");

export { armFault, armWire, check };

/**
 * A read under one fault. The server's S3 client retries a read, so the one call must succeed with the stored bytes, the journal must show
 * the injected answer followed by a 200 on the same operation, and `verify(entries, elapsedMs)` may add what the scenario names (a delay).
 */
export function readScenario(id, { arm, status, verify }) {
  return runScenario(
    id,
    async (s) => {
      s.step("setup: a bucket with one object");
      const bucket = await s.bucket();
      const data = payload(1500, 41);
      await put(s, bucket, KEY, data, { contentType: "application/octet-stream" });

      s.step("the read works before any fault");
      check((await readBytes(s, bucket, KEY)).bytes.equals(data), "the read before the fault returned other bytes");
      const mark = (await journal()).length;

      s.step("arm the fault");
      await arm();

      s.step("the read under the fault");
      const started = Date.now();
      let got;
      try {
        got = await readBytes(s, bucket, KEY);
      } catch (error) {
        throw new Error(`the read failed instead of recovering: ${error.message}`);
      }
      const elapsed = Date.now() - started;
      check(got.bytes.equals(data), "the bytes the read delivered are not the bytes stored");

      s.step("the recovery path in the simulator's journal");
      const entries = (await journal()).slice(mark);
      const faulted = gets(entries).filter((e) => e.fault === "injected");
      eq("injected faults on s3:GetObject", 1, faulted.length);
      eq("status of the injected fault on s3:GetObject", status, faulted[0].status);
      check(
        gets(entries).some((e) => e.seq > faulted[0].seq && e.status === 200),
        `no s3:GetObject answered 200 after the injected ${status}: the server did not retry the read`,
      );
      verify?.(entries, elapsed);
    },
    { level: "resilience" },
  );
}

/**
 * A write under one fault. B2's pages ask a client to retry a failed write, and a tool whose caller retries may instead hand the failure
 * to it, so the scenario asks what holds either way, from the caller's side and from the journal:
 *   - an OK is true: the object is stored and every stored version carries the bytes sent (never a partial or corrupt object);
 *   - a failure is loud: the error names the fault (`named`, a pattern over the error text; none for a dropped connection);
 *   - the stored versions are exactly the writes the simulator answered 200 (nothing is stored that the journal does not show, and a
 *     success the server reported has a 200 behind it);
 *   - after a failure that stored nothing (`mayHaveStored` false) there is no object at all;
 *   - the same write then succeeds and the newest version carries the bytes (a stuck circuit breaker or a poisoned client fails here).
 * `verify({ outcome, elapsed, entries })` may add what the scenario names (the stall ends before the stall does).
 */
export function writeScenario(id, { arm, named, mayHaveStored = false, verify }) {
  return runScenario(
    id,
    async (s) => {
      s.step("setup: a bucket and a first write that works");
      const bucket = await s.bucket();
      await put(s, bucket, "sdkharness/resilience/first.txt", payload(64, 7), { contentType: "text/plain" });
      const data = payload(2048, 91);
      const write = () =>
        s.call(
          "s3_put_object",
          { bucket: bucket.name, key: KEY, content: b64(data), contentType: "application/octet-stream" },
          { timeout: CALL_TIMEOUT_MS },
        );
      const mark = (await journal()).length;

      s.step("arm the fault");
      await arm();

      s.step("the write under the fault");
      const started = Date.now();
      let outcome = { ok: true };
      try {
        await write();
      } catch (error) {
        outcome = { ok: false, error: String(error.message).replace(/\s+/g, " ") };
      }
      const elapsed = Date.now() - started;

      s.step("what the caller was told, and what is stored");
      const afterFault = (await journal()).slice(mark);
      const stored = async () => (await versionsOf(s, bucket, KEY)).versions.filter((v) => v.Key === KEY);
      const intact = async (versions) => {
        for (const v of versions) {
          const got = await readBytes(s, bucket, KEY, { versionId: v.VersionId });
          check(got.bytes.equals(data), `version ${v.VersionId} of the object does not carry the bytes sent`);
        }
      };
      const first = await stored();
      const answered200 = puts(afterFault).filter((e) => e.status === 200).length;
      if (outcome.ok) {
        check(first.length >= 1, "the write was reported done, but no object is stored");
      } else {
        if (named) check(named.test(outcome.error), `the failure does not name the fault (${named}): ${outcome.error.slice(0, 160)}`);
        if (!mayHaveStored) eq("versions stored after a failed write", 0, first.length);
      }
      eq("versions stored, against the s3:PutObject the simulator answered 200", answered200, first.length);
      await intact(first);
      verify?.({ outcome, elapsed, entries: afterFault });

      s.step("the same write once the fault is gone");
      try {
        await write();
      } catch (error) {
        throw new Error(`the same write failed after the fault had cleared: ${error.message}`);
      }
      const all = await stored();
      check(all.length >= first.length + 1, "the repeated write stored no new version");
      const newest = await readBytes(s, bucket, KEY);
      check(newest.bytes.equals(data), "the newest version after the repeated write does not carry the bytes sent");
      await intact(all);
    },
    { level: "resilience" },
  );
}

export function atLeast(what, minimumMs, elapsedMs) {
  check(
    elapsedMs + SLACK_MS >= minimumMs,
    `${what}: the whole call took ${elapsedMs} ms, but a client must wait at least ${minimumMs} ms before it retries`,
  );
}
