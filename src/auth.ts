import axios from "axios";
import { B2AuthResponse, B2Config } from "./utils/types.js";
import { withRetry } from "./utils/retry.js";
import { buildUserAgent } from "./utils/user-agent.js";
import { currentMcpRequestSignal } from "./request-context.js";

/** Timeout for the authorize_account request. */
const AUTH_TIMEOUT_MS = 30_000;

// v4 is Backblaze's current authorize_account (April 2025). A v4 token is accepted
// at the v2 and v3 endpoint paths the tools use (verified live: a v4 token succeeds
// on b2api/v2 and b2api/v3 calls), so this covers the B2 native API plus the Partner
// (Groups) and Backup APIs. v2 must NOT be used — Partner/Backup endpoints reject v2
// tokens. v4 also restructured the `allowed` field for Multi-Bucket Application Keys
// (`allowed.buckets[]` instead of a single bucketId/bucketName); we only consume
// `apiInfo.storageApi`, which is unchanged from v3, so that restructure is transparent.
const AUTH_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

interface B2AuthorizeResponse {
  accountId: string;
  authorizationToken: string;
  apiInfo: {
    storageApi: {
      apiUrl: string;
      downloadUrl: string;
      s3ApiUrl: string;
      recommendedPartSize: number;
      absoluteMinimumPartSize: number;
      // v4: the key's capabilities live at apiInfo.storageApi.allowed.capabilities
      // (verified against the b2_authorize_account v4 response spec).
      allowed?: { capabilities?: string[] };
    };
  };
}
// Token lifetime is 24h but we refresh after 23h to be safe
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

/**
 * B2AuthManager handles account authorization and caches the token
 * to avoid redundant authorize_account calls. If a request fails
 * with 401, call invalidate() and the next call to getAuth() will
 * re-authorize automatically.
 */
export class B2AuthManager {
  private config: B2Config;
  private cachedAuth: B2AuthResponse | null = null;
  private authTime: number | null = null;
  private inflightAuth: Promise<B2AuthResponse> | null = null;

  constructor(config: B2Config) {
    this.config = config;
  }

  /**
   * Return cached auth or re-authorize. Thread-safe — multiple concurrent
   * callers will share a single in-flight authorize call.
   */
  async getAuth(): Promise<B2AuthResponse> {
    if (this.isValid()) {
      return this.cachedAuth!;
    }

    if (this.inflightAuth) {
      return this.inflightAuth;
    }

    this.inflightAuth = this.authorize().finally(() => {
      this.inflightAuth = null;
    });

    return this.inflightAuth;
  }

  /**
   * Invalidate the cached token. Subsequent getAuth() calls will re-authorize.
   */
  invalidate(): void {
    this.cachedAuth = null;
    this.authTime = null;
  }

  /**
   * Force a fresh authorization and return the result.
   * Useful for testing credentials or initial setup.
   */
  async forceRefresh(): Promise<B2AuthResponse> {
    this.invalidate();
    return this.getAuth();
  }

  private isValid(): boolean {
    if (!this.cachedAuth || this.authTime === null) return false;
    return Date.now() - this.authTime < TOKEN_TTL_MS;
  }

  private async authorize(): Promise<B2AuthResponse> {
    const credentials = Buffer.from(
      `${this.config.applicationKeyId}:${this.config.applicationKey}`,
    ).toString("base64");

    const response = await withRetry(() =>
      axios.get<B2AuthorizeResponse>(AUTH_URL, {
        headers: {
          Authorization: `Basic ${credentials}`,
          "User-Agent": buildUserAgent(this.config),
        },
        timeout: AUTH_TIMEOUT_MS,
        signal: currentMcpRequestSignal(),
      }),
    );

    const data = response.data;
    this.cachedAuth = {
      accountId: data.accountId,
      authorizationToken: data.authorizationToken,
      apiUrl: data.apiInfo.storageApi.apiUrl,
      downloadUrl: data.apiInfo.storageApi.downloadUrl,
      s3ApiUrl: data.apiInfo.storageApi.s3ApiUrl,
      recommendedPartSize: data.apiInfo.storageApi.recommendedPartSize,
      absoluteMinimumPartSize: data.apiInfo.storageApi.absoluteMinimumPartSize,
      capabilities: data.apiInfo.storageApi.allowed?.capabilities ?? [],
    };
    this.authTime = Date.now();
    return this.cachedAuth;
  }
}
