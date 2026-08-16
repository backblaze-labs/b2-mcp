import credentialPolicy from "../../scripts/b2-credential-env.json";

type Env = Record<string, string | undefined>;

type TestCase = (name: string, fn: () => unknown | Promise<unknown>, timeout?: number) => unknown;

interface TestApi extends TestCase {
  skip: TestCase;
}

export const LIVE_B2_REQUIRED_CREDENTIALS = credentialPolicy.liveRequired;
export const LIVE_B2_REQUIRE_FLAG = "B2_REQUIRE_LIVE_TESTS";

const TRUE_FLAG_VALUES = new Set(["1", "true", "yes"]);
const FALSE_FLAG_VALUES = new Set(["0", "false", "no"]);

export interface LiveB2GuardState {
  readonly hasCredentials: boolean;
  readonly missingCredentials: string[];
  readonly requireLiveTests: boolean;
}

function parseRequireLiveTestsFlag(env: Env): boolean {
  const raw = env[LIVE_B2_REQUIRE_FLAG];
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (TRUE_FLAG_VALUES.has(normalized)) return true;
  if (FALSE_FLAG_VALUES.has(normalized)) return false;
  throw new Error(
    `${LIVE_B2_REQUIRE_FLAG} must be one of 1, true, yes, 0, false, or no; got ${JSON.stringify(
      raw,
    )}.`,
  );
}

export function liveB2GuardState(env: Env = process.env): LiveB2GuardState {
  const missingCredentials = LIVE_B2_REQUIRED_CREDENTIALS.filter((name) => !env[name]);
  return {
    hasCredentials: missingCredentials.length === 0,
    missingCredentials,
    requireLiveTests: parseRequireLiveTestsFlag(env),
  };
}

export function hasLiveB2Credentials(env: Env = process.env): boolean {
  return liveB2GuardState(env).hasCredentials;
}

export function assertLiveB2Runnable(env: Env = process.env): void {
  const state = liveB2GuardState(env);
  if (!state.requireLiveTests || state.hasCredentials) return;

  throw new Error(
    `${LIVE_B2_REQUIRE_FLAG}=1 requires live Backblaze B2 credentials. Missing: ${state.missingCredentials.join(
      ", ",
    )}. Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY before running the live B2 suites.`,
  );
}

export function selectLiveB2Test(testApi: TestApi, env: Env = process.env): TestCase {
  assertLiveB2Runnable(env);
  return hasLiveB2Credentials(env) ? testApi : testApi.skip;
}
