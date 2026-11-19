import { registerS3MultipartTools } from "../../src/s3/multipart";
import { parseErrorText } from "../../src/utils/errors";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  testConfig,
} from "../support/deterministic-fakes";

const copy = {
  bucket: "destination",
  key: "assembled.bin",
  uploadId: "upload-1",
  partNumber: 1,
  copySource: "source/file.bin",
};

describe("multipart registration compatibility", () => {
  it("accepts the original three arguments and honors the supplied destructive policy", async () => {
    const s3 = new DeterministicS3ClientFake();
    s3.allowDefault("abortMultipartUpload", "uploadPartCopy");
    const tools = new ToolHarness();
    registerS3MultipartTools(tools, s3.asPeerClient(), {
      ...testConfig,
      destructivePolicy: "block",
    });

    const blocked = await tools.call("s3_abort_multipart_upload", { ...copy, confirm: true });
    expect(blocked.isError).toBe(true);
    expect(parseErrorText(parseResult(blocked) as string)).toMatchObject({
      status: 403,
      code: "destructive_policy_blocked",
    });
    expect(s3.requestsFor("abortMultipartUpload")).toHaveLength(0);

    const copied = await tools.call("s3_upload_part_copy", copy);
    expect(copied.isError).toBeFalsy();
    expect(s3.requestsFor("uploadPartCopy")).toHaveLength(1);
  });

  it("rejects an empty source version even without a configured resolver", async () => {
    const s3 = new DeterministicS3ClientFake();
    s3.allowDefault("uploadPartCopy");
    const tools = new ToolHarness();
    registerS3MultipartTools(tools, s3.asPeerClient(), testConfig);

    const result = await tools.call("s3_upload_part_copy", { ...copy, copySourceVersionId: "" });
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(s3.requestsFor("uploadPartCopy")).toHaveLength(0);
  });

  it.each([
    { copySourceVersionId: "version-1" },
    { copySource: "source/file.bin?versionId=version-1" },
  ])("refuses a versioned copy without a resolver before issuing a copy: %s", async (version) => {
    const s3 = new DeterministicS3ClientFake();
    s3.allowDefault("uploadPartCopy");
    const tools = new ToolHarness();
    registerS3MultipartTools(tools, s3.asPeerClient(), testConfig);

    const result = await tools.call("s3_upload_part_copy", {
      ...copy,
      ...version,
    });
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 503,
      code: "version_binding_unavailable",
    });
    expect(s3.requestsFor("uploadPartCopy")).toHaveLength(0);
  });
});
