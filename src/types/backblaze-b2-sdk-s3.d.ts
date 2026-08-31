// Temporary TypeScript-resolution shim for @backblaze-labs/b2-sdk subpaths.
// The package ships declarations for ./s3 and ./simulator under dist/, but this
// repository still builds as CommonJS with classic package resolution, which
// does not follow the package "exports" map to those subpath .d.ts files. Issue
// #72 keeps this shim narrow and tests it against the installed SDK declarations
// so it cannot silently drift; remove it when the project moves to a module
// resolution mode that consumes the SDK's subpath declarations directly.
declare module "@backblaze-labs/b2-sdk/s3" {
  import type { AccountInfo } from "@backblaze-labs/b2-sdk";

  /** Configuration accepted by the B2 SDK S3 helper. */
  export interface B2S3Config {
    readonly accountInfo: AccountInfo;
    readonly applicationKeyId: string;
    readonly applicationKey: string;
    readonly region?: string;
  }

  /** AWS SDK S3 client configuration produced by the B2 SDK helper. */
  export interface S3ClientConfig {
    readonly endpoint: string;
    readonly region: string;
    readonly credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    };
    readonly forcePathStyle: boolean;
  }

  /** Common options for SDK-provided B2 S3 presigned object URLs. */
  export interface S3PresignObjectUrlOptions extends B2S3Config {
    readonly bucketName: string;
    readonly fileName: string;
    readonly expiresIn?: number;
  }

  /** Options for SDK-provided B2 S3 presigned GetObject URLs. */
  export interface PresignS3GetObjectUrlOptions extends S3PresignObjectUrlOptions {
    readonly versionId?: string;
  }

  /** Options for SDK-provided B2 S3 presigned PutObject URLs. */
  export interface PresignS3PutObjectUrlOptions extends S3PresignObjectUrlOptions {
    readonly contentType?: string;
    readonly contentLength?: number;
    readonly metadata?: Record<string, string>;
  }

  /**
   * Create AWS SDK S3 client configuration for a B2 account.
   *
   * @param config - B2 S3 helper configuration.
   *
   * @returns AWS SDK S3 client configuration.
   */
  export function createS3ClientConfig(config: B2S3Config): S3ClientConfig;
  /**
   * Create a B2 S3 presigned GetObject URL.
   *
   * @param options - GetObject presign options.
   *
   * @returns Presigned URL string.
   */
  export function presignS3GetObjectUrl(options: PresignS3GetObjectUrlOptions): Promise<string>;
  /**
   * Create a B2 S3 presigned PutObject URL.
   *
   * @param options - PutObject presign options.
   *
   * @returns Presigned URL string.
   */
  export function presignS3PutObjectUrl(options: PresignS3PutObjectUrlOptions): Promise<string>;
}

declare module "@backblaze-labs/b2-sdk/simulator" {
  import type { HttpTransport } from "@backblaze-labs/b2-sdk";

  /** Fault injected into the local B2 simulator transport. */
  export interface FaultSpec {
    readonly on: string;
    readonly status?: number;
    readonly code?: string;
    readonly message?: string;
    readonly count?: number;
    readonly skip?: number;
    readonly retryAfter?: number;
  }

  /** Handle returned for a simulator fault injection. */
  export interface FaultHandle {
    /** Clear the injected fault. */
    clear(): void;
  }

  /** Construction options for the local B2 simulator. */
  export interface B2SimulatorOptions {
    minimumPartSize?: number;
    recommendedPartSize?: number;
    strictAuth?: boolean;
    authTokenTtlMs?: number;
    partnerAuthorize?: boolean;
    partnerApiEnabled?: boolean;
    partnerAccountHasValidPhone?: boolean;
    partnerAccountInGoodStanding?: boolean;
  }

  /** Local B2 API simulator used by tests. */
  export class B2Simulator {
    /**
     * Create a simulator instance.
     *
     * @param options - Simulator behavior options.
     */
    constructor(options?: B2SimulatorOptions);
    /**
     * Return the simulator HTTP transport.
     *
     * @returns SDK HTTP transport backed by the simulator.
     */
    transport(): HttpTransport;
    /**
     * Advance simulator time.
     *
     * @param ms - Milliseconds to advance.
     */
    advanceTime(ms: number): void;
    /**
     * Inject a transport fault.
     *
     * @param spec - Fault behavior to inject.
     *
     * @returns Handle that clears the fault.
     */
    injectFailure(spec: FaultSpec): FaultHandle;
  }
}
