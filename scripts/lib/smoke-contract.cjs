"use strict";

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approvedProfileNames(toolContract) {
  return Object.keys(toolContract.profiles).sort().join(", ");
}

function candidateProfiles(toolContract, expectedProfile, allowAnyProfile) {
  if (expectedProfile && toolContract.profiles[expectedProfile]) {
    return [[expectedProfile, toolContract.profiles[expectedProfile]]];
  }
  return allowAnyProfile ? Object.entries(toolContract.profiles) : [];
}

function toolContractSnapshot(tools, helpers) {
  const sortedTools = [...(tools ?? [])]
    .filter((tool) => tool?.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = sortedTools.map((tool) => tool.name);
  return {
    names,
    hash: helpers.fixtureHash({ names, tools: sortedTools.map(helpers.normalizeTool) }),
  };
}

function profileMatchDetail(snapshot, nameMatchedProfile, matchedProfile) {
  const actualHash = snapshot.hash.slice(0, 12);
  if (matchedProfile) {
    return `${matchedProfile[0]} (${snapshot.names.length} tools, hash ${actualHash})`;
  }
  if (nameMatchedProfile) {
    return `${nameMatchedProfile[0]} names matched but hash ${actualHash} != ${nameMatchedProfile[1].hash.slice(
      0,
      12,
    )}`;
  }
  return `unexpected tool set (${snapshot.names.length} tools, hash ${actualHash})`;
}

function evaluateProfileContract({
  snapshot,
  toolContract,
  expectedProfile = "",
  allowAnyProfile = false,
}) {
  const approved = approvedProfileNames(toolContract);
  const candidates = candidateProfiles(toolContract, expectedProfile, allowAnyProfile);
  const nameMatchedProfile = candidates.find(([, profile]) =>
    arraysEqual(snapshot.names, profile.names),
  );
  const matchedProfile = candidates.find(
    ([, profile]) => arraysEqual(snapshot.names, profile.names) && snapshot.hash === profile.hash,
  );

  return {
    matchedProfile,
    checks: [
      {
        name: "expected tool profile is configured",
        ok: Boolean(expectedProfile) || allowAnyProfile,
        detail: expectedProfile
          ? expectedProfile
          : `not pinned; set B2_MCP_EXPECTED_TOOL_PROFILE or B2_MCP_ALLOW_ANY_TOOL_PROFILE=true; approved: ${approved}`,
      },
      {
        name: "expected tool profile is approved",
        ok: !expectedProfile || Boolean(toolContract.profiles[expectedProfile]),
        detail: expectedProfile
          ? `${expectedProfile}; approved: ${approved}`
          : `not pinned; approved: ${approved}`,
      },
      {
        name: "tools/list matches expected frozen profile contract",
        ok: Boolean(matchedProfile),
        detail: profileMatchDetail(snapshot, nameMatchedProfile, matchedProfile),
      },
    ],
  };
}

module.exports = {
  arraysEqual,
  evaluateProfileContract,
  toolContractSnapshot,
};
