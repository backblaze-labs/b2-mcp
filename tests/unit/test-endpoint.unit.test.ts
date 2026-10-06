import { B2AuthManager, createDefaultPartnerClient } from "../../src/auth";
import { validateB2ApiUrl } from "../../src/b2/client";
import {
  buildB2S3ClientConfig,
  expectedB2S3Endpoint,
  validateB2S3ApiUrl,
} from "../../src/s3/client";
import { isTestEndpointUrl, testEndpointOrigin } from "../../src/utils/test-endpoint";
import type { B2Config } from "../../src/utils/types";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { authorizeResponse } from "../support/sdk-test-helpers";

const REALM = "https://b2-fake.test:45123";

const config: B2Config = {
  applicationKeyId: "fixtureAlphaKeyId",
  applicationKey: "fixtureOmegaSecretValue",
  appKeyId: "fixtureAlphaKeyId",
  appKey: "fixtureOmegaSecretValue",
  masterKeyId: "fixtureAlphaKeyId",
  masterKey: "fixtureOmegaSecretValue",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

function openGate(realm = REALM): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("B2_TEST_REALM", realm);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
});

describe("test-only endpoint override gate", () => {
  it("is inert without B2_TEST_REALM", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("B2_TEST_REALM", "");
    expect(testEndpointOrigin()).toBeNull();
    expect(isTestEndpointUrl(`${REALM}/`)).toBe(false);
  });

  it.each(["production", "development", ""])("is inert when NODE_ENV is %j", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("B2_TEST_REALM", REALM);
    vi.stubEnv("VITEST_WORKER_ID", "1");
    expect(testEndpointOrigin()).toBeNull();
    expect(isTestEndpointUrl(`${REALM}/`)).toBe(false);
    expect(validateB2ApiUrl(`${REALM}/`)).not.toBeNull();
    expect(validateB2S3ApiUrl(`${REALM}/`, { mode: "authorized-region" })).not.toBeNull();
    expect(validateB2ApiUrl("https://b2-fake.test/")).toBe(
      "must match a trusted backblazeb2.com host",
    );
    expect(expectedB2S3Endpoint("us-west-004")).toBe("https://s3.us-west-004.backblazeb2.com");
  });

  it("sends authorize to production when the gate is closed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("B2_TEST_REALM", REALM);
    setB2SdkClientFactoryForTests(null);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(authorizeResponse(["listBuckets"])));
    // The test-hook factory is also disabled outside the test runtime, so the
    // default factory (and its realm option) is what runs here.
    await new B2AuthManager(config).getAuth().catch(() => undefined);
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).hostname).toBe("api.backblazeb2.com");
  });

  it("points the default SDK client at the exact realm when the gate is open", async () => {
    openGate();
    setB2SdkClientFactoryForTests(null);
    const body = authorizeResponse(["listBuckets"]);
    const storageApi = { ...body.apiInfo.storageApi };
    storageApi.apiUrl = storageApi.downloadUrl = storageApi.s3ApiUrl = REALM;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ...body, apiInfo: { storageApi } }));
    await new B2AuthManager(config).getAuth();
    const first = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(first.origin).toBe(REALM);
    expect(first.pathname).toMatch(/b2_authorize_account$/);
  });

  it("points the default Partner client at the realm only when the gate is open", async () => {
    const authorizeTarget = async (): Promise<string> => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ code: "unauthorized", status: 401 }, { status: 401 }));
      await createDefaultPartnerClient(config)
        .authorize()
        .catch(() => undefined);
      const target = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      fetchSpy.mockRestore();
      return target.origin;
    };
    openGate();
    expect(await authorizeTarget()).toBe(REALM);
    vi.stubEnv("NODE_ENV", "production");
    expect(await authorizeTarget()).toBe("https://api.backblazeb2.com");
  });

  it.each([
    ["http scheme", "http://b2-fake.test:45123"],
    ["userinfo", "https://user:pw@b2-fake.test:45123"],
    ["path", "https://b2-fake.test:45123/b2api"],
    ["query", "https://b2-fake.test:45123/?x=1"],
    ["fragment", "https://b2-fake.test:45123/#x"],
    ["IPv4 literal", "https://127.0.0.1:45123"],
    ["IPv6 literal", "https://[::1]:45123"],
    ["localhost", "https://localhost:45123"],
    ["a localhost subdomain", "https://api.localhost:45123"],
    ["a non-URL", "not a url"],
  ])("refuses a configured realm with %s", (_label, realm) => {
    openGate(realm);
    expect(() => testEndpointOrigin()).toThrow(/B2_TEST_REALM/);
  });

  it("accepts only the exact origin on the native and S3 validators", () => {
    openGate();
    expect(validateB2ApiUrl(`${REALM}/`)).toBeNull();
    expect(validateB2S3ApiUrl(`${REALM}/`, { mode: "authorized-region" })).toBeNull();
    expect(
      validateB2S3ApiUrl(`${REALM}/`, { mode: "exact-region", region: "us-west-004" }),
    ).toBeNull();

    for (const bad of [
      "https://b2-fake.test:45124/",
      "https://b2-fake.test/",
      "https://other.b2-fake.test:45123/",
      "https://evilb2-fake.test:45123/",
      "http://b2-fake.test:45123/",
      "https://user@b2-fake.test:45123/",
      "https://b2-fake.test:45123/path",
      "https://b2-fake.test:45123/?q=1",
      "https://b2-fake.test.evil.example:45123/",
      "https://127.0.0.1:45123/",
    ]) {
      expect(isTestEndpointUrl(bad), bad).toBe(false);
      expect(validateB2ApiUrl(bad), bad).not.toBeNull();
      expect(validateB2S3ApiUrl(bad, { mode: "authorized-region" }), bad).not.toBeNull();
    }
  });

  it("keeps trusting production hosts and still rejects hosts that only resemble them", () => {
    openGate();
    expect(validateB2ApiUrl("https://api005.backblazeb2.com")).toBeNull();
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com", { mode: "authorized-region" }),
    ).toBeNull();
    expect(validateB2ApiUrl("https://api.backblazeb2.com.evil.example")).not.toBeNull();
  });

  it("derives the S3 endpoint and region from the realm and B2_REGION", () => {
    openGate();
    expect(expectedB2S3Endpoint("us-west-004")).toBe(REALM);
    const built = buildB2S3ClientConfig(config, { authorizedS3ApiUrl: `${REALM}/` });
    expect(built.endpoint).toBe(REALM);
    expect(built.region).toBe("us-west-004");
  });

  it("still refuses an untrusted authorized S3 endpoint with the gate open", () => {
    openGate();
    expect(() =>
      buildB2S3ClientConfig(config, { authorizedS3ApiUrl: "https://s3.evil.example/" }),
    ).toThrow(/Authorized B2 S3 endpoint/);
  });
});
