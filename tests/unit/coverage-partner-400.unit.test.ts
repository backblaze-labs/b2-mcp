import { mkdtempSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPartnerTools } from "../../src/b2/partner";
import type { B2Client } from "../../src/b2/client";
import type { B2AuthManager } from "../../src/auth";
import type { B2Config } from "../../src/utils/types";
import { setSinkWriteForTests } from "../../src/utils/secret-sink";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

function tempSecretFile(): string {
  return join(mkdtempSync(join(tmpdir(), "b2-mcp-partner-400-")), "secrets.jsonl");
}

// Fail only the ledger record write (the line carrying the secret), letting lock
// and index bookkeeping writes proceed so the post-create recovery path runs.
function failSecretLedgerWriteContaining(marker: string): () => void {
  const previous = setSinkWriteForTests((fd, buffer, offset, length) => {
    const text = Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString("utf8");
    if (text.includes(marker)) throw new Error("disk full");
    return writeSync(fd, buffer, offset, length);
  });
  return () => {
    setSinkWriteForTests(previous);
  };
}

function makeConfig(overrides: Partial<B2Config> = {}): B2Config {
  return {
    ...testConfig,
    masterKeyId: "master-key-id",
    masterKey: "master-key",
    destructivePolicy: "allow",
    secretSink: { mode: "inline" },
    ...overrides,
  } as B2Config;
}

// Loose override map: the tests stub these methods with partial response
// shapes on purpose (to drive specific normalization/error branches), so we do
// not constrain them to the exact B2Client signatures. makeClient re-casts the
// assembled object to B2Client.
type PartnerClientOverrides = Partial<
  Record<
    | "listGroups"
    | "listGroupMembers"
    | "ejectGroupMember"
    | "createGroupMember"
    | "reserveTrialCreateAccount",
    (...args: never[]) => unknown
  >
>;

