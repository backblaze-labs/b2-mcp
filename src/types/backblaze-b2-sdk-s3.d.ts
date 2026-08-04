declare module "@backblaze-labs/b2-sdk/s3" {
  import type { AccountInfo } from "@backblaze-labs/b2-sdk";

  export interface B2S3Config {
    readonly accountInfo: AccountInfo;
    readonly applicationKeyId: string;
    readonly applicationKey: string;
    readonly region?: string;
  }

  export interface S3ClientConfig {
    readonly endpoint: string;
    readonly region: string;
    readonly credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    };
    readonly forcePathStyle: boolean;
  }

  export function createS3ClientConfig(config: B2S3Config): S3ClientConfig;
}

declare module "@backblaze-labs/b2-sdk/simulator" {
  import type { HttpTransport } from "@backblaze-labs/b2-sdk";

  export interface FaultSpec {
    readonly on: string;
    readonly status?: number;
    readonly code?: string;
    readonly message?: string;
    readonly count?: number;
    readonly skip?: number;
    readonly retryAfter?: number;
  }

  export interface FaultHandle {
    clear(): void;
  }

  export interface B2SimulatorOptions {
    minimumPartSize?: number;
    recommendedPartSize?: number;
    strictAuth?: boolean;
    authTokenTtlMs?: number;
  }

  export class B2Simulator {
    constructor(options?: B2SimulatorOptions);
    transport(): HttpTransport;
    advanceTime(ms: number): void;
    injectFailure(spec: FaultSpec): FaultHandle;
  }
}
