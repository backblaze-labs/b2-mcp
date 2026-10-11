// enc.sse_b2 (yes). Run by ../run-conformance; see ../../README.md.
//
// SSE-B2 through the two inputs the card names: `serverSideEncryption: "AES256"` on s3_put_object, and
// the bucket's default mode `SSE-B2` (`defaultServerSideEncryption` on b2_create_bucket and
// b2_update_bucket). What B2 documents: an object stored with the AES256 header "is encrypted with
// SSE-B2" and the answer carries `x-amz-server-side-encryption: AES256`; a bucket with default
// encryption on encrypts what is uploaded into it, or copied into it, from then on, and not the files
// that were already there; encryption is transparent to a reader. The effect asserted is the one a
// caller sees on the stored object: the `serverSideEncryption` s3_head_object reports.
// https://www.backblaze.com/apidocs/s3-put-object https://www.backblaze.com/apidocs/s3-copy-object
// https://www.backblaze.com/docs/cloud-storage-server-side-encryption
// https://www.backblaze.com/apidocs/b2-update-bucket
import { bucketInfo, check, eq, payload, put, readBytes, runScenario } from "../lib/session.mjs";

await runScenario("enc.sse_b2", async (s) => {
  const encryptionOf = async (bucket, key) =>
    (await s.call("s3_head_object", { bucket: bucket.name, key })).serverSideEncryption;
  const putEncrypted = (bucket, key, bytes) =>
    s.call("s3_put_object", {
      bucket: bucket.name,
      key,
      content: bytes.toString("base64"),
      contentType: "application/octet-stream",
      serverSideEncryption: "AES256",
    });

  s.step("bucket with no default encryption");
  const bucket = await s.bucket();
  eq(
    "default mode of a plain bucket",
    null,
    (await bucketInfo(s, bucket)).defaultServerSideEncryption.mode,
  );

  s.step("a plain upload is not reported as encrypted");
  const plain = payload(2048, 80);
  await put(s, bucket, "st/enc/plain.bin", plain);
  eq("encryption of a plain upload", undefined, await encryptionOf(bucket, "st/enc/plain.bin"));

  s.step("an upload with serverSideEncryption AES256 is encrypted");
  const secret = payload(4096, 81);
  await putEncrypted(bucket, "st/enc/aes256.bin", secret);
  eq("encryption of the AES256 upload", "AES256", await encryptionOf(bucket, "st/enc/aes256.bin"));

  s.step("the encrypted object reads back as the bytes uploaded");
  const read = await readBytes(s, bucket, "st/enc/aes256.bin");
  check(read.bytes.equals(secret), "the encrypted object's bytes differ from what was uploaded");
  eq("size of the encrypted object", secret.length, read.contentLength);

  s.step("bucket default SSE-B2 at creation");
  const born = await s.bucket({
    defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
  });
  const info = (await bucketInfo(s, born)).defaultServerSideEncryption;
  eq("default mode listed after create", ["SSE-B2", "AES256"], [info.mode, info.algorithm]);
  await put(s, born, "st/enc/default.bin", plain);
  eq(
    "a plain upload into a default-encrypted bucket",
    "AES256",
    await encryptionOf(born, "st/enc/default.bin"),
  );

  s.step("turning the default on later covers new files only");
  const later = await s.bucket();
  await put(s, later, "st/enc/before.bin", plain);
  await s.call("b2_update_bucket", {
    bucketId: later.id,
    defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
  });
  const turned = (await bucketInfo(s, later)).defaultServerSideEncryption;
  eq("default mode listed after update", ["SSE-B2", "AES256"], [turned.mode, turned.algorithm]);
  await put(s, later, "st/enc/after.bin", plain);
  eq(
    "an upload after the default was turned on",
    "AES256",
    await encryptionOf(later, "st/enc/after.bin"),
  );
  eq(
    "an upload from before the default",
    undefined,
    await encryptionOf(later, "st/enc/before.bin"),
  );

  s.step("an object copied into a default-encrypted bucket is encrypted");
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: "st/enc/plain.bin",
    destinationBucket: born.name,
    destinationKey: "st/enc/copied.bin",
  });
  eq("encryption of the copy", "AES256", await encryptionOf(born, "st/enc/copied.bin"));
  const copied = await readBytes(s, born, "st/enc/copied.bin");
  check(copied.bytes.equals(plain), "the copy's bytes differ from the source's");
});
