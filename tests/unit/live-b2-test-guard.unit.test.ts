import {
  LIVE_B2_REQUIRED_CREDENTIALS,
  LIVE_B2_REQUIRE_FLAG,
  assertLiveB2Runnable,
  hasLiveB2Credentials,
  liveB2GuardState,
  selectLiveB2Test,
} from "../support/live-b2-test-guard";
import credentialPolicy from "../../scripts/b2-credential-env.json";

function fakeTestApi() {
  const run = vi.fn();
  const skip = vi.fn();
  return {
    run,
    skip,
    testApi: Object.assign(run, { skip }),
  };
}

describe("live B2 test guard", () => {
  it("uses the shared live credential policy source", () => {
    expect(LIVE_B2_REQUIRED_CREDENTIALS).toEqual(credentialPolicy.liveRequired);
  });

  it("fails loudly instead of selecting skip when required live credentials are absent", () => {
    const { skip, testApi } = fakeTestApi();

    expect(() => selectLiveB2Test(testApi, { [LIVE_B2_REQUIRE_FLAG]: "1" })).toThrow(
      /B2_REQUIRE_LIVE_TESTS=1 requires live Backblaze B2 credentials/,
    );
    expect(skip).not.toHaveBeenCalled();
  });

  it("keeps local no-credential selection skipped when live tests are not required", () => {
    const { skip, testApi } = fakeTestApi();

    const selected = selectLiveB2Test(testApi, {});

    expect(selected).toBe(skip);
  });

  it("fails loudly when only part of the credential pair is present", () => {
    expect(() =>
      assertLiveB2Runnable({
        [LIVE_B2_REQUIRE_FLAG]: " true ",
        B2_APPLICATION_KEY_ID: "key-id",
      }),
    ).toThrow(/Missing: B2_APPLICATION_KEY/);
  });

  it("rejects unrecognized non-empty require flag values instead of skipping", () => {
    const { skip, testApi } = fakeTestApi();

    expect(() => selectLiveB2Test(testApi, { [LIVE_B2_REQUIRE_FLAG]: "required" })).toThrow(
      /B2_REQUIRE_LIVE_TESTS must be one of/,
    );
    expect(skip).not.toHaveBeenCalled();
  });

  it("recognizes a complete live credential pair", () => {
    const env = {
      B2_APPLICATION_KEY_ID: "key-id",
      B2_APPLICATION_KEY: "application-key",
    };

    expect(hasLiveB2Credentials(env)).toBe(true);
    expect(liveB2GuardState(env)).toMatchObject({
      hasCredentials: true,
      missingCredentials: [],
      requireLiveTests: false,
    });
  });
});
