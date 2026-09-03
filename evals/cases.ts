import { isDeepStrictEqual } from "node:util";
import toolProfileContract from "../docs/generated/tool-profile-contract.json";
import type { Driver, EvalRun, EvalServerOptions, EvalTimeouts, RunEvalOptions } from "./harness";

export type EvalCaseCategory =
  | "native-control-plane"
  | "partner-groups"
  | "custom-analytics"
  | "s3-data-plane";

export type ExpectedEvalResult =
  | {
      readonly kind: "mcp-error";
      readonly textIncludes: readonly [string, ...string[]];
    }
  | {
      readonly kind: "structured-json";
      readonly structuredFields?: Readonly<Record<string, unknown>>;
      readonly textIncludes?: readonly string[];
    };

export interface ExpectedToolEval {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requiredArgs: readonly string[];
  readonly allowedExtraArgs?: readonly string[];
  readonly result: ExpectedEvalResult;
}

export interface NormalizedExpectedToolCall {
  readonly name: string | null;
  readonly assertedArgs: Readonly<Record<string, unknown>>;
  readonly requiredArgsPresent: Readonly<Record<string, boolean>>;
  readonly unexpectedArgs: readonly string[];
  readonly matchesExpected: boolean;
}

export type NormalizedExpectedToolResult =
  | {
      readonly kind: "mcp-error";
      readonly isError: boolean;
      readonly code: string | null;
      readonly status: number | null;
      readonly textIncludes: readonly boolean[];
      readonly matchesExpected: boolean;
    }
  | {
      readonly kind: "structured-json";
      readonly isError: boolean;
      readonly structuredFields: Readonly<Record<string, unknown>>;
      readonly textIncludes: readonly boolean[];
      readonly matchesExpected: boolean;
    };

export interface NormalizedExpectedToolOutcome {
  readonly toolCalls: readonly NormalizedExpectedToolCall[];
  readonly toolResults: readonly NormalizedExpectedToolResult[];
}

export interface EvalCase {
  readonly name: string;
  readonly category: EvalCaseCategory;
  readonly prompt: string;
  readonly toolNames: readonly string[];
  readonly expected: ExpectedToolEval;
  readonly maxSteps: number;
  readonly maxToolCallsPerStep?: number;
  readonly maxToolCallsTotal?: number;
  readonly server?: EvalServerOptions;
  readonly timeouts?: EvalTimeouts;
  passed(run: EvalRun): boolean;
  failureSummary(run: EvalRun): string;
}

interface ToolProfileContract {
  readonly profiles: {
    readonly full: {
      readonly requiredFields: Record<string, string[]>;
    };
  };
}

const fullRequiredFields = (toolProfileContract as ToolProfileContract).profiles.full
  .requiredFields;

const destructiveEvalServer = {
  destructivePolicy: "allow",
} as const satisfies EvalServerOptions;

const defaultTimeouts = { driverStepMs: 60_000, toolCallMs: 20_000 } as const;

