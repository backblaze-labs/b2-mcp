/**
 * Tests for decodeBinaryErrorBody — the download path requests an arraybuffer,
 * so error bodies arrive as raw bytes; this decodes them in place so the real
 * B2 code/message surface instead of "unknown_error".
 */

import { decodeBinaryErrorBody } from "../../src/b2/client";
import { parseB2Error } from "../../src/utils/errors";

describe("decodeBinaryErrorBody", () => {
  it("decodes a Buffer error body into the parsed B2 error JSON", () => {
    const body = Buffer.from(
      JSON.stringify({ status: 404, code: "not_found", message: "file not present" }),
    );
    const err = { response: { status: 404, data: body } };
    decodeBinaryErrorBody(err);
    // parseB2Error can now read the real code/message.
    const parsed = parseB2Error(err);
    expect(parsed.status).toBe(404);
    expect(parsed.code).toBe("not_found");
    expect(parsed.message).toBe("file not present");
  });

  it("decodes an ArrayBuffer error body", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ code: "bad_request", message: "bad" }));
    const err = { response: { status: 400, data: bytes.buffer } };
    decodeBinaryErrorBody(err);
    expect(parseB2Error(err).code).toBe("bad_request");
  });

  it("leaves a non-JSON binary body untouched (no throw)", () => {
    const err = { response: { status: 500, data: Buffer.from([0x00, 0x01, 0x02]) } };
    expect(() => decodeBinaryErrorBody(err)).not.toThrow();
  });

  it("is a no-op for non-binary / non-error shapes", () => {
    const plain = { response: { status: 400, data: { code: "already_object" } } };
    decodeBinaryErrorBody(plain);
    expect(parseB2Error(plain).code).toBe("already_object");
    expect(() => decodeBinaryErrorBody(new Error("x"))).not.toThrow();
  });
});
