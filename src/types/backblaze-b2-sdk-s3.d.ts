// Temporary TypeScript-resolution shim for @backblaze-labs/b2-sdk@0.2.0.
// The package ships declarations for ./s3 and ./simulator under dist/, but this
// repository still builds as CommonJS with classic package resolution, which
// does not follow the package "exports" map to those subpath .d.ts files. Issue
// #72 keeps this shim narrow and tests it against the installed SDK declarations
// so it cannot silently drift; remove it when the project moves to a module
// resolution mode that consumes the SDK's subpath declarations directly.
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