export function evalCaseRunOptions(evalCase: EvalCase, driver: Driver): RunEvalOptions {
  return {
    prompt: evalCase.prompt,
    toolNames: [...evalCase.toolNames],
    driver,
    maxSteps: evalCase.maxSteps,
    maxToolCallsPerStep: evalCase.maxToolCallsPerStep,
    maxToolCallsTotal: evalCase.maxToolCallsTotal,
    server: evalCase.server,
    timeouts: evalCase.timeouts,
  };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function destructiveDeleteBucketGatePassed(run: EvalRun): boolean {
  const call = run.toolCalls[0];
  const result = run.toolResults[0];
  return (
    run.toolCalls.length === 1 &&
    call?.name === "b2_delete_bucket" &&
    call.args.bucketId === "eval-bucket-id" &&
    call.args.confirm === true &&
    result?.isError === true &&
    stringify(result).includes("destructive_policy_blocked") &&
    /blocked|refused|destructive|policy/i.test(run.text)
  );
}

export function destructiveDeleteBucketGateFailure(run: EvalRun): string {
  return (
    "expected one blocked b2_delete_bucket call for eval-bucket-id; " +
    `toolCalls=${stringify(run.toolCalls)} text=${JSON.stringify(run.text)}`
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function textContent(result: EvalRun["toolResults"][number] | undefined): string {
  return (
    result?.content
      ?.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("\n") ?? ""
  );
}

function structuredObject(
  result: EvalRun["toolResults"][number] | undefined,
): Record<string, unknown> {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return {};
  return structured as Record<string, unknown>;
}

function normalizedStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function errorMetadata(result: EvalRun["toolResults"][number]): {
  code: string | null;
  status: number | null;
} {
  const structured = structuredObject(result);
  const text = textContent(result);
  const code =
    typeof structured.code === "string"
      ? structured.code
      : (/\bB2 Error \[([^\]]+)]/.exec(text)?.[1] ?? null);
  const structuredStatus =
    normalizedStatus(structured.status) ??
    normalizedStatus(structured.httpStatus) ??
    normalizedStatus(structured.statusCode);
  const status = structuredStatus ?? /\bHTTP\s+(\d{3})\b/.exec(text)?.[1] ?? null;
  return {
    code,
    status: typeof status === "string" ? Number(status) : status,
  };
}

function normalizeToolCall(
  call: EvalRun["toolCalls"][number],
  expected: ExpectedToolEval,
): NormalizedExpectedToolCall {
  const requiredArgsPresent = Object.fromEntries(
    [...expected.requiredArgs].sort().map((name) => [name, name in call.args]),
  );
  const assertedArgs = Object.fromEntries(
    Object.keys(expected.args)
      .sort()
      .map((name) => [name, call.args[name]]),
  );
  const allowedArgNames = new Set([
    ...Object.keys(expected.args),
    ...(expected.allowedExtraArgs ?? []),
  ]);
  const unexpectedArgs = Object.keys(call.args)
    .filter((name) => !allowedArgNames.has(name))
    .sort();
  const expectedArgsMatch = Object.entries(expected.args).every(([key, value]) =>
    sameValue(call.args[key], value),
  );
  return {
    name: call.name,
    assertedArgs,
    requiredArgsPresent,
    unexpectedArgs,
    matchesExpected:
      call.name === expected.toolName &&
      Object.values(requiredArgsPresent).every(Boolean) &&
      unexpectedArgs.length === 0 &&
      expectedArgsMatch,
  };
}

function normalizeToolResult(
  result: EvalRun["toolResults"][number],
  expected: ExpectedEvalResult,
): NormalizedExpectedToolResult {
  const text = textContent(result);
  if (expected.kind === "mcp-error") {
    const metadata = errorMetadata(result);
    const textIncludes = expected.textIncludes.map((snippet) => text.includes(snippet));
    return {
      kind: "mcp-error",
      isError: result.isError === true,
      code: metadata.code,
      status: metadata.status,
      textIncludes,
      matchesExpected: result.isError === true && text.length > 0 && textIncludes.every(Boolean),
    };
  }

  const object = structuredObject(result);
  const structuredFields = Object.fromEntries(
    Object.keys(expected.structuredFields ?? {})
      .sort()
      .map((field) => [field, object[field]]),
  );
  const fieldsMatch = Object.entries(expected.structuredFields ?? {}).every(([key, value]) =>
    sameValue(object[key], value),
  );
  const textIncludes = (expected.textIncludes ?? []).map((snippet) => text.includes(snippet));
  return {
    kind: "structured-json",
    isError: result.isError === true,
    structuredFields,
    textIncludes,
    matchesExpected: result.isError !== true && fieldsMatch && textIncludes.every(Boolean),
  };
}

export function normalizeExpectedToolOutcome(
  run: EvalRun,
  expected: ExpectedToolEval,
): NormalizedExpectedToolOutcome {
  return {
    toolCalls: run.toolCalls.map((call) => normalizeToolCall(call, expected)),
    toolResults: run.toolResults.map((result) => normalizeToolResult(result, expected.result)),
  };
}

function toolCasePassed(run: EvalRun, expected: ExpectedToolEval): boolean {
  const normalized = normalizeExpectedToolOutcome(run, expected);
  return (
    normalized.toolCalls.length === 1 &&
    normalized.toolCalls[0]?.matchesExpected === true &&
    normalized.toolResults.length === 1 &&
    normalized.toolResults[0]?.matchesExpected === true
  );
}

function toolCaseFailure(run: EvalRun, expected: ExpectedToolEval): string {
  return (
    `expected one ${expected.toolName} call with args ${stringify(expected.args)} ` +
    `and ${expected.result.kind} result; ` +
    `toolCalls=${stringify(run.toolCalls)} toolResults=${stringify(run.toolResults)} ` +
    `text=${JSON.stringify(run.text)}`
  );
}

function promptFor(toolName: string, args: Readonly<Record<string, unknown>>, request: string) {
  return (
    `${request}\n\n` +
    `Call ${toolName} exactly once with these arguments: ${JSON.stringify(args)}. ` +
    "Do not call any other tool."
  );
}

function evalToolCase(input: {
  readonly name: string;
  readonly category: EvalCaseCategory;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly request: string;
  readonly result: ExpectedEvalResult;
  readonly server?: EvalServerOptions;
  readonly timeouts?: EvalTimeouts;
}): EvalCase {
  const expected = {
    toolName: input.toolName,
    args: input.args,
    requiredArgs: fullRequiredFields[input.toolName] ?? [],
    result: input.result,
  } satisfies ExpectedToolEval;
  return {
    name: input.name,
    category: input.category,
    prompt: promptFor(input.toolName, input.args, input.request),
    toolNames: [input.toolName],
    expected,
    maxSteps: 2,
    maxToolCallsPerStep: 1,
    maxToolCallsTotal: 1,
    server: input.server,
    timeouts: input.timeouts ?? defaultTimeouts,
    passed: (run) => toolCasePassed(run, expected),
    failureSummary: (run) => toolCaseFailure(run, expected),
  };
}

const b2BadAuthTokenError = {
  kind: "mcp-error",
  textIncludes: ["B2 Error [bad_auth_token]", "HTTP 401"],
} as const satisfies ExpectedEvalResult;
const s3InvalidAccessKeyError = {
  kind: "mcp-error",
  textIncludes: ["B2 Error [InvalidAccessKeyId]", "HTTP 403", "Malformed Access Key Id"],
} as const satisfies ExpectedEvalResult;
const s3UnknownForbiddenError = {
  kind: "mcp-error",
  textIncludes: ["B2 Error [Unknown]", "HTTP 403", "UnknownError"],
} as const satisfies ExpectedEvalResult;
const unavailableStubError = {
  kind: "mcp-error",
  textIncludes: ["B2 Error [tool_unavailable]", "HTTP 410", "out-of-band secret sink"],
} as const satisfies ExpectedEvalResult;
const destructivePolicyBlockedError = {
  kind: "mcp-error",
  textIncludes: ["destructive_policy_blocked"],
} as const satisfies ExpectedEvalResult;

export const NATIVE_CONTROL_PLANE_EVAL_CASES: readonly EvalCase[] = [
  evalToolCase({
    name: "authorize account with marker credentials",
    category: "native-control-plane",
    toolName: "b2_authorize_account",
    args: {},
    request: "Verify the configured Backblaze B2 account authorization.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "create private bucket",
    category: "native-control-plane",
    toolName: "b2_create_bucket",
    args: { bucketName: "eval-private-bucket", bucketType: "allPrivate" },
    request: "Create a private Backblaze B2 bucket for an evaluation fixture.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "delete bucket with allow policy",
    category: "native-control-plane",
    toolName: "b2_delete_bucket",
    args: { bucketId: "eval-bucket-id", confirm: true },
    request: "Delete the Backblaze B2 bucket identified by eval-bucket-id.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "get bucket notification rules",
    category: "native-control-plane",
    toolName: "b2_get_bucket_notification_rules",
    args: { bucketId: "eval-bucket-id" },
    request: "Read the event notification rules for a Backblaze B2 bucket.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "list buckets",
    category: "native-control-plane",
    toolName: "b2_list_buckets",
    args: {},
    request: "List Backblaze B2 buckets available to the configured key.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "set empty bucket notification rules",
    category: "native-control-plane",
    toolName: "b2_set_bucket_notification_rules",
    args: { bucketId: "eval-bucket-id", eventNotificationRules: [], confirm: true },
    request: "Replace a bucket's event notification rules with an empty rule set.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "make bucket public update",
    category: "native-control-plane",
    toolName: "b2_update_bucket",
    args: { bucketId: "eval-bucket-id", bucketType: "allPublic", confirm: true },
    request: "Update a Backblaze B2 bucket so its type is allPublic.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "clear file legal hold",
    category: "native-control-plane",
    toolName: "b2_update_file_legal_hold",
    args: {
      fileId: "eval-file-id",
      fileName: "legal-hold.txt",
      legalHold: "off",
      confirm: true,
    },
    request: "Clear the legal hold on a Backblaze B2 file version.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "clear file retention",
    category: "native-control-plane",
    toolName: "b2_update_file_retention",
    args: {
      fileId: "eval-file-id",
      fileName: "retention.txt",
      fileRetention: { mode: null, retainUntilTimestamp: null },
      bypassGovernance: true,
      confirm: true,
    },
    request: "Clear Object Lock retention from a Backblaze B2 file version.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "create application key compatibility stub",
    category: "native-control-plane",
    toolName: "b2_create_key",
    args: { confirm: true },
    request: "Create a Backblaze B2 application key if the server exposes that operation.",
    result: unavailableStubError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "delete application key",
    category: "native-control-plane",
    toolName: "b2_delete_key",
    args: { applicationKeyId: "eval-application-key-to-delete", confirm: true },
    request: "Delete a Backblaze B2 application key.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "list application keys",
    category: "native-control-plane",
    toolName: "b2_list_keys",
    args: {},
    request: "List Backblaze B2 application keys for the configured account.",
    result: b2BadAuthTokenError,
  }),
];

export const PARTNER_GROUPS_EVAL_CASES: readonly EvalCase[] = [
  evalToolCase({
    name: "create group member compatibility stub",
    category: "partner-groups",
    toolName: "b2_create_group_member",
    args: { confirm: true },
    request: "Create a new Backblaze Partner group member account if available.",
    result: unavailableStubError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "eject group member",
    category: "partner-groups",
    toolName: "b2_eject_group_member",
    args: {
      adminAccountId: "eval-admin-account-id",
      groupId: "eval-group-id",
      memberAccountId: "eval-member-account-id",
      confirm: true,
    },
    request: "Eject a member from a Backblaze Partner group.",
    result: b2BadAuthTokenError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "list group members",
    category: "partner-groups",
    toolName: "b2_list_group_members",
    args: { adminAccountId: "eval-admin-account-id", groupId: "eval-group-id" },
    request: "List active members for a Backblaze Partner group.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "list groups",
    category: "partner-groups",
    toolName: "b2_list_groups",
    args: { adminAccountId: "eval-admin-account-id" },
    request: "List Backblaze Partner groups for an admin account.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "reserve trial account compatibility stub",
    category: "partner-groups",
    toolName: "b2_reserve_trial_create_account",
    args: { confirm: true },
    request: "Reserve a Backblaze B2 trial account if the server exposes that operation.",
    result: unavailableStubError,
    server: destructiveEvalServer,
  }),
];

export const CUSTOM_ANALYTICS_EVAL_CASES: readonly EvalCase[] = [
  evalToolCase({
    name: "usage growth analytics",
    category: "custom-analytics",
    toolName: "b2_report_usage_growth",
    args: {},
    request: "Analyze Backblaze B2 storage usage growth from usage reports.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "egress leaders analytics",
    category: "custom-analytics",
    toolName: "b2_rank_egress_leaders",
    args: {},
    request: "Find the Backblaze B2 accounts or buckets with the highest egress.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "largest files analytics",
    category: "custom-analytics",
    toolName: "b2_list_largest_files",
    args: { bucket: "eval-bucket" },
    request: "Find the largest files in a Backblaze B2 bucket.",
    result: b2BadAuthTokenError,
  }),
  evalToolCase({
    name: "unfinished uploads analytics",
    category: "custom-analytics",
    toolName: "b2_unfinished_uploads",
    args: { bucket: "eval-bucket" },
    request: "Find unfinished large file uploads in a Backblaze B2 bucket.",
    result: b2BadAuthTokenError,
  }),
];

export const S3_DATA_PLANE_EVAL_CASES: readonly EvalCase[] = [
  evalToolCase({
    name: "abort multipart upload",
    category: "s3-data-plane",
    toolName: "s3_abort_multipart_upload",
    args: {
      bucket: "eval-bucket",
      key: "large.bin",
      uploadId: "eval-upload-id",
      confirm: true,
    },
    request: "Abort an in-progress S3-compatible multipart upload.",
    result: s3InvalidAccessKeyError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "complete multipart upload",
    category: "s3-data-plane",
    toolName: "s3_complete_multipart_upload",
    args: {
      bucket: "eval-bucket",
      key: "large.bin",
      uploadId: "eval-upload-id",
      parts: [{ partNumber: 1, etag: '"eval-etag-1"' }],
    },
    request: "Complete an S3-compatible multipart upload.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "copy object",
    category: "s3-data-plane",
    toolName: "s3_copy_object",
    args: {
      sourceBucket: "eval-source-bucket",
      sourceKey: "source.txt",
      destinationBucket: "eval-destination-bucket",
      destinationKey: "copied/source.txt",
    },
    request: "Copy an object between two Backblaze B2 S3-compatible buckets.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "create multipart upload",
    category: "s3-data-plane",
    toolName: "s3_create_multipart_upload",
    args: { bucket: "eval-bucket", key: "large.bin" },
    request: "Initiate an S3-compatible multipart upload.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "delete object",
    category: "s3-data-plane",
    toolName: "s3_delete_object",
    args: { bucket: "eval-bucket", key: "obsolete.txt", confirm: true },
    request: "Delete one object from a Backblaze B2 S3-compatible bucket.",
    result: s3InvalidAccessKeyError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "delete multiple objects",
    category: "s3-data-plane",
    toolName: "s3_delete_objects",
    args: {
      bucket: "eval-bucket",
      objects: [{ key: "obsolete-a.txt" }, { key: "obsolete-b.txt" }],
      confirm: true,
    },
    request: "Delete multiple objects from a Backblaze B2 S3-compatible bucket.",
    result: {
      kind: "structured-json",
      structuredFields: { attempted: 2, aborted: false, maxConcurrency: 2 },
      textIncludes: [
        '"Key":"obsolete-a.txt"',
        '"Key":"obsolete-b.txt"',
        '"Code":"InvalidAccessKeyId"',
        '"Message":"Malformed Access Key Id"',
      ],
    },
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "get bucket location",
    category: "s3-data-plane",
    toolName: "s3_get_bucket_location",
    args: { bucket: "eval-bucket" },
    request: "Get the S3-compatible location constraint for a Backblaze B2 bucket.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "get object",
    category: "s3-data-plane",
    toolName: "s3_get_object",
    args: { bucket: "eval-bucket", key: "manifest.json" },
    request: "Read a small object from a Backblaze B2 S3-compatible bucket.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "get put-object presigned url",
    category: "s3-data-plane",
    toolName: "s3_get_presigned_url",
    args: {
      bucket: "eval-bucket",
      key: "upload-target.txt",
      operation: "PutObject",
      expiresIn: 900,
      contentType: "text/plain",
      confirm: true,
    },
    request: "Generate a PutObject presigned URL for a Backblaze B2 object.",
    result: {
      kind: "structured-json",
      structuredFields: { operation: "PutObject", expiresIn: 900 },
    },
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "head bucket",
    category: "s3-data-plane",
    toolName: "s3_head_bucket",
    args: { bucket: "eval-bucket" },
    request: "Check S3-compatible reachability for a Backblaze B2 bucket.",
    result: s3UnknownForbiddenError,
  }),
  evalToolCase({
    name: "head object",
    category: "s3-data-plane",
    toolName: "s3_head_object",
    args: { bucket: "eval-bucket", key: "manifest.json" },
    request: "Read metadata for a Backblaze B2 S3-compatible object.",
    result: s3UnknownForbiddenError,
  }),
  evalToolCase({
    name: "list multipart uploads",
    category: "s3-data-plane",
    toolName: "s3_list_multipart_uploads",
    args: { bucket: "eval-bucket" },
    request: "List in-progress S3-compatible multipart uploads for a bucket.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "list object versions",
    category: "s3-data-plane",
    toolName: "s3_list_object_versions",
    args: { bucket: "eval-bucket" },
    request: "List S3-compatible object versions for a Backblaze B2 bucket.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "list objects v2",
    category: "s3-data-plane",
    toolName: "s3_list_objects_v2",
    args: { bucket: "eval-bucket" },
    request: "List objects in a Backblaze B2 bucket through the S3-compatible API.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "list multipart upload parts",
    category: "s3-data-plane",
    toolName: "s3_list_parts",
    args: { bucket: "eval-bucket", key: "large.bin", uploadId: "eval-upload-id" },
    request: "List uploaded parts for an S3-compatible multipart upload.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "presign upload parts",
    category: "s3-data-plane",
    toolName: "s3_get_presigned_upload_part_url",
    args: {
      bucket: "eval-bucket",
      key: "large.bin",
      uploadId: "eval-upload-id",
      partNumbers: [1, 2],
      expiresIn: 900,
    },
    request: "Generate presigned upload URLs for two multipart upload parts.",
    result: {
      kind: "structured-json",
      structuredFields: { bucket: "eval-bucket", key: "large.bin", expiresIn: 900 },
    },
  }),
  evalToolCase({
    name: "put bucket lifecycle expiration",
    category: "s3-data-plane",
    toolName: "s3_put_bucket_lifecycle",
    args: {
      bucket: "eval-bucket",
      rules: [
        {
          id: "expire-temp",
          status: "Enabled",
          filter: { prefix: "tmp/" },
          expiration: { days: 30 },
        },
      ],
      confirm: true,
    },
    request: "Set a bucket lifecycle rule that expires temporary objects.",
    result: s3InvalidAccessKeyError,
    server: destructiveEvalServer,
  }),
  evalToolCase({
    name: "put object inline",
    category: "s3-data-plane",
    toolName: "s3_put_object",
    args: {
      bucket: "eval-bucket",
      key: "manifest.json",
      content: "eyJldmFsIjp0cnVlfQ==",
      contentType: "application/json",
    },
    request: "Upload a small inline JSON object through the S3-compatible API.",
    result: s3InvalidAccessKeyError,
  }),
  evalToolCase({
    name: "upload part copy",
    category: "s3-data-plane",
    toolName: "s3_upload_part_copy",
    args: {
      bucket: "eval-bucket",
      key: "assembled.bin",
      uploadId: "eval-upload-id",
      partNumber: 1,
      copySource: "eval-source-bucket/source.bin",
    },
    request: "Copy an existing object range into a multipart upload part.",
    result: s3InvalidAccessKeyError,
  }),
];

export const CI_PROVIDER_COMPARISON_EVAL_CASES: readonly EvalCase[] = [
  evalToolCase({
    name: "blocked delete bucket",
    category: "native-control-plane",
    toolName: "b2_delete_bucket",
    args: { bucketId: "eval-bucket-id", confirm: true },
    request: "Delete the Backblaze B2 bucket identified by eval-bucket-id.",
    result: destructivePolicyBlockedError,
  }),
  evalToolCase({
    name: "blocked empty bucket notification rules",
    category: "native-control-plane",
    toolName: "b2_set_bucket_notification_rules",
    args: { bucketId: "eval-bucket-id", eventNotificationRules: [], confirm: true },
    request: "Replace a bucket's event notification rules with an empty rule set.",
    result: destructivePolicyBlockedError,
  }),
  evalToolCase({
    name: "application key compatibility stub without secret sink",
    category: "native-control-plane",
    toolName: "b2_create_key",
    args: { confirm: true },
    request: "Create a Backblaze B2 application key.",
    result: unavailableStubError,
  }),
  evalToolCase({
    name: "blocked delete object",
    category: "s3-data-plane",
    toolName: "s3_delete_object",
    args: { bucket: "eval-bucket", key: "obsolete.txt", confirm: true },
    request: "Delete one object from a Backblaze B2 S3-compatible bucket.",
    result: destructivePolicyBlockedError,
  }),
  evalToolCase({
    name: "blocked put-object presigned url",
    category: "s3-data-plane",
    toolName: "s3_get_presigned_url",
    args: {
      bucket: "eval-bucket",
      key: "upload-target.txt",
      operation: "PutObject",
      expiresIn: 900,
      contentType: "text/plain",
      confirm: true,
    },
    request: "Generate a PutObject presigned URL for a Backblaze B2 object.",
    result: destructivePolicyBlockedError,
  }),
];

export const FULL_PROFILE_EVAL_CASES: readonly EvalCase[] = [
  ...NATIVE_CONTROL_PLANE_EVAL_CASES,
  ...PARTNER_GROUPS_EVAL_CASES,
  ...CUSTOM_ANALYTICS_EVAL_CASES,
  ...S3_DATA_PLANE_EVAL_CASES,
];
