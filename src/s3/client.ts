import {
  S3Client,
  type S3ClientConfig,
  type S3ClientResolvedConfig,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import type { Command, HttpHandlerOptions } from "@smithy/types";
import { B2Config } from "../utils/types.js";
import { VERSION } from "../version.js";
import { currentMcpRequestSignal } from "../request-context.js";

type S3SendCommand<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
> = Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, S3ClientResolvedConfig>;

type S3SendCallback<OutputType extends ServiceOutputTypes> = (
  err: unknown,
  data?: OutputType,
) => void;

class RequestAbortS3Client extends S3Client {
  private optionsWithRequestSignal(options?: HttpHandlerOptions): HttpHandlerOptions | undefined {
    const signal = currentMcpRequestSignal();
    if (!signal) return options;
    if (options?.abortSignal !== undefined) return options;
    return { ...(options ?? {}), abortSignal: signal };
  }

  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    options?: HttpHandlerOptions,
  ): Promise<OutputType>;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    cb: S3SendCallback<OutputType>,
  ): void;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    options: HttpHandlerOptions,
    cb: S3SendCallback<OutputType>,
  ): void;
  override send<InputType extends ServiceInputTypes, OutputType extends ServiceOutputTypes>(
    command: S3SendCommand<InputType, OutputType>,
    optionsOrCb?: HttpHandlerOptions | S3SendCallback<OutputType>,
    cb?: S3SendCallback<OutputType>,
  ): Promise<OutputType> | void {
    if (typeof optionsOrCb === "function") {
      const options = this.optionsWithRequestSignal();
      if (options) return super.send(command, options, optionsOrCb);
      return super.send(command, optionsOrCb);
    }
    const options = this.optionsWithRequestSignal(optionsOrCb);
    if (cb) return super.send(command, options ?? {}, cb);
    return super.send(command, options);
  }
}

/**
 * Create an AWS SDK S3Client configured to point at the B2 S3-compatible endpoint.
 */
export function createS3Client(config: B2Config): S3Client {
  const endpoint = `https://s3.${config.region}.backblazeb2.com`;

  const s3Config: S3ClientConfig = {
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.appKeyId,
      secretAccessKey: config.appKey,
    },
    forcePathStyle: true, // Required for B2 S3-compatible API
    // Attribute S3 traffic to the MCP in B2's server-side logs (appended to the
    // SDK User-Agent). The SDK signs requests, so this is the safe way to tag
    // them — never inject raw headers. No credentials/PII, only product+transport.
    customUserAgent: [
      ["backblaze-b2-mcp", VERSION],
      ["transport", config.transport ?? "stdio"],
    ],
  };

  return new RequestAbortS3Client(s3Config);
}
