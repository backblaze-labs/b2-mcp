import { B2Client as SdkB2Client, BucketType } from "@backblaze-labs/b2-sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  startStandaloneSimulator,
  type StandaloneSimulator,
} from "../../test-support/standalone-simulator";

/**
 * The standalone-simulator harness itself: start and stop, the transport that
 * reaches it, per-test reset, per-file server isolation, and the control-plane
 * mappings that replace the SDK's in-process simulator methods.
 */

const retry = {
  maxRetries: 0,
  initialRetryDelayMs: 1,
  maxRetryDelayMs: 1,
  requestTimeoutMs: 10_000,
};

async function authorizedClient(
  sim: StandaloneSimulator,
  applicationKeyId = "test-key-id",
  applicationKey = "test-key-secret",
): Promise<SdkB2Client> {
  const client = new SdkB2Client({
    applicationKeyId,
    applicationKey,
    transport: sim.transport(),
    retry,
  });
  await client.authorize();
  return client;
}

async function bucketNames(client: SdkB2Client): Promise<string[]> {
  const buckets = await client.listBuckets();
  return buckets.map((bucket) => bucket.name).sort();
}

const HARNESS_MJS = join(__dirname, "../../test-support/standalone-simulator.mjs");

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("standalone simulator harness", () => {
  let sim: StandaloneSimulator;

  beforeAll(async () => {
    sim = await startStandaloneSimulator();
  });

  afterAll(async () => {
    await sim?.stop();
  });

  beforeEach(async () => {
    await sim.reset();
  });

  it("reports loopback HTTP, HTTPS and control origins", () => {
    expect(sim.httpOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sim.httpsOrigin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    expect(sim.controlOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("routes an SDK client on the default production realm to the simulator", async () => {
    const client = await authorizedClient(sim);
    await client.createBucket({ bucketName: "harness-routed", bucketType: BucketType.AllPrivate });
    expect(await bucketNames(client)).toEqual(["harness-routed"]);
    // The in-process simulator accepted any credential; the harness keeps that.
    const auth = client.accountInfo.getAuth();
    expect(auth?.accountId).toBe("sim_account_0001");
  });

  it("answers at the origin the client asked for, as the in-process simulator did", async () => {
    const client = await authorizedClient(sim);
    const storage = client.accountInfo.getAuth()?.apiInfo.storageApi;
    expect(storage?.apiUrl).toBe("https://api.backblazeb2.com");
    expect(storage?.downloadUrl).toBe("https://api.backblazeb2.com");
    expect(storage?.s3ApiUrl).toBe("https://api.backblazeb2.com");
    const bucket = await client.createBucket({
      bucketName: "harness-upload-url",
      bucketType: BucketType.AllPrivate,
    });
    const auth = client.accountInfo.getAuth();
    const upload = await client.raw.getUploadUrl(
      String(storage?.apiUrl),
      String(auth?.authorizationToken),
      { bucketId: bucket.id },
    );
    expect(new URL(upload.uploadUrl).origin).toBe("https://api.backblazeb2.com");
  });

  it("starts every test from an empty store after reset", async () => {
    const client = await authorizedClient(sim);
    await client.createBucket({
      bucketName: "harness-before-reset",
      bucketType: BucketType.AllPrivate,
    });
    await sim.reset();
    const fresh = await authorizedClient(sim);
    expect(await bucketNames(fresh)).toEqual([]);
  });

  it("applies reset config such as the reported part sizes", async () => {
    await sim.reset({ minimumPartSize: 1000, recommendedPartSize: 1000 });
    const client = await authorizedClient(sim);
    expect(client.accountInfo.getAuth()?.apiInfo.storageApi.absoluteMinimumPartSize).toBe(1000);
    await sim.reset({ minimumPartSize: 2000, recommendedPartSize: 3000 });
    const other = await authorizedClient(sim);
    expect(other.accountInfo.getAuth()?.apiInfo.storageApi.recommendedPartSize).toBe(3000);
  });

  it("does not share state between two servers (one per test file)", async () => {
    const second = await startStandaloneSimulator();
    try {
      const a = await authorizedClient(sim);
      const b = await authorizedClient(second);
      await a.createBucket({ bucketName: "harness-only-in-a", bucketType: BucketType.AllPrivate });
      expect(await bucketNames(b)).toEqual([]);
      expect(await bucketNames(a)).toEqual(["harness-only-in-a"]);
    } finally {
      await second.stop();
    }
  });

  it("injects a fault through the control plane and clears it", async () => {
    const client = await authorizedClient(sim);
    const fault = await sim.injectFailure({
      on: "b2_list_buckets",
      status: 503,
      code: "service_unavailable",
      message: "harness fault",
    });
    await expect(client.listBuckets()).rejects.toMatchObject({ status: 503 });
    await fault.clear();
    await expect(client.listBuckets()).resolves.toEqual([]);
  });

  it("fires a counted fault only that many times", async () => {
    const client = await authorizedClient(sim);
    await sim.injectFailure({
      on: "b2_list_buckets",
      status: 500,
      code: "internal_error",
      count: 1,
    });
    await expect(client.listBuckets()).rejects.toMatchObject({ status: 500 });
    await expect(client.listBuckets()).resolves.toEqual([]);
  });

  it("advances the simulator clock past a token's life", async () => {
    // Token expiry is enforced only under strict auth, with the simulator's fixed credential.
    await sim.reset({ strictAuth: true, authTokenTtlMs: 86_400_000 });
    const client = await authorizedClient(sim, "sim-test-id", "sim-test-secret");
    await sim.advanceTime(86_400_001);
    const raw = await sim.transport().send({
      method: "POST",
      url: `${client.accountInfo.getAuth()?.apiInfo.storageApi.apiUrl}/b2api/v4/b2_list_buckets`,
      headers: {
        Authorization: String(client.accountInfo.getAuth()?.authorizationToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId: client.accountInfo.getAuth()?.accountId }),
    });
    expect(raw.status).toBe(401);
  });

  it("stops the server process", async () => {
    const other = await startStandaloneSimulator();
    const pid = other.pid;
    expect(isRunning(pid)).toBe(true);
    await other.stop();
    expect(isRunning(pid)).toBe(false);
  });

  it("stops the server when the process that started it is killed", async () => {
    // An owner (like the protocol entrypoint) that starts a simulator, reports its pid, then hangs.
    const script = `import(${JSON.stringify(`file://${HARNESS_MJS}`)}).then(async (h) => {
      const sim = await h.startStandaloneSimulator();
      process.stdout.write(String(sim.pid) + "\\n");
      setInterval(() => {}, 1000);
    });`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = "";
      owner.stdout.on("data", (chunk) => {
        out += chunk.toString();
        const match = /^(\d+)\n/.exec(out);
        if (match) resolve(Number(match[1]));
      });
      owner.once("exit", (code) => reject(new Error(`owner exited early (${code})`)));
    });
    expect(isRunning(pid)).toBe(true);
    owner.kill("SIGKILL");
    expect(await waitUntil(() => !isRunning(pid), 5_000)).toBe(true);
  });

  it("fails with the discovery message when B2_SIMULATOR_DIR is missing", async () => {
    await expect(startStandaloneSimulator({ env: {} })).rejects.toThrow(
      /B2_SIMULATOR_DIR is not set/,
    );
  });

  it("fails with the server's output when it exits before listening", async () => {
    await expect(startStandaloneSimulator({ extraArgs: ["--no-such-flag"] })).rejects.toThrow(
      /simulator exited before listening.*no-such-flag/s,
    );
  });
});
