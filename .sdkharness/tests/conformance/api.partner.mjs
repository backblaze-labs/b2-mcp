// api.partner (yes). Run by ../run-conformance; see ../../README.md.
//
// The Partner API tools against what B2 documents for Groups: the admin account lists its groups
// (paged, and by exact name), lists a group's members, creates a member account (which must be new:
// a taken email is refused with invalid_email), sees it listed, ejects it, and no longer sees it;
// an unknown group id is refused with invalid_group_id. Also reserve-trial account creation, in the
// one mode the server allows it (inline secret sink).
// https://www.backblaze.com/apidocs/b2-list-groups https://www.backblaze.com/apidocs/b2-list-group-members
// https://www.backblaze.com/apidocs/b2-create-group-member https://www.backblaze.com/apidocs/b2-eject-group-member
// https://www.backblaze.com/apidocs/b2-reserve-trial-create-account
//
// The card says the Partner tools need a master application key. The server registers them only
// when a master key distinct from the application key is configured, so this scenario gives its
// server the simulator's fixed fake master key (`sim-master-id` / `sim-master-secret`); the
// simulator serves the Partner API to that key with no special option. (The other way in,
// `--partner-groups-for-test-key`, lets the ordinary test key reach the same endpoints; it is not
// needed here.) The group member's key secret goes to a sink file of this scenario, as in keys.crud.
import { randomBytes } from "node:crypto";
import { callRaw, check, eq, runScenario, secretSink, startServer } from "../lib/session.mjs";

const sink = secretSink();
const MASTER = { B2_MASTER_KEY_ID: "sim-master-id", B2_MASTER_KEY: "sim-master-secret" };
const PARTNER_TOOLS = [
  "b2_list_groups",
  "b2_list_group_members",
  "b2_create_group_member",
  "b2_eject_group_member",
  "b2_reserve_trial_create_account",
];
// The server wraps a Partner answer in `result`/`results`, or answers an array of them.
const first = (answer) =>
  Array.isArray(answer) ? answer[0] : (answer.result?.[0] ?? answer.results?.[0] ?? answer);