function makeClient(overrides: PartnerClientOverrides = {}): B2Client {
  return {
    listGroups: vi.fn(async () => ({ groups: [] })),
    listGroupMembers: vi.fn(async () => ({ groupMembers: [] })),
    ejectGroupMember: vi.fn(async () => ({})),
    createGroupMember: vi.fn(async () => ({})),
    reserveTrialCreateAccount: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as B2Client;
}

function register(
  client: B2Client,
  config: B2Config,
  options: { registerDurableSecretSchemas?: boolean } = {},
) {
  const harness = new ToolHarness();
  registerPartnerTools(harness, client, {} as unknown as B2AuthManager, config, options);
  return harness;
}

const fullGroupMember = {
  accountId: "acc-1",
  email: "member@example.com",
  groupId: "g1",
  groupName: "Group One",
  region: "us-west",
  s3Endpoint: "https://s3.us-west.example",
};

const fullCreateEntry = {
  applicationKeyId: "key-id-1",
  applicationKey: "K005SecretApplicationKeyValue1234567890abc",
  groupMember: fullGroupMember,
};

describe("registerPartnerTools coverage (issue 400)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes optional groupName and startGroupId through to listGroups", async () => {
    const listGroups = vi.fn(async () => ({ groups: [] }));
    const harness = register(makeClient({ listGroups }), makeConfig());

    await harness.call("b2_list_groups", {
      adminAccountId: "admin-1",
      groupName: "team",
      startGroupId: 42,
      maxGroupCount: 10,
    });

    expect(listGroups).toHaveBeenCalledWith({
      adminAccountId: "admin-1",
      maxGroupCount: 10,
      groupName: "team",
      startGroupId: 42,
    });
  });

  it("omits optional groupName and startGroupId and defaults maxGroupCount", async () => {
    const listGroups = vi.fn(async () => ({ groups: [] }));
    const harness = register(makeClient({ listGroups }), makeConfig());

    await harness.call("b2_list_groups", { adminAccountId: "admin-1" });

    expect(listGroups).toHaveBeenCalledWith({ adminAccountId: "admin-1", maxGroupCount: 100 });
  });

  it("returns an error when listGroups fails", async () => {
    const listGroups = vi.fn(async () => {
      throw new Error("partner unavailable");
    });
    const harness = register(makeClient({ listGroups }), makeConfig());

    const raw = await harness.call("b2_list_groups", { adminAccountId: "admin-1" });

    expect(raw.isError).toBe(true);
  });

  it("creates a group member inline from an array response and forwards the region", async () => {
    const createGroupMember = vi.fn(async () => [fullCreateEntry]);
    const harness = register(makeClient({ createGroupMember }), makeConfig());

    const result = parseResult(
      await harness.call("b2_create_group_member", {
        adminAccountId: "admin-1",
        groupId: "g1",
        memberEmail: "member@example.com",
        region: "us-west",
        idempotencyKey: "idem-array",
      }),
    );

    expect(createGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({ region: "us-west", groupId: "g1" }),
    );
    expect(result.results[0].applicationKey).toBe(fullCreateEntry.applicationKey);
    expect(result.results[0].groupMember.accountId).toBe("acc-1");
  });

  it("creates a group member inline from a results-wrapped response with a null region", async () => {
    const createGroupMember = vi.fn(async () => ({ results: [fullCreateEntry] }));
    const harness = register(makeClient({ createGroupMember }), makeConfig());

    const result = parseResult(
      await harness.call("b2_create_group_member", {
        adminAccountId: "admin-1",
        groupId: "g1",
        memberEmail: "member@example.com",
        region: null,
        idempotencyKey: "idem-results",
      }),
    );

    // region null => normalizedPartnerRegion returns {}
    expect(createGroupMember).toHaveBeenCalledWith(
      expect.not.objectContaining({ region: expect.anything() }),
    );
    expect(result.results[0].groupMember.email).toBe("member@example.com");
  });

  it("creates a group member inline from a bare object response", async () => {
    const createGroupMember = vi.fn(async () => ({ ...fullCreateEntry }));
    const harness = register(makeClient({ createGroupMember }), makeConfig());

    const result = parseResult(
      await harness.call("b2_create_group_member", {
        adminAccountId: "admin-1",
        groupId: "g1",
        memberEmail: "member@example.com",
        idempotencyKey: "idem-bare",
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].applicationKeyId).toBe("key-id-1");
  });

  it("errors when the create-group-member response is missing groupMember fields", async () => {
    const createGroupMember = vi.fn(async () => ({
      applicationKeyId: "key-id-1",
      applicationKey: "secret",
      // groupMember missing => requiredStringValue throws unexpected_partner_response
    }));
    const harness = register(makeClient({ createGroupMember }), makeConfig());

    const raw = await harness.call("b2_create_group_member", {
      adminAccountId: "admin-1",
      groupId: "g1",
      memberEmail: "member@example.com",
      idempotencyKey: "idem-bad",
    });

    expect(raw.isError).toBe(true);
    expect(JSON.stringify(raw)).toContain("unexpected_partner_response");
  });

  it("blocks create_group_member under the block destructive policy", async () => {
    const createGroupMember = vi.fn(async () => [fullCreateEntry]);
    const harness = register(
      makeClient({ createGroupMember }),
      makeConfig({ destructivePolicy: "block" }),
    );

    const raw = await harness.call("b2_create_group_member", {
      adminAccountId: "admin-1",
      groupId: "g1",
      memberEmail: "member@example.com",
      idempotencyKey: "idem-blocked",
    });

    expect(raw.isError).toBe(true);
    expect(createGroupMember).not.toHaveBeenCalled();
  });

  it("ejects a member and forwards an optional new email", async () => {
    const ejectGroupMember = vi.fn(async () => ({ ejected: true }));
    const harness = register(makeClient({ ejectGroupMember }), makeConfig());

    await harness.call("b2_eject_group_member", {
      adminAccountId: "admin-1",
      groupId: "g1",
      memberAccountId: "acc-1",
      email: "renamed@example.com",
    });

    expect(ejectGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({ email: "renamed@example.com" }),
    );
  });

  it("reserves a trial account inline with all optional projection fields", async () => {
    const reserveTrialCreateAccount = vi.fn(async () => ({
      applicationKeyId: "trial-key-id",
      applicationKey: "K005TrialSecretApplicationKeyValue1234567",
      accountId: "trial-acc",
      s3Endpoint: "https://s3.trial.example",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      email: "trial@example.com",
      bucketName: "trial-bucket",
      bucketId: "bucket-1",
    }));
    const harness = register(makeClient({ reserveTrialCreateAccount }), makeConfig());

    const result = parseResult(
      await harness.call("b2_reserve_trial_create_account", {
        email: "trial@example.com",
        region: "eu-central",
        term: 7,
        storage: 1,
        idempotencyKey: "idem-trial",
      }),
    );

    expect(reserveTrialCreateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu-central" }),
    );
    expect(result.results[0].applicationKey).toBe("K005TrialSecretApplicationKeyValue1234567");
    expect(result.results[0].accountId).toBe("trial-acc");
    expect(result.results[0].bucketId).toBe("bucket-1");
  });

  it("reserves a trial account inline omitting absent optional fields", async () => {
    const reserveTrialCreateAccount = vi.fn(async () => ({
      applicationKeyId: "trial-key-id",
      applicationKey: "K005TrialSecretMinimal1234567890abcdefghi",
    }));
    const harness = register(makeClient({ reserveTrialCreateAccount }), makeConfig());

    const result = parseResult(
      await harness.call("b2_reserve_trial_create_account", {
        email: "trial@example.com",
        term: 7,
        storage: 1,
        idempotencyKey: "idem-trial-min",
      }),
    );

    expect(result.results[0]).not.toHaveProperty("accountId");
    expect(result.results[0].applicationKeyId).toBe("trial-key-id");
  });

  it("blocks reserve_trial_create_account under the block destructive policy", async () => {
    const reserveTrialCreateAccount = vi.fn(async () => ({}));
    const harness = register(
      makeClient({ reserveTrialCreateAccount }),
      makeConfig({ destructivePolicy: "block" }),
    );

    const raw = await harness.call("b2_reserve_trial_create_account", {
      email: "trial@example.com",
      term: 7,
      storage: 1,
      idempotencyKey: "idem-trial-blocked",
    });

    expect(raw.isError).toBe(true);
    expect(reserveTrialCreateAccount).not.toHaveBeenCalled();
  });

  it("redacts the reserve-trial application key when a file sink stores it", async () => {
    const reserveTrialCreateAccount = vi.fn(async () => ({
      applicationKeyId: "trial-key-id",
      applicationKey: "K005TrialSecretFileSink1234567890abcdefgh",
      accountId: "trial-acc",
    }));
    const harness = register(
      makeClient({ reserveTrialCreateAccount }),
      makeConfig({ secretSink: { mode: "file", filePath: tempSecretFile() } }),
      { registerDurableSecretSchemas: true },
    );

    const result = parseResult(
      await harness.call("b2_reserve_trial_create_account", {
        email: "trial@example.com",
        term: 7,
        storage: 1,
        idempotencyKey: "idem-trial-file",
      }),
    );

    expect(result.results[0].applicationKey).toBe("[redacted]");
    expect(result.secretSink).toMatchObject({ type: "file" });
  });

  it("recovers by ejecting confirmed members when the file sink write fails", async () => {
    const created = [fullCreateEntry];
    const listGroupMembers = vi.fn(async () => ({
      results: [
        { groupMembers: "not-an-array" },
        {
          groupMembers: [{ accountId: "acc-1", email: "member@example.com", groupId: "g1" }],
        },
      ],
    }));
    const ejectGroupMember = vi.fn(async () => ({ ejected: true }));
    const harness = register(
      makeClient({
        createGroupMember: vi.fn(async () => created),
        listGroupMembers,
        ejectGroupMember,
      }),
      makeConfig({ secretSink: { mode: "file", filePath: tempSecretFile() } }),
    );

    const restore = failSecretLedgerWriteContaining("SecretApplicationKeyValue");
    try {
      const raw = await harness.call("b2_create_group_member", {
        adminAccountId: "admin-1",
        groupId: "g1",
        memberEmail: "member@example.com",
        idempotencyKey: "idem-recover",
      });
      expect(raw.isError).toBe(true);
    } finally {
      restore();
    }

    expect(ejectGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({ memberAccountId: "acc-1" }),
    );
  });

  it("reports an eject failure message during file-sink failure recovery", async () => {
    const created = [fullCreateEntry];
    const listGroupMembers = vi.fn(async () => ({
      groupMembers: [{ accountId: "acc-1", email: "member@example.com", groupId: "g1" }],
    }));
    const ejectGroupMember = vi.fn(async () => {
      throw new Error("eject denied");
    });
    const harness = register(
      makeClient({
        createGroupMember: vi.fn(async () => created),
        listGroupMembers,
        ejectGroupMember,
      }),
      makeConfig({ secretSink: { mode: "file", filePath: tempSecretFile() } }),
    );

    const restore = failSecretLedgerWriteContaining("SecretApplicationKeyValue");
    try {
      const raw = await harness.call("b2_create_group_member", {
        adminAccountId: "admin-1",
        groupId: "g1",
        memberEmail: "member@example.com",
        idempotencyKey: "idem-recover-eject-fail",
      });
      expect(raw.isError).toBe(true);
    } finally {
      restore();
    }

    expect(ejectGroupMember).toHaveBeenCalledTimes(1);
  });
});
