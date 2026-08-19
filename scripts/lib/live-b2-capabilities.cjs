"use strict";

const LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES = Object.freeze([
  "bypassGovernance",
  "deleteBuckets",
  "deleteFiles",
  "listBuckets",
  "listFiles",
  "listKeys",
  "readBucketEncryption",
  "readBucketRetentions",
  "readBuckets",
  "readFileLegalHolds",
  "readFileRetentions",
  "readFiles",
  "writeBucketEncryption",
  "writeBucketRetentions",
  "writeBuckets",
  "writeFileLegalHolds",
  "writeFileRetentions",
  "writeFiles",
]);

const LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES = Object.freeze(["deleteKeys", "writeKeys"]);

module.exports = {
  LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES,
  LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES,
};
