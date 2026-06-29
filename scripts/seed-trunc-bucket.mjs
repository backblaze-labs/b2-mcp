// Preseed a bucket with 5,000 small objects so the live truncation test has a
// bucket big enough to trip max_scan. Idempotent: creates the bucket if missing
// and only uploads objects that aren't already there. Uses a regular (S3-capable)
// application key — the master key is rejected by the S3 endpoint.
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const region = process.env.B2_REGION ?? "us-west-004";
const bucket = process.env.B2_TRUNCATION_BUCKET ?? "mcp-trunc-5k";
const COUNT = Number(process.env.SEED_COUNT ?? 5000);
const PREFIX = "f/";
const CONCURRENCY = 64;

const keyId = process.env.B2_APPLICATION_KEY_ID;
const key = process.env.B2_APPLICATION_KEY;
if (!keyId || !key) {
  console.error("missing B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY (source .env.local)");
  process.exit(2);
}

const s3 = new S3Client({
  region,
  endpoint: `https://s3.${region}.backblazeb2.com`,
  credentials: { accessKeyId: keyId, secretAccessKey: key },
});

const pad = (n) => String(n).padStart(5, "0");

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`bucket "${bucket}" exists — reusing`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket "${bucket}"`);
  }
}

async function existingCount() {
  let token, n = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
    n += page.Contents?.length ?? 0;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return n;
}

async function seed() {
  await ensureBucket();
  const have = await existingCount();
  if (have >= COUNT) {
    console.log(`already has ${have} objects under ${PREFIX} — nothing to upload`);
    return;
  }
  console.log(`uploading ${COUNT - have} objects (have ${have}, target ${COUNT})…`);

  let next = have; // resume-ish: skip indices already covered by count
  let done = have;
  const worker = async () => {
    while (next < COUNT) {
      const i = next++;
      // Vary size 10–59 bytes so "largest" is meaningful; one clear max at i=0.
      const size = i === 0 ? 200 : 10 + (i % 50);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${PREFIX}${pad(i)}.txt`,
        Body: "x".repeat(size),
        ContentType: "text/plain",
      }));
      if (++done % 500 === 0) console.log(`  ${done}/${COUNT}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`upload complete: ${done} objects under ${PREFIX} in "${bucket}"`);
}

await seed();
console.log(`\nDONE. Truncation-test bucket: ${bucket}`);
