import {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketAclCommand,
  PutBucketAclCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolJson, toolError, toolSuccess } from "../utils/errors.js";

export function registerS3BucketTools(server: McpServer, s3: S3Client): void {

  server.tool(
    "s3_list_buckets",
    "List all B2 buckets via the S3-compatible API. Returns bucket names and creation dates.",
    {},
    async () => {
      try {
        const result = await s3.send(new ListBucketsCommand({}));
        return toolJson({ buckets: result.Buckets ?? [], owner: result.Owner });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_create_bucket",
    "Create a new B2 bucket via the S3-compatible API.",
    {
      bucket: z.string().describe("The bucket name to create."),
      acl: z.enum(["private", "public-read"]).optional().describe("Canned ACL. 'private' (default) or 'public-read'."),
    },
    async (args) => {
      try {
        const cmd = new CreateBucketCommand({
          Bucket: args.bucket,
          ACL: args.acl,
        });
        const result = await s3.send(cmd);
        return toolJson({ location: result.Location });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_delete_bucket",
    "Delete an empty B2 bucket via the S3-compatible API.",
    {
      bucket: z.string().describe("The bucket name to delete."),
    },
    async (args) => {
      try {
        await s3.send(new DeleteBucketCommand({ Bucket: args.bucket }));
        return toolSuccess(`Bucket '${args.bucket}' deleted successfully.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_head_bucket",
    "Check whether a B2 bucket exists and is accessible with the current credentials.",
    {
      bucket: z.string().describe("The bucket name to check."),
    },
    async (args) => {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: args.bucket }));
        return toolSuccess(`Bucket '${args.bucket}' exists and is accessible.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_get_bucket_versioning",
    "Get the versioning state of a B2 bucket (Enabled, Suspended, or not configured).",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketVersioningCommand({ Bucket: args.bucket }));
        return toolJson({ status: result.Status ?? "NotConfigured", mfaDelete: result.MFADelete });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_put_bucket_versioning",
    "Enable or suspend versioning on a B2 bucket.",
    {
      bucket: z.string().describe("The bucket name."),
      status: z.enum(["Enabled", "Suspended"]).describe("The versioning status to set."),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketVersioningCommand({
          Bucket: args.bucket,
          VersioningConfiguration: { Status: args.status },
        }));
        return toolSuccess(`Versioning set to '${args.status}' for bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_get_bucket_cors",
    "Get the CORS configuration for a B2 bucket.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketCorsCommand({ Bucket: args.bucket }));
        return toolJson({ corsRules: result.CORSRules ?? [] });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_put_bucket_cors",
    "Set the CORS configuration for a B2 bucket, allowing browser-based cross-origin requests.",
    {
      bucket: z.string().describe("The bucket name."),
      corsRules: z.array(z.object({
        allowedHeaders: z.array(z.string()).optional(),
        allowedMethods: z.array(z.string()).describe("HTTP methods, e.g. ['GET', 'PUT']."),
        allowedOrigins: z.array(z.string()).describe("Allowed origins, e.g. ['https://example.com'] or ['*']."),
        exposeHeaders: z.array(z.string()).optional(),
        maxAgeSeconds: z.number().optional(),
      })).describe("Array of CORS rules."),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketCorsCommand({
          Bucket: args.bucket,
          CORSConfiguration: {
            CORSRules: args.corsRules.map(r => ({
              AllowedHeaders: r.allowedHeaders,
              AllowedMethods: r.allowedMethods,
              AllowedOrigins: r.allowedOrigins,
              ExposeHeaders: r.exposeHeaders,
              MaxAgeSeconds: r.maxAgeSeconds,
            })),
          },
        }));
        return toolSuccess(`CORS rules updated for bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_delete_bucket_cors",
    "Remove all CORS rules from a B2 bucket.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        await s3.send(new DeleteBucketCorsCommand({ Bucket: args.bucket }));
        return toolSuccess(`CORS rules removed from bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_get_bucket_lifecycle",
    "Get the lifecycle configuration for a B2 bucket.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: args.bucket }));
        return toolJson({ rules: result.Rules ?? [] });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_put_bucket_lifecycle",
    "Set lifecycle rules for a B2 bucket via the S3-compatible API. Supported actions: object expiration (Expiration), noncurrent version expiration (NoncurrentVersionExpiration), and aborting incomplete multipart uploads (AbortIncompleteMultipartUpload). Note: Transition and NoncurrentVersionTransition rules (moving objects to different storage classes) are NOT supported by Backblaze B2.",
    {
      bucket: z.string().describe("The bucket name."),
      rules: z.array(z.object({
        id: z.string().describe("A unique identifier for the rule."),
        status: z.enum(["Enabled", "Disabled"]),
        filter: z.object({
          prefix: z.string().optional().describe("Only apply to objects with this prefix."),
        }).optional(),
        expiration: z.object({
          days: z.number().int().optional().describe("Number of days after creation to expire the object."),
          expiredObjectDeleteMarker: z.boolean().optional(),
        }).optional(),
        noncurrentVersionExpiration: z.object({
          noncurrentDays: z.number().int().describe("Days after becoming noncurrent to expire the version."),
        }).optional(),
        abortIncompleteMultipartUpload: z.object({
          daysAfterInitiation: z.number().int().describe("Cancel incomplete multipart uploads after this many days."),
        }).optional(),
      })),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketLifecycleConfigurationCommand({
          Bucket: args.bucket,
          LifecycleConfiguration: {
            Rules: args.rules.map(r => ({
              ID: r.id,
              Status: r.status,
              Filter: r.filter ? { Prefix: r.filter.prefix ?? "" } : { Prefix: "" },
              Expiration: r.expiration ? {
                Days: r.expiration.days,
                ExpiredObjectDeleteMarker: r.expiration.expiredObjectDeleteMarker,
              } : undefined,
              NoncurrentVersionExpiration: r.noncurrentVersionExpiration ? {
                NoncurrentDays: r.noncurrentVersionExpiration.noncurrentDays,
              } : undefined,
              AbortIncompleteMultipartUpload: r.abortIncompleteMultipartUpload ? {
                DaysAfterInitiation: r.abortIncompleteMultipartUpload.daysAfterInitiation,
              } : undefined,
            })),
          },
        }));
        return toolSuccess(`Lifecycle rules updated for bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_get_bucket_acl",
    "Get the access control list (ACL) for a B2 bucket.",
    {
      bucket: z.string().describe("The bucket name."),
    },
    async (args) => {
      try {
        const result = await s3.send(new GetBucketAclCommand({ Bucket: args.bucket }));
        return toolJson({ owner: result.Owner, grants: result.Grants ?? [] });
      } catch (err) { return toolError(err); }
    }
  );

  server.tool(
    "s3_put_bucket_acl",
    "Set the canned ACL for a B2 bucket via the S3-compatible API. B2 supports only 'private' and 'public-read' ACLs. All objects in the bucket inherit this ACL.",
    {
      bucket: z.string().describe("The bucket name."),
      acl: z.enum(["private", "public-read"])
        .describe("The canned ACL to apply. B2 only supports 'private' and 'public-read'."),
    },
    async (args) => {
      try {
        await s3.send(new PutBucketAclCommand({ Bucket: args.bucket, ACL: args.acl }));
        return toolSuccess(`ACL '${args.acl}' applied to bucket '${args.bucket}'.`);
      } catch (err) { return toolError(err); }
    }
  );
}