await runScenario(
  "api.partner",
  async (s) => {
    s.cleanup(async () => sink.remove());
    const read = [];
    const raw = async (name, args) => {
      const out = await callRaw(s.client, name, args);
      read.push(out.text);
      return out.json;
    };

    s.step("the Partner tools are offered to a master key");
    const offered = new Set((await s.client.listTools()).tools.map((tool) => tool.name));
    for (const name of PARTNER_TOOLS) check(offered.has(name), `${name} is not offered`);

    s.step("list the admin account's groups");
    const adminAccountId = (await raw("b2_authorize_account", {})).accountId;
    const groups = await raw("b2_list_groups", { adminAccountId });
    eq("accountId of the group list", adminAccountId, groups.accountId);
    check(Array.isArray(groups.groups) && groups.groups.length > 0, "the account has no groups");
    for (const group of groups.groups) {
      check(
        typeof group.groupId === "string" && typeof group.groupName === "string",
        `a group lacks groupId or groupName: ${JSON.stringify(group).slice(0, 160)}`,
      );
    }
    const group = groups.groups[0];
    const byName = await raw("b2_list_groups", { adminAccountId, groupName: group.groupName });
    check(
      byName.groups.length > 0 && byName.groups.every((g) => g.groupName === group.groupName),
      "a groupName filter returned a group of another name",
    );
    const page = await raw("b2_list_groups", { adminAccountId, maxGroupCount: 1 });
    eq("maxGroupCount 1 returns one group", 1, page.groups.length);
    check(
      groups.groups.length === 1 ? page.nextGroupId === null : typeof page.nextGroupId === "string",
      `nextGroupId does not match ${groups.groups.length} groups: ${page.nextGroupId}`,
    );

    s.step("an unknown group id is refused");
    const unknown = await s.refused("b2_list_group_members", {
      adminAccountId,
      groupId: "sim_group_000000000000000000000000",
    });
    check(/invalid_group_id/.test(unknown), `an unknown group said: ${unknown.slice(0, 160)}`);

    s.step("create a member");
    const members = async () => {
      const answer = first(
        await raw("b2_list_group_members", { adminAccountId, groupId: group.groupId }),
      );
      return answer.groupMembers;
    };
    const email = `sdkharness-${randomBytes(5).toString("hex")}@example.com`;
    const before = (await members()).length;
    const created = first(
      await raw("b2_create_group_member", {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: email,
        idempotencyKey: `sdkharness-member-${email}`,
        confirm: true,
      }),
    );
    const member = created.groupMember;
    check(
      member?.accountId,
      `no groupMember in the create answer: ${JSON.stringify(created).slice(0, 200)}`,
    );
    eq("member email", email, member.email);
    eq("member groupId", group.groupId, member.groupId);
    s.cleanup(async () => {
      if ((await members()).some((m) => m.accountId === member.accountId)) {
        await s.call("b2_eject_group_member", {
          adminAccountId,
          groupId: group.groupId,
          memberAccountId: member.accountId,
          confirm: true,
        });
      }
    });

    s.step("the member's key secret went to the sink and not to the agent");
    const record = sink.records().find((r) => r.tool === "b2_create_group_member");
    const secret = record?.result?.applicationKey ?? record?.result?.results?.[0]?.applicationKey;
    check(
      typeof secret === "string" && secret.length >= 8,
      `the sink holds no secret for the new member (${JSON.stringify(record ?? null).slice(0, 200)})`,
    );
    check(!read.some((text) => text.includes(secret)), "the member's secret reached the agent");

    s.step("the member is listed, and its email cannot be taken again");
    const listed = (await members()).find((m) => m.accountId === member.accountId);
    check(listed, "the new member is not in b2_list_group_members");
    eq("listed member email", email, listed.email);
    eq("members after the create", before + 1, (await members()).length);
    const duplicate = await s.refused("b2_create_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberEmail: email,
      idempotencyKey: `sdkharness-member-again-${email}`,
      confirm: true,
    });
    check(/invalid_email/.test(duplicate), `a taken email said: ${duplicate.slice(0, 160)}`);

    s.step("eject the member");
    await raw("b2_eject_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberAccountId: member.accountId,
      confirm: true,
    });
    check(
      !(await members()).some((m) => m.accountId === member.accountId),
      "the ejected member is still listed",
    );
    const ejectAgain = await s.refused("b2_eject_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberAccountId: member.accountId,
      confirm: true,
    });
    check(
      /invalid_member_account_id/.test(ejectAgain),
      `ejecting twice said: ${ejectAgain.slice(0, 160)}`,
    );

    s.step("reserve-trial creation is unavailable with a file sink");
    const refused = await s.refused("b2_reserve_trial_create_account", {
      email: `sdkharness-trial-${randomBytes(4).toString("hex")}@example.com`,
      term: 7,
      storage: 1,
      idempotencyKey: `sdkharness-trial-file-${email}`,
      confirm: true,
    });
    check(/unavailable/.test(refused), `reserve-trial in file mode said: ${refused.slice(0, 160)}`);

    s.step("reserve-trial creates an account with the inline sink");
    const inline = await startServer("sdkharness-conformance-api.partner-inline", {
      ...MASTER,
      B2_SECRET_SINK: "inline",
    });
    try {
      const trialEmail = `sdkharness-trial-${randomBytes(4).toString("hex")}@example.com`;
      const trial = first(
        (
          await callRaw(inline, "b2_reserve_trial_create_account", {
            email: trialEmail,
            term: 7,
            storage: 1,
            idempotencyKey: `sdkharness-trial-${trialEmail}`,
            confirm: true,
          })
        ).json,
      );
      check(
        typeof trial.accountId === "string" && trial.accountId.length > 0,
        `the trial answer has no accountId: ${JSON.stringify(trial).slice(0, 200)}`,
      );
      eq("trial email", trialEmail, trial.email);
    } finally {
      await inline.close().catch(() => undefined);
    }
  },
  { env: { ...MASTER, ...sink.env } },
);
