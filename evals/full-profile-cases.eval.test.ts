import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CI_PROVIDER_COMPARISON_EVAL_CASES, FULL_PROFILE_EVAL_CASES, type EvalCase } from "./cases";
import type { Driver, DriverInput, DriverOutput, EvalRun } from "./harness";
import { B2S3PeerClient } from "../src/s3/aws-sdk-adapter";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../src/server";
import { resetCircuitBreakersForTests } from "../src/utils/circuit-breaker";
import type { B2Config } from "../src/utils/types";
import {
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../tests/support/sdk-test-helpers";
import { restoreB2SdkTransportForTests } from "../tests/support/sdk-factory-hook";
import { s3ServiceError } from "../tests/support/deterministic-fakes";

class ScriptedCaseDriver implements Driver {
  readonly name = "scripted-full-profile";
  private step = 0;

  constructor(private readonly evalCase: EvalCase) {}

  async complete(_input: DriverInput): Promise<DriverOutput> {
    if (this.step > 0) return { text: "Done." };
    this.step += 1;
    return {
      text: `Calling ${this.evalCase.expected.toolName}.`,
      toolCalls: [
        {
          name: this.evalCase.expected.toolName,
          args: { ...this.evalCase.expected.args },
        },
      ],
    };
  }
}

const evalConfig = {
  applicationKeyId: "eval-application-key-id",
  applicationKey: "eval-application-key-secret",
  appKeyId: "eval-app-key-id",
  appKey: "eval-app-key-secret",
  masterKeyId: "eval-master-key-id",
  masterKey: "eval-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
} satisfies B2Config;

function installDeterministicB2Boundary(): void {
  installSdkTransport(
    new RecordingTransport(
      () =>
        new StaticHttpResponse(
          401,
          {
            status: 401,
            code: "bad_auth_token",
            message: "eval marker credentials are rejected locally",
          },
          { "x-bz-request-id": "eval-native-request" },
        ),
    ),
  );
}

function installDeterministicS3Boundary(): void {
  const invalidAccessKey = () =>
    s3ServiceError("InvalidAccessKeyId", "Malformed Access Key Id", 403, "eval-s3-request");
  const unknownForbidden = () =>
    s3ServiceError("Unknown", "UnknownError", 403, "eval-s3-head-request");

  vi.spyOn(B2S3PeerClient.prototype, "headBucket").mockRejectedValue(unknownForbidden());
  vi.spyOn(B2S3PeerClient.prototype, "headObject").mockRejectedValue(unknownForbidden());
  vi.spyOn(B2S3PeerClient.prototype, "getBucketLocation").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "getBucketLifecycle").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "putObject").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "getObject").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "deleteObject").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "copyObject").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "listObjectsV2").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "listObjectVersions").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "putBucketLifecycle").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "createMultipartUpload").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "completeMultipartUpload").mockRejectedValue(
    invalidAccessKey(),
  );
  vi.spyOn(B2S3PeerClient.prototype, "abortMultipartUpload").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "listMultipartUploads").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "listParts").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "uploadPartCopy").mockRejectedValue(invalidAccessKey());
  vi.spyOn(B2S3PeerClient.prototype, "deleteObjects").mockImplementation(async (input) => ({
    deleted: [],
    errors: input.objects.map((object) => ({
      Key: object.key,
      VersionId: object.versionId,
      Code: "InvalidAccessKeyId",
      Message: "Malformed Access Key Id",
      RequestId: "eval-s3-request",
    })),
    attempted: input.objects.length,
    aborted: false,
    maxConcurrency: Math.min(8, input.objects.length),
  }));
  vi.spyOn(B2S3PeerClient.prototype, "presignObjectUrl").mockImplementation(async (input) => ({
    url: `https://s3.example.invalid/${encodeURIComponent(input.bucket)}/${encodeURIComponent(
      input.key,
    )}?operation=${input.operation}`,
    operation: input.operation,
    expiresIn: input.expiresIn,
    expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
  }));
  vi.spyOn(B2S3PeerClient.prototype, "presignUploadPart").mockImplementation(async (input) => ({
    partNumber: input.partNumber,
    url: `https://s3.example.invalid/${encodeURIComponent(input.bucket)}/${encodeURIComponent(
      input.key,
    )}?uploadId=${encodeURIComponent(input.uploadId)}&partNumber=${input.partNumber}`,
  }));
}

async function runScriptedCase(evalCase: EvalCase): Promise<EvalRun> {
  const server = createServer({
    ...evalConfig,
    destructivePolicy: evalCase.server?.destructivePolicy ?? "block",
  });
  try {
    const registry = getRegisteredTools(server);
    if (!registry) throw new Error("Expected test server to expose registered tools.");
    const toolCalls: EvalRun["toolCalls"] = [];
    const toolResults: EvalRun["toolResults"] = [];
    const textParts: string[] = [];
    const driver = new ScriptedCaseDriver(evalCase);

    for (let step = 0; step < evalCase.maxSteps; step += 1) {
      for (const name of evalCase.toolNames) {
        if (!registry[name]) throw new Error(`Requested eval tool is not registered: ${name}`);
      }
      const output = await driver.complete({
        prompt: evalCase.prompt,
        tools: [],
        messages: [],
        step,
        maxSteps: evalCase.maxSteps,
        signal: new AbortController().signal,
      });
      if (output.text) textParts.push(output.text);
      const calls = output.toolCalls ?? [];
      if (calls.length === 0) break;

      for (const call of calls) {
        const tool = registry[call.name];
        if (!tool || !evalCase.toolNames.includes(call.name)) {
          throw new Error(`Scripted driver requested unexposed tool: ${call.name}`);
        }
        const inputSchema = tool.inputSchema;
        if (!inputSchema) throw new Error(`Registered eval tool has no input schema: ${call.name}`);
        const parsedArgs = inputSchema.parse(call.args);
        toolCalls.push({ name: call.name, args: call.args });
        toolResults.push(await tool.execute(parsedArgs, {}));
      }
    }

    return { toolCalls, toolResults, text: textParts.join("\n") };
  } finally {
    await server.close();
  }
}

describe("full-profile scripted eval cases", () => {
  beforeEach(() => {
    invalidateAuthManagerCache();
    installDeterministicB2Boundary();
    installDeterministicS3Boundary();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreB2SdkTransportForTests();
    resetCircuitBreakersForTests();
    invalidateAuthManagerCache();
  });

  it.each(FULL_PROFILE_EVAL_CASES)(
    "$name accepts the scripted expected tool call with local fake SDK boundaries",
    async (evalCase) => {
      const run = await runScriptedCase(evalCase);

      expect(evalCase.passed(run), evalCase.failureSummary(run)).toBe(true);
    },
    30_000,
  );

  it.each(CI_PROVIDER_COMPARISON_EVAL_CASES)(
    "$name accepts the scripted no-B2 CI tool call",
    async (evalCase) => {
      const run = await runScriptedCase(evalCase);

      expect(evalCase.server?.destructivePolicy).not.toBe("allow");
      expect(evalCase.passed(run), evalCase.failureSummary(run)).toBe(true);
    },
    30_000,
  );
});
